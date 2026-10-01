import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import BN from 'bn.js'
import {
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
  DynamicBondingCurveClient,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferHook,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { onlyClaimInstruction, quoteOnlyClaimLimits, validateSignedClaim, type ClaimShare } from './claim-tx.js'
import { analyzeStatic, DBC_PROGRAM_ID, isActiveHookProgram, type LaunchPlan, type TokenPlan } from './preflight.js'

const GENESIS_HASH: Record<'mainnet-beta' | 'devnet', string> = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
}
const U64_MAX = (1n << 64n) - 1n

interface Options {
  configPath: string
  rpcUrl: string
  tokenId: 'long' | 'short'
  share: ClaimShare
  runId: string
  maxQuoteRaw: bigint
  journalPath: string
  execute: boolean
  keypairPath: string | null
  minSolLamports: bigint
}

interface SignedTx {
  signature: string
  rawBase64: string
  blockhash: string
  lastValidBlockHeight: number
}

interface ClaimRecord {
  phase: 'signed' | 'done'
  cluster: string
  rpcUrl: string
  planFingerprint: string
  tokenId: 'long' | 'short'
  share: ClaimShare
  signer: string
  pool: string
  quoteMint: string
  quoteAta: string
  maxQuoteRaw: string
  tx: SignedTx
  actualQuoteDeltaRaw?: string
}

type ClaimJournal = Record<string, ClaimRecord>

function raw(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(label + ' must be an unsigned raw integer string')
  }
  const amount = BigInt(value)
  if (amount > U64_MAX) throw new Error(label + ' exceeds u64')
  return amount
}

function parseOptions(argv: string[]): Options {
  const parsed: Partial<Options> = {
    configPath: 'config.example.json',
    journalPath: 'claim-receipts.json',
    maxQuoteRaw: U64_MAX,
    execute: false,
    keypairPath: null,
    minSolLamports: 50_000_000n,
  }
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]
    if (option === '--execute') {
      parsed.execute = true
      continue
    }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(option + ' needs a value')
    if (option === '--config') parsed.configPath = value
    else if (option === '--rpc') parsed.rpcUrl = value
    else if (option === '--token' && (value === 'long' || value === 'short')) parsed.tokenId = value
    else if (option === '--share' && (value === 'partner' || value === 'creator')) parsed.share = value
    else if (option === '--run') parsed.runId = value
    else if (option === '--max-quote-raw') parsed.maxQuoteRaw = raw(value, option)
    else if (option === '--journal') parsed.journalPath = value
    else if (option === '--keypair') parsed.keypairPath = value
    else if (option === '--min-sol-lamports') parsed.minSolLamports = raw(value, option)
    else throw new Error('invalid option or value: ' + option + ' ' + value)
  }
  if (!parsed.rpcUrl || !/^https?:\/\//.test(parsed.rpcUrl)) throw new Error('--rpc needs an HTTP(S) URL')
  if (!parsed.tokenId) throw new Error('--token long|short is required')
  if (!parsed.share) throw new Error('--share partner|creator is required')
  if (!parsed.runId || !/^[a-zA-Z0-9._-]{1,100}$/.test(parsed.runId)) {
    throw new Error('--run needs a unique claim ID (letters, numbers, dot, underscore, hyphen)')
  }
  if (parsed.maxQuoteRaw === 0n) throw new Error('--max-quote-raw must be positive')
  if (parsed.execute && !parsed.keypairPath) throw new Error('--execute requires --keypair')
  if (!parsed.execute && parsed.keypairPath) throw new Error('--keypair requires --execute')
  return parsed as Options
}

function key(value: string | null, name: string): PublicKey {
  if (!value) throw new Error(name + ' is not configured yet')
  return new PublicKey(value)
}

function assertEquals(actual: PublicKey, expected: PublicKey, label: string): void {
  if (!actual.equals(expected)) throw new Error(label + ' differs from configured launch')
}

function encodeBase58(input: Buffer): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let number = BigInt('0x' + input.toString('hex'))
  let encoded = ''
  while (number > 0n) {
    encoded = alphabet[Number(number % 58n)] + encoded
    number /= 58n
  }
  for (const byte of input) {
    if (byte !== 0) break
    encoded = '1' + encoded
  }
  return encoded
}

function signedSignature(signed: SignedTx): string {
  const signature = Transaction.from(Buffer.from(signed.rawBase64, 'base64')).signature
  if (!signature || encodeBase58(signature) !== signed.signature) {
    throw new Error('claim journal signature differs from signed transaction')
  }
  return signed.signature
}

async function readJournal(path: string): Promise<ClaimJournal> {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8')) as ClaimJournal
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function saveJournal(path: string, journal: ClaimJournal): Promise<void> {
  const destination = resolve(path)
  const temporary = destination + '.tmp-' + process.pid
  await writeFile(temporary, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, destination)
}

async function loadKeypair(path: string): Promise<Keypair> {
  const rawBytes = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown
  if (!Array.isArray(rawBytes) || rawBytes.length !== 64 ||
      !rawBytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new Error('keypair file must be a Solana CLI 64-byte JSON array')
  }
  return Keypair.fromSecretKey(Uint8Array.from(rawBytes as number[]))
}

async function verifyGenesis(connection: Connection, cluster: string): Promise<void> {
  if (cluster !== 'mainnet-beta' && cluster !== 'devnet') throw new Error('config cluster is invalid')
  const actual = await connection.getGenesisHash()
  if (actual !== GENESIS_HASH[cluster]) {
    throw new Error('RPC genesis hash differs from config cluster ' + cluster)
  }
}

interface ClaimContext {
  pool: PublicKey
  baseMint: PublicKey
  quoteMint: PublicKey
  signer: PublicKey
  baseAta: PublicKey
  quoteAta: PublicKey
  availableRaw: bigint
}

async function verifyClaimContext(
  connection: Connection,
  dbc: DynamicBondingCurveClient,
  token: TokenPlan,
  share: ClaimShare,
  signer: PublicKey,
): Promise<ClaimContext> {
  const baseMint = key(token.baseMint, 'baseMint')
  const quoteMint = key(token.quoteMint, 'quoteMint')
  const config = key(token.configAddress, 'configAddress')
  const creator = key(token.creator, 'creator')
  const feeClaimer = key(token.feeClaimer, 'feeClaimer')
  const authority = share === 'partner' ? feeClaimer : creator
  if (!signer.equals(authority)) {
    throw new Error(share + ' claim requires the configured ' +
      (share === 'partner' ? 'feeClaimer' : 'creator') +
      ' signer; a PDA authority needs an on-chain strategy program')
  }
  const pool = deriveDbcPoolAddress(quoteMint, baseMint, config)
  const [configInfo, poolInfo, baseInfo, quoteInfo] = await Promise.all([
    connection.getAccountInfo(config, 'confirmed'),
    connection.getAccountInfo(pool, 'confirmed'),
    connection.getAccountInfo(baseMint, 'confirmed'),
    connection.getAccountInfo(quoteMint, 'confirmed'),
  ])
  if (!configInfo?.owner.equals(DBC_PROGRAM_ID)) throw new Error('hook config is missing or not DBC-owned')
  if (!poolInfo?.owner.equals(DBC_PROGRAM_ID)) throw new Error('hook pool is missing or not DBC-owned')
  if (!baseInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('base mint is not Token-2022')
  if (!quoteInfo?.owner.equals(TOKEN_PROGRAM_ID)) throw new Error('quote mint is not classic SPL')
  const hookConfig = await dbc.state.program.account.configWithTransferHook.fetchNullable(config)
  const hookPool = await dbc.state.program.account.transferHookPool.fetchNullable(pool)
  if (!hookConfig || !hookPool) throw new Error('expected ConfigWithTransferHook and TransferHookPool accounts')
  const state = hookConfig.config
  const poolState = hookPool.poolState
  assertEquals(poolState.config, config, 'pool config')
  assertEquals(poolState.baseMint, baseMint, 'pool base mint')
  assertEquals(poolState.creator, creator, 'pool creator')
  assertEquals(state.quoteMint, quoteMint, 'config quote mint')
  assertEquals(state.feeClaimer, feeClaimer, 'config fee claimer')
  assertEquals(hookConfig.transferHookProgram, key(token.hookProgramId, 'hookProgramId'), 'config hook')
  if (poolState.poolType !== 1 || state.tokenType !== 1 ||
      state.collectFeeMode !== 0 || state.migrationOption !== 1 ||
      state.quoteTokenFlag !== 0) {
    throw new Error('pool/config must be hooked Token-2022, quote-only, DAMM v2, legacy SPL quote')
  }
  if (state.tokenUpdateAuthority !== token.tokenAuthorityOption ||
      state.creatorTradingFeePercentage !== token.creatorTradingFeePercentage) {
    throw new Error('on-chain authority or creator fee share differs from config')
  }
  const [base, quote] = await Promise.all([
    getMint(connection, baseMint, 'confirmed', TOKEN_2022_PROGRAM_ID),
    getMint(connection, quoteMint, 'confirmed', TOKEN_PROGRAM_ID),
  ])
  if (base.decimals !== token.tokenDecimals || quote.decimals !== (token.quote === 'WSOL' ? 9 : 6)) {
    throw new Error('mint decimals differ from config')
  }
  const expectedMintAuthority = token.mintAuthorityPolicy === 'retained-partner'
    ? feeClaimer
    : token.mintAuthorityPolicy === 'retained-creator'
      ? creator
      : null
  if ((base.mintAuthority?.toBase58() ?? null) !== (expectedMintAuthority?.toBase58() ?? null)) {
    throw new Error('base mint authority differs from retained-authority policy')
  }
  const hook = getTransferHook(base)
  if (!hook) throw new Error('base mint lacks transfer-hook extension')
  if (poolState.migrationProgress === 0 &&
      (!isActiveHookProgram(hook.programId) ||
       !hook.programId?.equals(key(token.hookProgramId, 'hookProgramId')))) {
    throw new Error('pre-bonding base mint lacks the configured active hook')
  }
  const [baseVault, quoteVault] = await Promise.all([
    getAccount(connection, poolState.baseVault, 'confirmed', TOKEN_2022_PROGRAM_ID),
    getAccount(connection, poolState.quoteVault, 'confirmed', TOKEN_PROGRAM_ID),
  ])
  assertEquals(poolState.baseVault, deriveDbcTokenVaultAddress(pool, baseMint), 'base vault address')
  assertEquals(poolState.quoteVault, deriveDbcTokenVaultAddress(pool, quoteMint), 'quote vault address')
  assertEquals(baseVault.mint, baseMint, 'base vault mint')
  assertEquals(quoteVault.mint, quoteMint, 'quote vault mint')
  const poolAuthority = deriveDbcPoolAuthority()
  assertEquals(baseVault.owner, poolAuthority, 'base vault owner')
  assertEquals(quoteVault.owner, poolAuthority, 'quote vault owner')
  const baseAta = getAssociatedTokenAddressSync(baseMint, signer, false, TOKEN_2022_PROGRAM_ID)
  const quoteAta = getAssociatedTokenAddressSync(quoteMint, signer, false, TOKEN_PROGRAM_ID)
  const [baseAccount, quoteAccount] = await Promise.all([
    getAccount(connection, baseAta, 'confirmed', TOKEN_2022_PROGRAM_ID),
    getAccount(connection, quoteAta, 'confirmed', TOKEN_PROGRAM_ID),
  ])
  assertEquals(baseAccount.owner, signer, 'base ATA owner')
  assertEquals(baseAccount.mint, baseMint, 'base ATA mint')
  assertEquals(quoteAccount.owner, signer, 'quote ATA owner')
  assertEquals(quoteAccount.mint, quoteMint, 'quote ATA mint')
  const availableRaw = BigInt(
    (share === 'partner' ? poolState.partnerQuoteFee : poolState.creatorQuoteFee).toString(),
  )
  return { pool, baseMint, quoteMint, signer, baseAta, quoteAta, availableRaw }
}

async function signClaim(
  connection: Connection,
  instruction: ReturnType<typeof onlyClaimInstruction>,
  signer: Keypair,
  minimumSol: bigint,
): Promise<SignedTx> {
  const block = await connection.getLatestBlockhash('confirmed')
  const transaction = new Transaction().add(instruction)
  transaction.feePayer = signer.publicKey
  transaction.recentBlockhash = block.blockhash
  const estimatedFee = await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed')
  if (estimatedFee.value === null) throw new Error('RPC could not estimate transaction fee')
  const balance = BigInt(await connection.getBalance(signer.publicKey, 'confirmed'))
  if (balance - BigInt(estimatedFee.value) < minimumSol) {
    throw new Error('claim fee would breach the signer SOL gas reserve')
  }
  transaction.sign(signer)
  const signature = transaction.signature
  if (!signature) throw new Error('signed transaction lacks signature')
  return {
    signature: encodeBase58(signature),
    rawBase64: transaction.serialize().toString('base64'),
    blockhash: block.blockhash,
    lastValidBlockHeight: block.lastValidBlockHeight,
  }
}

async function confirmClaim(connection: Connection, signed: SignedTx): Promise<string> {
  const signature = signedSignature(signed)
  const previous = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]
  if (previous?.err) throw new Error('claim ' + signature + ' failed: ' + JSON.stringify(previous.err))
  if (previous?.confirmationStatus === 'confirmed' || previous?.confirmationStatus === 'finalized') return signature
  if (!previous && await connection.getBlockHeight('confirmed') > signed.lastValidBlockHeight) {
    throw new Error('claim ' + signature + ' expired without confirmed status; inspect chain before retry')
  }
  try {
    await connection.sendRawTransaction(Buffer.from(signed.rawBase64, 'base64'), {
      skipPreflight: false,
      maxRetries: 3,
    })
  } catch (error) {
    const again = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]
    if (!again || again.err) throw error
  }
  const confirmed = await connection.confirmTransaction({
    signature,
    blockhash: signed.blockhash,
    lastValidBlockHeight: signed.lastValidBlockHeight,
  }, 'confirmed')
  if (confirmed.value.err) throw new Error('claim ' + signature + ' failed: ' + JSON.stringify(confirmed.value.err))
  return signature
}

async function confirmedQuoteDelta(
  connection: Connection,
  signature: string,
  quoteAta: PublicKey,
  quoteMint: PublicKey,
): Promise<bigint> {
  const transaction = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })
  if (!transaction?.meta) throw new Error('confirmed claim balance metadata is not available yet')
  const keys = transaction.transaction.message.getAccountKeys().staticAccountKeys
  const index = keys.findIndex((account) => account.equals(quoteAta))
  if (index < 0) throw new Error('quote ATA absent from claim transaction')
  const meta = transaction.meta
  function amount(entries: typeof meta.preTokenBalances): bigint {
    const entry = entries?.find((item) => item.accountIndex === index && item.mint === quoteMint.toBase58())
    if (!entry) throw new Error('quote balance metadata missing')
    return BigInt(entry.uiTokenAmount.amount)
  }
  return amount(meta.postTokenBalances) - amount(meta.preTokenBalances)
}

function printResult(runId: string, record: ClaimRecord): void {
  console.log(JSON.stringify({
    run: runId,
    token: record.tokenId,
    share: record.share,
    signature: record.tx.signature,
    quoteMint: record.quoteMint,
    receiverQuoteAta: record.quoteAta,
    claimedQuoteRaw: record.actualQuoteDeltaRaw,
    next: 'Sum partner and creator deltas for this quote, transfer exact units to the settlement creator ATA if needed, then run launch/settle-fees.',
  }, null, 2))
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const input = JSON.parse(await readFile(resolve(options.configPath), 'utf8')) as unknown
  const analysis = analyzeStatic(input)
  const errors = analysis.issues.filter((entry) => entry.level === 'error')
  if (errors.length) throw new Error('invalid DBC plan: ' + errors.map((entry) => entry.path + ': ' + entry.message).join('; '))
  const plan = analysis.plan as LaunchPlan
  const token = plan.tokens.find((item) => item.id === options.tokenId)
  if (!token) throw new Error('selected token is missing from plan')
  const planFingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex')
  const authority = key(options.share === 'partner' ? token.feeClaimer : token.creator,
    options.share === 'partner' ? 'feeClaimer' : 'creator')
  const signer = options.keypairPath ? await loadKeypair(options.keypairPath) : null
  if (signer && !signer.publicKey.equals(authority)) {
    throw new Error('keypair does not match ' + options.share + ' claim authority')
  }
  const connection = new Connection(options.rpcUrl, 'confirmed')
  await verifyGenesis(connection, plan.cluster)
  let lock: Awaited<ReturnType<typeof open>> | null = null
  const lockPath = resolve(options.journalPath) + '.lock'
  if (options.execute) {
    lock = await open(lockPath, 'wx', 0o600).catch(() => {
      throw new Error('claim journal lock exists; verify no other claim run is active: ' + lockPath)
    })
  }
  try {
    const journal = await readJournal(options.journalPath)
    let record = journal[options.runId]
    if (record) {
      if (record.cluster !== plan.cluster || record.tokenId !== options.tokenId ||
          record.share !== options.share || record.signer !== authority.toBase58() ||
          record.quoteMint !== token.quoteMint || record.rpcUrl !== options.rpcUrl ||
          record.planFingerprint !== planFingerprint) {
        throw new Error('run ID already belongs to another DBC claim')
      }
      const currentBaseMint = key(token.baseMint, 'baseMint')
      const currentQuoteMint = key(token.quoteMint, 'quoteMint')
      const currentConfig = key(token.configAddress, 'configAddress')
      const currentPool = deriveDbcPoolAddress(currentQuoteMint, currentBaseMint, currentConfig)
      const currentBaseAta = getAssociatedTokenAddressSync(
        currentBaseMint, authority, false, TOKEN_2022_PROGRAM_ID,
      )
      const currentQuoteAta = getAssociatedTokenAddressSync(
        currentQuoteMint, authority, false, TOKEN_PROGRAM_ID,
      )
      const recordedCap = raw(record.maxQuoteRaw, 'journal maxQuoteRaw')
      if (record.pool !== currentPool.toBase58() ||
          record.quoteAta !== currentQuoteAta.toBase58() ||
          recordedCap === 0n || recordedCap > options.maxQuoteRaw) {
        throw new Error('journal pool, receiver ATA, or quote cap differs from current claim request')
      }
      signedSignature(record.tx)
      validateSignedClaim(
        Transaction.from(Buffer.from(record.tx.rawBase64, 'base64')),
        {
          share: options.share,
          signer: authority,
          config: currentConfig,
          pool: currentPool,
          baseMint: currentBaseMint,
          quoteMint: currentQuoteMint,
          baseAta: currentBaseAta,
          quoteAta: currentQuoteAta,
          baseVault: deriveDbcTokenVaultAddress(currentPool, currentBaseMint),
          quoteVault: deriveDbcTokenVaultAddress(currentPool, currentQuoteMint),
          maxQuoteAmount: recordedCap,
          poolAuthority: deriveDbcPoolAuthority(),
        },
      )
      if (!options.execute) {
        console.log('Existing claim journal phase: ' + record.phase + '; dry run sends nothing')
        if (record.phase === 'done') printResult(options.runId, record)
        return
      }
    } else {
      const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
      const context = await verifyClaimContext(connection, dbc, token, options.share, authority)
      const amount = context.availableRaw < options.maxQuoteRaw ? context.availableRaw : options.maxQuoteRaw
      console.log(options.tokenId + ' ' + options.share + ': pool ' + context.pool.toBase58() +
        ', available quote fee ' + context.availableRaw + ', claim cap ' + amount +
        ', receiver ATA ' + context.quoteAta.toBase58())
      if (amount <= 0n) throw new Error('no quote trading fee available to claim')
      const limits = quoteOnlyClaimLimits(amount)
      const args = {
        pool: context.pool,
        payer: authority,
        receiver: authority,
        maxBaseAmount: new BN(limits.maxBaseAmount.toString()),
        maxQuoteAmount: new BN(limits.maxQuoteAmount.toString()),
      }
      const built = options.share === 'partner'
        ? await dbc.partner.claimPartnerTradingFee2({ ...args, feeClaimer: authority })
        : await dbc.creator.claimCreatorTradingFee2({ ...args, creator: authority })
      const claimIx = onlyClaimInstruction(
        built, options.share, authority, context.baseAta, context.quoteAta, token.quote === 'WSOL',
      )
      console.log('quote-only DBC claim2 built; base cap = 0, quote cap = ' + amount +
        ', ' + built.instructions.length + ' SDK instructions checked')
      if (!options.execute) {
        console.log('Dry run only. Pass --execute --keypair FILE to sign and submit.')
        return
      }
      const signed = await signClaim(connection, claimIx, signer!, options.minSolLamports)
      record = {
        phase: 'signed',
        cluster: plan.cluster,
        rpcUrl: options.rpcUrl,
        planFingerprint,
        tokenId: options.tokenId,
        share: options.share,
        signer: authority.toBase58(),
        pool: context.pool.toBase58(),
        quoteMint: context.quoteMint.toBase58(),
        quoteAta: context.quoteAta.toBase58(),
        maxQuoteRaw: amount.toString(),
        tx: signed,
      }
      journal[options.runId] = record
      await saveJournal(options.journalPath, journal)
    }
    if (record.phase === 'signed') {
      const signature = await confirmClaim(connection, record.tx)
      const delta = await confirmedQuoteDelta(
        connection, signature, new PublicKey(record.quoteAta), new PublicKey(record.quoteMint),
      )
      if (delta < 0n || delta > BigInt(record.maxQuoteRaw)) {
        throw new Error('confirmed quote balance delta differs from signed cap')
      }
      record.actualQuoteDeltaRaw = delta.toString()
      record.phase = 'done'
      await saveJournal(options.journalPath, journal)
    }
    printResult(options.runId, record)
  } finally {
    if (lock) {
      await lock.close()
      await unlink(lockPath)
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
