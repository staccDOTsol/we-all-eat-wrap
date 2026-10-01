import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import BN from 'bn.js';
import {
  CollectFeeMode,
  CpAmm,
  derivePositionAddress,
  derivePositionNftAccount,
  type ConfigState,
} from '@meteora-ag/cp-amm-sdk';
import { getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { buildLaunchPlan, deriveWrapperMintAuthority, type LaunchPlan, type MarketPlan } from './plan.js';
import { assertDbcHooksActive, parseDbcSourcePlan, verifyDbcSources } from './dbc-source.js';

interface Options {
  command: 'plan' | 'create-pools';
  configPath: string;
  dbcConfigPath: string | null;
  execute: boolean;
  keypairPath: string | null;
  onlyMarket: string | null;
  receiptsPath: string;
}

function parseOptions(argv: string[]): Options {
  const command = argv[0];
  if (command !== 'plan' && command !== 'create-pools') {
    throw new Error('usage: tsx src/launch.ts <plan|create-pools> [--config FILE] [--dbc-config FILE] [--market ID] [--execute --keypair FILE] [--receipts FILE]');
  }
  const result: Options = {
    command,
    configPath: 'config.example.json',
    dbcConfigPath: null,
    execute: false,
    keypairPath: null,
    onlyMarket: null,
    receiptsPath: 'receipts.json',
  };
  for (let i = 1; i < argv.length; i++) {
    const option = argv[i];
    if (option === '--execute') {
      result.execute = true;
    } else if (option === '--config' || option === '--dbc-config' || option === '--keypair' || option === '--market' || option === '--receipts') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${option} needs a value`);
      if (option === '--config') result.configPath = value;
      if (option === '--dbc-config') result.dbcConfigPath = value;
      if (option === '--keypair') result.keypairPath = value;
      if (option === '--market') result.onlyMarket = value;
      if (option === '--receipts') result.receiptsPath = value;
    } else {
      throw new Error(`unknown option ${option}`);
    }
  }
  if (result.command === 'plan' && (result.execute || result.keypairPath || result.dbcConfigPath || result.onlyMarket || result.receiptsPath !== 'receipts.json')) {
    throw new Error('plan supports only --config');
  }
  if (result.execute && !result.keypairPath) throw new Error('--execute requires --keypair');
  if (result.command === 'create-pools' && !result.dbcConfigPath) throw new Error('create-pools requires --dbc-config with the matching DBC launch plan');
  return result;
}

interface PoolReceipt {
  pool: string;
  tokenAMint: string;
  tokenBMint: string;
  positionNftMint: string;
  position: string;
  positionNftAccount: string;
  signature: string;
  createdAt: string;
}

async function writeReceipt(path: string, marketId: string, receipt: PoolReceipt): Promise<void> {
  const absolute = resolve(path);
  let receipts: Record<string, PoolReceipt> = {};
  try {
    receipts = JSON.parse(await readFile(absolute, 'utf8')) as Record<string, PoolReceipt>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  receipts[marketId] = receipt;
  await writeFile(absolute, `${JSON.stringify(receipts, null, 2)}\n`, { mode: 0o600 });
}

async function readReceipts(path: string): Promise<Record<string, PoolReceipt>> {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf8')) as Record<string, PoolReceipt>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function readPlan(path: string): Promise<LaunchPlan> {
  const json = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  return buildLaunchPlan(json);
}

function selectedMarkets(plan: LaunchPlan, selected: string | null): MarketPlan[] {
  if (!selected) return plan.markets;
  const market = plan.markets.find((candidate) => candidate.id === selected);
  if (!market) throw new Error(`unknown market ${selected}`);
  return [market];
}

function assertPoolInputs(plan: LaunchPlan, markets: MarketPlan[]): asserts plan is LaunchPlan & {
  rpcUrl: string;
  creator: string;
  wrapperProgramId: string;
} {
  const missing = [
    ...(!plan.rpcUrl ? ['rpcUrl'] : []),
    ...(!plan.creator ? ['creator'] : []),
    ...(!plan.wrapperProgramId ? ['wrapperProgramId'] : []),
    ...(!plan.dbcBaseMints.long ? ['dbc.longBaseMint'] : []),
    ...(!plan.dbcBaseMints.short ? ['dbc.shortBaseMint'] : []),
    ...markets.flatMap((market) => market.missing.map((item) => `${market.id}: ${item}`)),
  ];
  if (missing.length) throw new Error(`incomplete launch config:\n- ${missing.join('\n- ')}`);
}

async function loadKeypair(path: string): Promise<Keypair> {
  const raw = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new Error('keypair file must contain a Solana CLI 64-byte JSON array');
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

async function verifyTokenMints(connection: Connection, plan: LaunchPlan): Promise<void> {
  const wrapperProgramId = new PublicKey(plan.wrapperProgramId!);
  const wrapperProgram = await connection.getAccountInfo(wrapperProgramId);
  if (!wrapperProgram?.executable) throw new Error(`wrapper program ${wrapperProgramId} is not deployed/executable on this RPC`);

  for (const side of ['long', 'short'] as const) {
    const baseAddress = new PublicKey(plan.dbcBaseMints[side]!);
    const base = await getMint(connection, baseAddress, 'confirmed', TOKEN_2022_PROGRAM_ID);
    const wrapperAddress = new PublicKey(plan.wrapperMints[side]!);
    const wrapper = await getMint(connection, wrapperAddress, 'confirmed', TOKEN_PROGRAM_ID);
    if (wrapper.decimals !== base.decimals) throw new Error(`${side} wrapper decimals differ from DBC base mint`);
    const authority = new PublicKey(deriveWrapperMintAuthority(wrapperAddress.toBase58(), wrapperProgramId.toBase58()));
    if (!wrapper.mintAuthority?.equals(authority)) {
      throw new Error(`${side} wrapper mint authority is not this fork's PDA`);
    }
  }
  for (const quote of ['wsol', 'usdc'] as const) {
    const mint = await getMint(connection, new PublicKey(plan.quoteMints[quote]!), 'confirmed', TOKEN_PROGRAM_ID);
    if (mint.decimals !== (quote === 'wsol' ? 9 : 6)) throw new Error(`${quote} quote mint has unexpected decimals`);
  }
}

async function buildPools(options: Options, plan: LaunchPlan): Promise<void> {
  const markets = selectedMarkets(plan, options.onlyMarket);
  assertPoolInputs(plan, markets);
  const connection = new Connection(plan.rpcUrl, 'confirmed');
  const cpAmm = new CpAmm(connection);
  const creator = new PublicKey(plan.creator);
  const keypair = options.keypairPath ? await loadKeypair(options.keypairPath) : null;
  if (keypair && !keypair.publicKey.equals(creator)) {
    throw new Error('the keypair public key does not match config.creator');
  }
  const dbcInput = JSON.parse(await readFile(resolve(options.dbcConfigPath!), 'utf8')) as unknown;
  const dbcSource = parseDbcSourcePlan(dbcInput, plan);
  await verifyDbcSources(connection, plan, dbcSource);
  await verifyTokenMints(connection, plan);

  // A public static config is required for permissionless createPool().
  const staticConfigs = await cpAmm.getStaticConfigs();
  const staticConfigKeys = new Set(staticConfigs.map(({ publicKey }) => publicKey.toBase58()));

  for (const market of markets) {
    const configAddress = new PublicKey(market.config!);
    if (!staticConfigKeys.has(configAddress.toBase58())) {
      throw new Error(`${market.id}: ${configAddress} is not a public static DAMM v2 config`);
    }
    const pool = new PublicKey(market.pool!);
    if (await connection.getAccountInfo(pool)) {
      const existing = await cpAmm.fetchPoolState(pool);
      if (!existing.creator.equals(creator) ||
          !existing.tokenAMint.equals(new PublicKey(market.mints[0]!)) ||
          !existing.tokenBMint.equals(new PublicKey(market.mints[1]!))) {
        throw new Error(`${market.id}: existing pool has unexpected creator or token order at ${pool.toBase58()}`);
      }
      const receipt = (await readReceipts(options.receiptsPath))[market.id];
      if (!receipt || receipt.pool !== pool.toBase58() ||
          receipt.tokenAMint !== existing.tokenAMint.toBase58() ||
          receipt.tokenBMint !== existing.tokenBMint.toBase58()) {
        throw new Error(`${market.id}: pool exists without a matching local receipt; inspect chain and position NFT before proceeding`);
      }
      console.log(`${market.id}: verified existing pool ${pool.toBase58()} and receipt; skipped`);
      continue;
    }
    const configState: ConfigState = await cpAmm.fetchConfigState(configAddress);
    const tokenAMint = new PublicKey(market.mints[0]!);
    const tokenBMint = new PublicKey(market.mints[1]!);
    const tokenAAmount = new BN(market.seedRaw[0]!, 10);
    const tokenBAmount = new BN(market.seedRaw[1]!, 10);
    const { initSqrtPrice, liquidityDelta } = cpAmm.preparePoolCreationParams({
      tokenAAmount,
      tokenBAmount,
      minSqrtPrice: configState.sqrtMinPrice,
      maxSqrtPrice: configState.sqrtMaxPrice,
      collectFeeMode: configState.collectFeeMode as CollectFeeMode,
    });
    if (liquidityDelta.lten(0)) throw new Error(`${market.id}: seed amounts produce zero liquidity`);
    const positionNft = Keypair.generate();
    const transaction = await cpAmm.createPool({
      creator,
      payer: creator,
      config: configAddress,
      positionNft: positionNft.publicKey,
      tokenAMint,
      tokenBMint,
      initSqrtPrice,
      liquidityDelta,
      tokenAAmount,
      tokenBAmount,
      activationPoint: null,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
    });
    console.log(`${market.id}: ${pool.toBase58()} | ${transaction.instructions.length} instructions | position NFT ${positionNft.publicKey.toBase58()}`);
    if (!options.execute) continue;
    await assertDbcHooksActive(connection, dbcSource);
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = creator;
    const signature = await sendAndConfirmTransaction(connection, transaction, [keypair!, positionNft], {
      commitment: 'confirmed',
      skipPreflight: false,
    });
    const createdPool = await cpAmm.fetchPoolState(pool);
    if (!createdPool.creator.equals(creator) ||
        !createdPool.tokenAMint.equals(tokenAMint) || !createdPool.tokenBMint.equals(tokenBMint)) {
      throw new Error(`${market.id}: created pool has unexpected token A/B mints; inspect ${pool.toBase58()}`);
    }
    await writeReceipt(options.receiptsPath, market.id, {
      pool: pool.toBase58(),
      tokenAMint: createdPool.tokenAMint.toBase58(),
      tokenBMint: createdPool.tokenBMint.toBase58(),
      positionNftMint: positionNft.publicKey.toBase58(),
      position: derivePositionAddress(positionNft.publicKey).toBase58(),
      positionNftAccount: derivePositionNftAccount(positionNft.publicKey).toBase58(),
      signature,
      createdAt: new Date().toISOString(),
    });
    console.log(`${market.id}: created ${pool.toBase58()} | signature ${signature}`);
  }
  if (!options.execute) console.log('Dry run only. Pass --execute --keypair FILE to submit pool creation transactions.');
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const plan = await readPlan(options.configPath);
  if (options.command === 'plan') {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  await buildPools(options, plan);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
