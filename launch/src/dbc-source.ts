import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  DynamicBondingCurveClient,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  getAccount,
  getMint,
  getTransferHook,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Connection, PublicKey } from '@solana/web3.js';
import type { LaunchPlan } from './plan.js';

const GENESIS_HASH = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
} as const;

type Side = 'long' | 'short';

export interface DbcSourceToken {
  id: Side;
  quoteMint: PublicKey;
  baseMint: PublicKey;
  configAddress: PublicKey;
  hookProgramId: PublicKey;
  creator: PublicKey;
  feeClaimer: PublicKey;
  tokenDecimals: number;
  creatorTradingFeePercentage: number;
  baseFeeMode: number;
}

export interface DbcSourcePlan {
  tokens: Record<Side, DbcSourceToken>;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function key(value: unknown, path: string): PublicKey {
  if (typeof value !== 'string') throw new Error(`${path} must be a public key`);
  try {
    const parsed = new PublicKey(value);
    if (parsed.equals(PublicKey.default) || parsed.toBase58() !== value) throw new Error('noncanonical');
    return parsed;
  } catch {
    throw new Error(`${path} must be a canonical nonzero public key`);
  }
}

function exact(value: unknown, expected: unknown, path: string): void {
  if (value !== expected) throw new Error(`${path} must be ${String(expected)}`);
}

export function parseDbcSourcePlan(input: unknown, launch: LaunchPlan): DbcSourcePlan {
  const root = object(input, 'DBC config');
  exact(root.cluster, launch.cluster, 'DBC cluster');
  if (!key(root.wrapperProgramId, 'DBC wrapperProgramId').equals(key(launch.wrapperProgramId, 'launch wrapperProgramId'))) {
    throw new Error('DBC and launch wrapper program IDs differ');
  }
  if (launch.cluster === 'devnet') {
    if (!key(root.devnetUsdcMint, 'DBC devnetUsdcMint').equals(key(launch.quoteMints.usdc, 'launch USDC mint'))) {
      throw new Error('DBC devnet USDC mint differs from launch USDC mint');
    }
  }
  if (!Array.isArray(root.tokens) || root.tokens.length !== 2) throw new Error('DBC config must contain exactly two tokens');

  const tokens: Partial<Record<Side, DbcSourceToken>> = {};
  for (const [index, value] of root.tokens.entries()) {
    const path = `DBC tokens[${index}]`;
    const token = object(value, path);
    if (token.id !== 'long' && token.id !== 'short') throw new Error(`${path}.id must be long or short`);
    const id = token.id;
    if (tokens[id]) throw new Error(`duplicate DBC ${id} token`);
    exact(token.quote, id === 'long' ? 'WSOL' : 'USDC', `${path}.quote`);
    const quoteMint = key(token.quoteMint, `${path}.quoteMint`);
    const launchQuote = key(launch.quoteMints[id === 'long' ? 'wsol' : 'usdc'], `launch ${id} quote mint`);
    if (!quoteMint.equals(launchQuote)) throw new Error(`${path}.quoteMint differs from launch quote mint`);
    const baseMint = key(token.baseMint, `${path}.baseMint`);
    if (!baseMint.equals(key(launch.dbcBaseMints[id], `launch ${id} base mint`))) {
      throw new Error(`${path}.baseMint differs from launch base mint`);
    }
    const hookProgramId = key(token.hookProgramId, `${path}.hookProgramId`);
    const wrapperProgramId = key(launch.wrapperProgramId, 'launch wrapperProgramId');
    if ([DYNAMIC_BONDING_CURVE_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, wrapperProgramId]
      .some((excluded) => hookProgramId.equals(excluded))) {
      throw new Error(`${path}.hookProgramId cannot be DBC, Tokenkeg, Token-2022, or the wrapper program`);
    }
    exact(token.mintAuthorityPolicy, 'retained-partner', `${path}.mintAuthorityPolicy`);
    exact(token.tokenAuthorityOption, 4, `${path}.tokenAuthorityOption`);
    exact(token.tokenType, 1, `${path}.tokenType`);
    exact(token.collectFeeMode, 0, `${path}.collectFeeMode`);
    exact(token.migrationOption, 1, `${path}.migrationOption`);
    if (!Number.isInteger(token.tokenDecimals) || (token.tokenDecimals as number) < 6 || (token.tokenDecimals as number) > 9) {
      throw new Error(`${path}.tokenDecimals must be 6 through 9`);
    }
    if (token.baseFeeMode !== 0 && token.baseFeeMode !== 1) throw new Error(`${path}.baseFeeMode must be 0 or 1`);
    if (!Number.isInteger(token.creatorTradingFeePercentage) || (token.creatorTradingFeePercentage as number) < 0 || (token.creatorTradingFeePercentage as number) > 100) {
      throw new Error(`${path}.creatorTradingFeePercentage must be 0 through 100`);
    }
    tokens[id] = {
      id,
      quoteMint,
      baseMint,
      configAddress: key(token.configAddress, `${path}.configAddress`),
      hookProgramId,
      creator: key(token.creator, `${path}.creator`),
      feeClaimer: key(token.feeClaimer, `${path}.feeClaimer`),
      tokenDecimals: token.tokenDecimals as number,
      creatorTradingFeePercentage: token.creatorTradingFeePercentage as number,
      baseFeeMode: token.baseFeeMode as number,
    };
  }
  if (!tokens.long || !tokens.short) throw new Error('DBC config needs long and short tokens');
  if (tokens.long.configAddress.equals(tokens.short.configAddress)) throw new Error('DBC configs must be distinct');
  if (tokens.long.baseMint.equals(tokens.short.baseMint)) throw new Error('DBC base mints must be distinct');
  return { tokens: tokens as Record<Side, DbcSourceToken> };
}

export function isActiveHook(programId: PublicKey | null | undefined): boolean {
  return !!programId && !programId.equals(PublicKey.default);
}

export async function assertDbcHooksActive(connection: Connection, source: DbcSourcePlan): Promise<void> {
  for (const side of ['long', 'short'] as const) {
    const token = source.tokens[side];
    const mint = await getMint(connection, token.baseMint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    const extension = getTransferHook(mint);
    if (!isActiveHook(extension?.programId) || !extension?.programId?.equals(token.hookProgramId)) {
      throw new Error(`${side}: DBC transfer hook was revoked or changed before pool submission`);
    }
  }
}

export async function verifyDbcSources(connection: Connection, launch: LaunchPlan, source: DbcSourcePlan): Promise<void> {
  const genesis = await connection.getGenesisHash();
  if (genesis !== GENESIS_HASH[launch.cluster]) throw new Error(`RPC genesis ${genesis} does not match ${launch.cluster}`);
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const poolAuthority = deriveDbcPoolAuthority();

  for (const side of ['long', 'short'] as const) {
    const token = source.tokens[side];
    const hookProgram = await connection.getAccountInfo(token.hookProgramId, 'confirmed');
    if (!hookProgram?.executable) throw new Error(`${side}: configured hook program is not deployed/executable`);

    const configInfo = await connection.getAccountInfo(token.configAddress, 'confirmed');
    if (!configInfo?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) throw new Error(`${side}: config is not a live DBC account`);
    const hookConfig = await client.state.program.account.configWithTransferHook.fetchNullable(token.configAddress);
    if (!hookConfig) throw new Error(`${side}: config is not a ConfigWithTransferHook`);
    const config = hookConfig.config;
    if (!hookConfig.transferHookProgram.equals(token.hookProgramId)) throw new Error(`${side}: DBC config hook program mismatch`);
    if (!config.quoteMint.equals(token.quoteMint)) throw new Error(`${side}: DBC config quote mint mismatch`);
    if (!config.feeClaimer.equals(token.feeClaimer)) throw new Error(`${side}: DBC config fee claimer mismatch`);
    if (config.tokenType !== 1 || config.tokenDecimal !== token.tokenDecimals || config.quoteTokenFlag !== 0) {
      throw new Error(`${side}: DBC config token program or decimals mismatch`);
    }
    if (config.collectFeeMode !== 0 || config.migrationOption !== 1) throw new Error(`${side}: DBC config must collect quote fees and migrate to DAMM v2`);
    if (config.tokenUpdateAuthority !== 4) throw new Error(`${side}: DBC config must retain mint authority with partner fee claimer`);
    if (config.creatorTradingFeePercentage !== token.creatorTradingFeePercentage || config.poolFees.baseFee.baseFeeMode !== token.baseFeeMode) {
      throw new Error(`${side}: DBC config fee settings differ from source plan`);
    }

    const poolAddress = deriveDbcPoolAddress(token.quoteMint, token.baseMint, token.configAddress);
    const poolAccount = await connection.getAccountInfo(poolAddress, 'confirmed');
    if (!poolAccount?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) throw new Error(`${side}: expected DBC pool is missing`);
    const pool = await client.state.program.account.transferHookPool.fetchNullable(poolAddress);
    if (!pool) throw new Error(`${side}: pool is not a TransferHookPool`);
    const state = pool.poolState;
    if (!state.config.equals(token.configAddress) || !state.baseMint.equals(token.baseMint) || !state.creator.equals(token.creator) || state.poolType !== 1) {
      throw new Error(`${side}: DBC transfer-hook pool identity mismatch`);
    }
    if (state.migrationProgress !== 0 || state.isMigrated !== 0) throw new Error(`${side}: DBC pool has completed bonding; its hook is no longer active`);
    const quoteVault = await getAccount(connection, state.quoteVault, 'confirmed', TOKEN_PROGRAM_ID);
    const baseVault = await getAccount(connection, state.baseVault, 'confirmed', TOKEN_2022_PROGRAM_ID);
    if (!quoteVault.mint.equals(token.quoteMint) || !baseVault.mint.equals(token.baseMint)) throw new Error(`${side}: DBC vault mint mismatch`);

    const mint = await getMint(connection, token.baseMint, 'confirmed', TOKEN_2022_PROGRAM_ID);
    if (mint.decimals !== token.tokenDecimals || !mint.mintAuthority?.equals(token.feeClaimer)) {
      throw new Error(`${side}: DBC base mint decimals or retained partner authority mismatch`);
    }
    const extension = getTransferHook(mint);
    if (!isActiveHook(extension?.programId) || !extension?.programId?.equals(token.hookProgramId) || !extension?.authority?.equals(poolAuthority)) {
      throw new Error(`${side}: DBC base mint has wrong or revoked transfer hook`);
    }
    const [metaList] = PublicKey.findProgramAddressSync(
      [Buffer.from('extra-account-metas'), token.baseMint.toBuffer()],
      token.hookProgramId,
    );
    const metaAccount = await connection.getAccountInfo(metaList, 'confirmed');
    if (!metaAccount?.owner.equals(token.hookProgramId)) throw new Error(`${side}: hook ExtraAccountMetaList is missing or owned by another program`);
  }
}
