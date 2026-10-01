import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Connection,
  PublicKey,
  type AccountInfo,
} from '@solana/web3.js'
import {
  getAccount,
  getMint,
  getTransferHook,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  deriveDbcPoolAddress,
  DynamicBondingCurveClient,
} from '@meteora-ag/dynamic-bonding-curve-sdk'

export const DBC_PROGRAM_ID = new PublicKey(
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
)
export const WSOL_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112',
)
export const USDC_MINT = new PublicKey(
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
)
const GENESIS_HASH: Record<'mainnet-beta' | 'devnet', string> = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
}

export type TokenPlan = {
  id: 'long' | 'short'
  quote: 'WSOL' | 'USDC'
  quoteMint: string
  hookProgramId: string | null
  configAddress: string | null
  baseMint: string | null
  creator: string | null
  feeClaimer: string | null
  tokenDecimals: number
  tokenType: number
  mintAuthorityPolicy: 'none' | 'retained-creator' | 'retained-partner' | null
  tokenAuthorityOption: number | null
  collectFeeMode: number
  migrationOption: number
  baseFeeMode: number
  creatorTradingFeePercentage: number | null
}

export type LaunchPlan = {
  cluster: string
  devnetUsdcMint: string | null
  wrapperProgramId: string | null
  tokens: TokenPlan[]
}

export type Issue = {
  level: 'error' | 'pending' | 'info'
  path: string
  message: string
}

export type StaticResult = {
  plan: LaunchPlan | null
  issues: Issue[]
  wrapperMints: Record<string, string>
}

/** Token-2022 keeps the extension after DBC revokes its program ID. */
export function isActiveHookProgram(programId: PublicKey | null | undefined): boolean {
  return !!programId && !programId.equals(PublicKey.default)
}

function issue(
  issues: Issue[],
  level: Issue['level'],
  path: string,
  message: string,
): void {
  issues.push({ level, path, message })
}

function address(
  value: unknown,
  path: string,
  issues: Issue[],
  required = true,
): PublicKey | null {
  if (value === null || value === undefined || value === '') {
    if (required) issue(issues, 'pending', path, 'address is not assigned yet')
    return null
  }
  if (typeof value !== 'string') {
    issue(issues, 'error', path, 'expected a base58 address string')
    return null
  }
  try {
    const key = new PublicKey(value)
    if (key.toBase58() !== value || key.equals(PublicKey.default)) {
      issue(issues, 'error', path, 'expected a canonical nonzero public key')
      return null
    }
    return key
  } catch {
    issue(issues, 'error', path, 'invalid Solana public key')
    return null
  }
}

function exact(
  actual: unknown,
  expected: unknown,
  path: string,
  issues: Issue[],
): void {
  if (actual !== expected) {
    issue(issues, 'error', path, `expected ${String(expected)}`)
  }
}

export function analyzeStatic(input: unknown): StaticResult {
  const issues: Issue[] = []
  const wrapperMints: Record<string, string> = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    issue(issues, 'error', 'config', 'expected a JSON object')
    return { plan: null, issues, wrapperMints }
  }
  const plan = input as LaunchPlan
  if (plan.cluster !== 'mainnet-beta' && plan.cluster !== 'devnet') {
    issue(issues, 'error', 'cluster', 'expected mainnet-beta or devnet')
  }
  const devnetUsdcMint = plan.cluster === 'devnet'
    ? address(plan.devnetUsdcMint, 'devnetUsdcMint', issues)
    : null
  const wrapperProgram = address(
    plan.wrapperProgramId,
    'wrapperProgramId',
    issues,
  )
  if (!Array.isArray(plan.tokens) || plan.tokens.length !== 2) {
    issue(issues, 'error', 'tokens', 'expected exactly two DBC launches')
    return { plan, issues, wrapperMints }
  }

  const seenIds = new Set<string>()
  const seenBases = new Set<string>()
  const seenConfigs = new Set<string>()
  for (const [index, token] of plan.tokens.entries()) {
    const prefix = `tokens[${index}]`
    if (!token || typeof token !== 'object') {
      issue(issues, 'error', prefix, 'expected a token plan object')
      continue
    }
    if (token.id !== 'long' && token.id !== 'short') {
      issue(issues, 'error', `${prefix}.id`, 'expected long or short')
      continue
    }
    if (seenIds.has(token.id)) {
      issue(issues, 'error', `${prefix}.id`, 'duplicate token id')
    }
    seenIds.add(token.id)
    const expectedQuote = token.id === 'long' ? 'WSOL' : 'USDC'
    const expectedMint = token.id === 'long'
      ? WSOL_MINT
      : plan.cluster === 'devnet'
        ? devnetUsdcMint
        : USDC_MINT
    exact(token.quote, expectedQuote, `${prefix}.quote`, issues)
    const quoteMint = address(token.quoteMint, `${prefix}.quoteMint`, issues)
    if (quoteMint && expectedMint && !quoteMint.equals(expectedMint)) {
      issue(
        issues,
        'error',
        `${prefix}.quoteMint`,
        `expected ${expectedQuote} mint ${expectedMint.toBase58()}`,
      )
    }

    const hook = address(token.hookProgramId, `${prefix}.hookProgramId`, issues)
    const config = address(token.configAddress, `${prefix}.configAddress`, issues)
    const base = address(token.baseMint, `${prefix}.baseMint`, issues)
    const creator = address(token.creator, `${prefix}.creator`, issues)
    const feeClaimer = address(token.feeClaimer, `${prefix}.feeClaimer`, issues)
    if (hook) {
      for (const [label, excluded] of [
        ['DBC', DBC_PROGRAM_ID],
        ['Tokenkeg', TOKEN_PROGRAM_ID],
        ['Token-2022', TOKEN_2022_PROGRAM_ID],
      ] as const) {
        if (hook.equals(excluded)) {
          issue(issues, 'error', `${prefix}.hookProgramId`, `${label} cannot be the hook program`)
        }
      }
      if (wrapperProgram && hook.equals(wrapperProgram)) {
        issue(issues, 'error', `${prefix}.hookProgramId`, 'hook and wrapper programs must be separate to avoid indirect program reentry')
      }
    }
    if (config) {
      if (seenConfigs.has(config.toBase58())) {
        issue(issues, 'error', `${prefix}.configAddress`, 'each quote needs its own DBC config')
      }
      seenConfigs.add(config.toBase58())
    }
    if (base) {
      if (seenBases.has(base.toBase58())) {
        issue(issues, 'error', `${prefix}.baseMint`, 'base mints must be distinct')
      }
      seenBases.add(base.toBase58())
      if (expectedMint && base.equals(expectedMint)) {
        issue(issues, 'error', `${prefix}.baseMint`, 'base mint cannot equal its quote mint')
      }
      if (wrapperProgram) {
        const [wrappedMint] = PublicKey.findProgramAddressSync(
          [Buffer.from('mint'), base.toBuffer(), TOKEN_PROGRAM_ID.toBuffer()],
          wrapperProgram,
        )
        wrapperMints[token.id] = wrappedMint.toBase58()
      }
    }

    if (!Number.isInteger(token.tokenDecimals) || token.tokenDecimals < 6 || token.tokenDecimals > 9) {
      issue(issues, 'error', `${prefix}.tokenDecimals`, 'DBC base mint decimals must be 6 through 9')
    }
    exact(token.tokenType, 1, `${prefix}.tokenType`, issues)
    exact(token.collectFeeMode, 0, `${prefix}.collectFeeMode`, issues)
    exact(token.migrationOption, 1, `${prefix}.migrationOption`, issues)
    if (token.baseFeeMode !== 0 && token.baseFeeMode !== 1) {
      issue(issues, 'error', `${prefix}.baseFeeMode`, 'use linear (0) or exponential (1); rate limiter (2) is deprecated')
    }
    if (token.tokenAuthorityOption === null) {
      issue(issues, 'pending', `${prefix}.tokenAuthorityOption`, 'choose 3 for creator or 4 for partner retained mint authority')
    } else if (!Number.isInteger(token.tokenAuthorityOption) || token.tokenAuthorityOption < 0 || token.tokenAuthorityOption > 4) {
      issue(issues, 'error', `${prefix}.tokenAuthorityOption`, 'expected DBC authority option 0 through 4')
    }
    if (token.mintAuthorityPolicy === null) {
      issue(issues, 'pending', `${prefix}.mintAuthorityPolicy`, 'choose retained-creator or retained-partner')
    } else {
      const policyMatches = token.mintAuthorityPolicy === 'none'
        ? token.tokenAuthorityOption !== null && [0, 1, 2].includes(token.tokenAuthorityOption)
        : token.mintAuthorityPolicy === 'retained-creator'
          ? token.tokenAuthorityOption === 3
          : token.mintAuthorityPolicy === 'retained-partner'
            ? token.tokenAuthorityOption === 4
            : false
      if (token.tokenAuthorityOption !== null && !policyMatches) {
        issue(issues, 'error', `${prefix}.mintAuthorityPolicy`, 'choose none for authority option 0/1/2, retained-creator for 3, or retained-partner for 4')
      }
    }
    if (token.mintAuthorityPolicy === 'retained-creator' || token.mintAuthorityPolicy === 'retained-partner') {
      issue(issues, 'info', `${prefix}.mintAuthorityPolicy`, 'retained mint authority can expand base supply after launch; model wrapper backing and pool NAV accordingly')
    }
    if (token.creatorTradingFeePercentage === null) {
      issue(issues, 'pending', `${prefix}.creatorTradingFeePercentage`, 'choose creator share from 0 through 100 of non-protocol trading fees')
    } else if (!Number.isInteger(token.creatorTradingFeePercentage) || token.creatorTradingFeePercentage < 0 || token.creatorTradingFeePercentage > 100) {
      issue(issues, 'error', `${prefix}.creatorTradingFeePercentage`, 'expected an integer from 0 through 100')
    } else if (token.creatorTradingFeePercentage > 0 && creator && feeClaimer && !creator.equals(feeClaimer)) {
      issue(issues, 'info', prefix, 'creator and fee claimer are different signers; claim both shares before the 50/50 quote allocation')
    }
  }
  if (!seenIds.has('long') || !seenIds.has('short')) {
    issue(issues, 'error', 'tokens', 'one long and one short plan are required')
  }
  return { plan, issues, wrapperMints }
}

async function readAccount(
  connection: Connection,
  key: PublicKey,
  path: string,
  issues: Issue[],
): Promise<AccountInfo<Buffer> | null> {
  try {
    return await connection.getAccountInfo(key, 'confirmed')
  } catch (error) {
    issue(issues, 'error', path, `RPC read failed: ${String(error)}`)
    return null
  }
}

function pubkey(value: string | null): PublicKey | null {
  return value ? new PublicKey(value) : null
}

export async function analyzeOnChain(
  result: StaticResult,
  rpcUrl: string,
): Promise<Issue[]> {
  const issues = result.issues
  if (!result.plan || issues.some((entry) => entry.level === 'error')) return issues
  const connection = new Connection(rpcUrl, 'confirmed')
  try {
    const genesisHash = await connection.getGenesisHash()
    if (genesisHash !== GENESIS_HASH[result.plan.cluster as 'mainnet-beta' | 'devnet']) {
      issue(issues, 'error', 'rpc', `RPC genesis hash ${genesisHash} does not match configured ${result.plan.cluster} cluster`)
      return issues
    }
  } catch (error) {
    issue(issues, 'error', 'rpc', `cannot read genesis hash: ${String(error)}`)
    return issues
  }
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
  const wrapperProgram = pubkey(result.plan.wrapperProgramId)
  if (wrapperProgram) {
    const account = await readAccount(connection, wrapperProgram, 'wrapperProgramId', issues)
    if (!account) issue(issues, 'pending', 'wrapperProgramId', 'wrapper program is not deployed yet')
    else if (!account.executable) issue(issues, 'error', 'wrapperProgramId', 'account is not executable')
  }

  for (const [index, token] of result.plan.tokens.entries()) {
    const prefix = `tokens[${index}]`
    const hook = pubkey(token.hookProgramId)
    const config = pubkey(token.configAddress)
    const base = pubkey(token.baseMint)
    const quote = pubkey(token.quoteMint)
    if (hook) {
      const account = await readAccount(connection, hook, `${prefix}.hookProgramId`, issues)
      if (!account) issue(issues, 'pending', `${prefix}.hookProgramId`, 'hook program is not deployed yet')
      else if (!account.executable) issue(issues, 'error', `${prefix}.hookProgramId`, 'hook account is not executable')
    }
    if (quote) {
      const account = await readAccount(connection, quote, `${prefix}.quoteMint`, issues)
      if (!account) issue(issues, 'error', `${prefix}.quoteMint`, 'quote mint does not exist on this RPC cluster')
      else if (!account.owner.equals(TOKEN_PROGRAM_ID)) issue(issues, 'error', `${prefix}.quoteMint`, 'expected legacy SPL quote mint')
      else {
        try {
          const mint = await getMint(connection, quote, 'confirmed', TOKEN_PROGRAM_ID)
          const decimals = token.quote === 'WSOL' ? 9 : 6
          if (mint.decimals !== decimals) issue(issues, 'error', `${prefix}.quoteMint`, `expected ${decimals} decimals`)
        } catch (error) {
          issue(issues, 'error', `${prefix}.quoteMint`, `cannot decode quote mint: ${String(error)}`)
        }
      }
    }

    if (config) {
      const account = await readAccount(connection, config, `${prefix}.configAddress`, issues)
      if (!account) issue(issues, 'pending', `${prefix}.configAddress`, 'createConfigWithTransferHook has not run')
      else if (!account.owner.equals(DBC_PROGRAM_ID)) issue(issues, 'error', `${prefix}.configAddress`, 'config is not owned by DBC')
      else {
        try {
          const hookConfig = await dbc.state.program.account.configWithTransferHook.fetchNullable(config)
          if (!hookConfig) {
            issue(issues, 'error', `${prefix}.configAddress`, 'expected ConfigWithTransferHook account')
          } else {
            const state = hookConfig.config
            if (hook && !hookConfig.transferHookProgram.equals(hook)) issue(issues, 'error', `${prefix}.configAddress`, 'on-chain hook program differs from plan')
            if (quote && !state.quoteMint.equals(quote)) issue(issues, 'error', `${prefix}.configAddress`, 'on-chain quote mint differs from plan')
            if (state.collectFeeMode !== 0) issue(issues, 'error', `${prefix}.configAddress`, 'on-chain fee mode is not quote-only')
            if (state.migrationOption !== 1) issue(issues, 'error', `${prefix}.configAddress`, 'on-chain migration target is not DAMM v2')
            if (state.tokenType !== 1) issue(issues, 'error', `${prefix}.configAddress`, 'on-chain base token type is not Token-2022')
            if (state.tokenDecimal !== token.tokenDecimals) issue(issues, 'error', `${prefix}.configAddress`, 'on-chain base mint decimals differ from plan')
            if (state.poolFees.baseFee.baseFeeMode !== token.baseFeeMode) issue(issues, 'error', `${prefix}.configAddress`, 'on-chain base fee mode differs from plan')
            if (state.migrationQuoteThreshold.isZero()) issue(issues, 'error', `${prefix}.configAddress`, 'on-chain migration quote threshold is zero')
            if (token.tokenAuthorityOption !== null && state.tokenUpdateAuthority !== token.tokenAuthorityOption) issue(issues, 'error', `${prefix}.configAddress`, 'on-chain token authority option differs from plan')
            if (token.creatorTradingFeePercentage !== null && state.creatorTradingFeePercentage !== token.creatorTradingFeePercentage) issue(issues, 'error', `${prefix}.configAddress`, 'on-chain creator fee share differs from plan')
            if (token.feeClaimer && !state.feeClaimer.equals(new PublicKey(token.feeClaimer))) issue(issues, 'error', `${prefix}.configAddress`, 'on-chain fee claimer differs from plan')
          }
        } catch (error) {
          issue(issues, 'error', `${prefix}.configAddress`, `cannot decode hook config: ${String(error)}`)
        }
      }
    }

    if (base && quote && config) {
      const poolAddress = deriveDbcPoolAddress(quote, base, config)
      let pool = null
      try {
        pool = await dbc.state.getPool(poolAddress)
        if (pool) {
          const hookPool = await dbc.state.program.account.transferHookPool.fetchNullable(poolAddress)
          if (!hookPool) issue(issues, 'error', `${prefix}.baseMint`, 'DBC pool is not a TransferHookPool')
        }
      } catch (error) {
        issue(issues, 'error', `${prefix}.baseMint`, `cannot read TransferHookPool: ${String(error)}`)
      }
      const account = await readAccount(connection, base, `${prefix}.baseMint`, issues)
      if (!account) {
        issue(issues, 'pending', `${prefix}.baseMint`, 'createPoolWithTransferHook has not created mint and pool')
      } else if (!account.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        issue(issues, 'error', `${prefix}.baseMint`, 'base mint is not Token-2022')
      } else {
        if (!pool) issue(issues, 'error', `${prefix}.baseMint`, 'base mint exists without its expected DBC pool; DBC pool init creates both atomically')
        try {
          const mint = await getMint(connection, base, 'confirmed', TOKEN_2022_PROGRAM_ID)
          if (mint.decimals !== token.tokenDecimals) issue(issues, 'error', `${prefix}.baseMint`, 'base mint decimals differ from plan')
          const expectedMintAuthority = token.mintAuthorityPolicy === 'retained-creator'
            ? pubkey(token.creator)
            : token.mintAuthorityPolicy === 'retained-partner'
              ? pubkey(token.feeClaimer)
              : null
          if ((token.mintAuthorityPolicy === 'none' || expectedMintAuthority) &&
            (mint.mintAuthority?.toBase58() ?? null) !== (expectedMintAuthority?.toBase58() ?? null)) {
            issue(issues, 'error', `${prefix}.baseMint`, 'mint authority differs from declared policy')
          }
          const extension = getTransferHook(mint)
          const curveComplete = pool ? pool.poolState.migrationProgress !== 0 : false
          if (!curveComplete && hook && (!isActiveHookProgram(extension?.programId) || !extension?.programId?.equals(hook))) {
            issue(issues, 'error', `${prefix}.baseMint`, 'active DBC base mint must point to planned hook program')
          }
          if (curveComplete && isActiveHookProgram(extension?.programId)) {
            issue(issues, 'error', `${prefix}.baseMint`, 'curve completed but transfer hook program remains enabled')
          }
          if (!curveComplete && hook) {
            const [metaList] = PublicKey.findProgramAddressSync(
              [Buffer.from('extra-account-metas'), base.toBuffer()],
              hook,
            )
            const metaAccount = await readAccount(connection, metaList, `${prefix}.extraAccountMetaList`, issues)
            if (!metaAccount) issue(issues, 'pending', `${prefix}.extraAccountMetaList`, `initialize hook meta list ${metaList.toBase58()} before the first swap or wrap`)
            else if (!metaAccount.owner.equals(hook)) issue(issues, 'error', `${prefix}.extraAccountMetaList`, 'meta list is not owned by hook program')
          }
        } catch (error) {
          issue(issues, 'error', `${prefix}.baseMint`, `cannot decode Token-2022 mint: ${String(error)}`)
        }
      }
      if (pool) {
        if (!pool.poolState.baseMint.equals(base)) issue(issues, 'error', `${prefix}.baseMint`, 'pool base mint mismatch')
        if (!pool.poolState.config.equals(config)) issue(issues, 'error', `${prefix}.configAddress`, 'pool config mismatch')
        if (pool.poolState.poolType !== 1) issue(issues, 'error', `${prefix}.baseMint`, 'pool base type is not Token-2022')
        try {
          const quoteVault = await getAccount(connection, pool.poolState.quoteVault, 'confirmed', TOKEN_PROGRAM_ID)
          if (!quoteVault.mint.equals(quote)) issue(issues, 'error', `${prefix}.quoteMint`, 'DBC pool quote vault holds a different mint')
        } catch (error) {
          issue(issues, 'error', `${prefix}.quoteMint`, `cannot validate DBC quote vault: ${String(error)}`)
        }
        if (token.creator && !pool.poolState.creator.equals(new PublicKey(token.creator))) issue(issues, 'error', `${prefix}.creator`, 'pool creator differs from plan')
      }
    }

    const wrapped = result.wrapperMints[token.id]
    if (wrapped && base && wrapperProgram) {
      const wrappedKey = new PublicKey(wrapped)
      const wrappedAccount = await readAccount(connection, wrappedKey, `${prefix}.wrapperMint`, issues)
      if (!wrappedAccount) issue(issues, 'pending', `${prefix}.wrapperMint`, `initialize legacy SPL wrapper mint ${wrapped}`)
      else if (!wrappedAccount.owner.equals(TOKEN_PROGRAM_ID)) issue(issues, 'error', `${prefix}.wrapperMint`, 'wrapper mint must use legacy SPL Token')
      else {
        try {
          const mint = await getMint(connection, wrappedKey, 'confirmed', TOKEN_PROGRAM_ID)
          const [expectedAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from('authority'), wrappedKey.toBuffer()],
            wrapperProgram,
          )
          if (!mint.mintAuthority?.equals(expectedAuthority)) issue(issues, 'error', `${prefix}.wrapperMint`, 'wrapper mint authority differs from fork PDA')
          if (mint.decimals !== token.tokenDecimals) issue(issues, 'error', `${prefix}.wrapperMint`, 'wrapper decimals differ from base plan')
        } catch (error) {
          issue(issues, 'error', `${prefix}.wrapperMint`, `cannot decode legacy SPL wrapper mint: ${String(error)}`)
        }
      }
    }
  }
  return issues
}

function format(issues: Issue[]): string {
  return issues.map((entry) => `${entry.level.toUpperCase().padEnd(7)} ${entry.path}: ${entry.message}`).join('\n')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const configIndex = args.indexOf('--config')
  const rpcIndex = args.indexOf('--rpc')
  if (args.includes('--help') || configIndex < 0 || !args[configIndex + 1]) {
    console.log('Usage: npm run preflight -- --config config.local.json [--rpc https://...]')
    process.exitCode = args.includes('--help') ? 0 : 1
    return
  }
  const input = JSON.parse(await readFile(resolve(args[configIndex + 1]), 'utf8')) as unknown
  const result = analyzeStatic(input)
  if (rpcIndex >= 0 && args[rpcIndex + 1]) {
    await analyzeOnChain(result, args[rpcIndex + 1])
  } else {
    issue(result.issues, 'pending', 'rpc', 'on-chain program, mint, config, pool and hook meta-list checks were skipped; pass --rpc')
  }
  for (const [id, wrapped] of Object.entries(result.wrapperMints)) {
    console.log(`${id} legacy SPL wrapper PDA: ${wrapped}`)
  }
  console.log(format(result.issues) || 'READY: launch preflight passed')
  process.exitCode = result.issues.some((entry) => entry.level === 'error')
    ? 1
    : result.issues.some((entry) => entry.level === 'pending')
      ? 2
      : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`preflight failed: ${String(error)}`)
    process.exitCode = 1
  })
}
