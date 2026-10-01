import { derivePoolAddress } from '@meteora-ag/cp-amm-sdk';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

export const MARKET_IDS = [
  'long-wsol',
  'long-usdc',
  'short-wsol',
  'short-usdc',
  'long-short',
] as const;

export type MarketId = (typeof MARKET_IDS)[number];
export type AssetId = 'long' | 'short' | 'wsol' | 'usdc';
export type Cluster = 'mainnet-beta' | 'devnet';

export const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const MARKET_ASSETS: Record<MarketId, readonly [AssetId, AssetId]> = {
  'long-wsol': ['long', 'wsol'],
  'long-usdc': ['long', 'usdc'],
  'short-wsol': ['short', 'wsol'],
  'short-usdc': ['short', 'usdc'],
  'long-short': ['long', 'short'],
};

type ObjectValue = Record<string, unknown>;

export interface MarketPlan {
  id: MarketId;
  assets: readonly [AssetId, AssetId];
  mints: readonly [string | null, string | null];
  config: string | null;
  pool: string | null;
  seedRaw: readonly [string | null, string | null];
  missing: string[];
}

export interface LaunchPlan {
  cluster: Cluster;
  rpcUrl: string | null;
  creator: string | null;
  wrapperProgramId: string | null;
  dbcBaseMints: { long: string | null; short: string | null };
  wrapperMints: { long: string | null; short: string | null };
  quoteMints: { wsol: string | null; usdc: string | null };
  markets: MarketPlan[];
  feeRoutes: {
    quote: 'wsol' | 'usdc';
    split: readonly [number, number];
    destinations: readonly [MarketId, MarketId];
  }[];
  feeZap: {
    swapSlippageBps: number | null;
    addLiquiditySlippageBps: number | null;
    swapInputBps: number | null;
    minimumWsolClaimRaw: string | null;
    minimumUsdcClaimRaw: string | null;
  };
  ready: boolean;
}

function objectAt(value: unknown, path: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as ObjectValue;
}

function optionalObject(value: unknown, path: string): ObjectValue {
  return value == null ? {} : objectAt(value, path);
}

function address(value: unknown, path: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new Error(`${path} must be a base58 address string or null`);
  }
  try {
    const key = new PublicKey(value);
    if (key.equals(PublicKey.default)) throw new Error('zero key');
    return key.toBase58();
  } catch {
    throw new Error(`${path} is not a valid nonzero Solana address`);
  }
}

function optionalString(value: unknown, path: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a nonempty string or null`);
  return value;
}

function rawAmount(value: unknown, path: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${path} must be a positive integer string in raw token units`);
  }
  if (BigInt(value) > (1n << 64n) - 1n) throw new Error(`${path} exceeds u64`);
  return value;
}

function bps(value: unknown, path: string): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 5_000) {
    throw new Error(`${path} must be an integer from 1 to 5000 basis points or null`);
  }
  return value as number;
}

function requireDistinct(values: Array<[string, string | null]>): void {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (values[i][1] !== null && values[i][1] === values[j][1]) {
        throw new Error(`${values[i][0]} and ${values[j][0]} must be different mints`);
      }
    }
  }
}

export function deriveWrapperMint(baseMint: string, wrapperProgramId: string): string {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('mint'), new PublicKey(baseMint).toBuffer(), TOKEN_PROGRAM_ID.toBuffer()],
    new PublicKey(wrapperProgramId),
  )[0].toBase58();
}

export function deriveWrapperMintAuthority(wrapperMint: string, wrapperProgramId: string): string {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('authority'), new PublicKey(wrapperMint).toBuffer()],
    new PublicKey(wrapperProgramId),
  )[0].toBase58();
}

export function buildLaunchPlan(input: unknown): LaunchPlan {
  const root = objectAt(input, 'config');
  if (root.cluster !== 'mainnet-beta' && root.cluster !== 'devnet') {
    throw new Error('cluster must be mainnet-beta or devnet');
  }
  const cluster = root.cluster;
  const dbc = optionalObject(root.dbc, 'dbc');
  const quotes = optionalObject(root.quotes, 'quotes');
  const configuredMarkets = optionalObject(root.markets, 'markets');
  const feeZapInput = optionalObject(root.feeZap, 'feeZap');

  const rpcUrl = optionalString(root.rpcUrl, 'rpcUrl');
  if (rpcUrl !== null && !/^https?:\/\//.test(rpcUrl)) throw new Error('rpcUrl must start with http:// or https://');
  const creator = address(root.creator, 'creator');
  const wrapperProgramId = address(root.wrapperProgramId, 'wrapperProgramId');
  const dbcBaseMints = {
    long: address(dbc.longBaseMint, 'dbc.longBaseMint'),
    short: address(dbc.shortBaseMint, 'dbc.shortBaseMint'),
  };
  const quoteMints = {
    wsol: address(quotes.wsolMint, 'quotes.wsolMint'),
    usdc: address(quotes.usdcMint, 'quotes.usdcMint'),
  };
  if (quoteMints.wsol !== null && quoteMints.wsol !== NATIVE_MINT.toBase58()) {
    throw new Error('quotes.wsolMint must be the legacy SPL wrapped SOL mint');
  }
  if (cluster === 'mainnet-beta' && quoteMints.usdc !== null && quoteMints.usdc !== MAINNET_USDC_MINT) {
    throw new Error(`mainnet quotes.usdcMint must be canonical USDC ${MAINNET_USDC_MINT}`);
  }
  requireDistinct([
    ['dbc.longBaseMint', dbcBaseMints.long],
    ['dbc.shortBaseMint', dbcBaseMints.short],
    ['quotes.wsolMint', quoteMints.wsol],
    ['quotes.usdcMint', quoteMints.usdc],
  ]);

  const wrapperMints = {
    long:
      dbcBaseMints.long && wrapperProgramId
        ? deriveWrapperMint(dbcBaseMints.long, wrapperProgramId)
        : null,
    short:
      dbcBaseMints.short && wrapperProgramId
        ? deriveWrapperMint(dbcBaseMints.short, wrapperProgramId)
        : null,
  };
  requireDistinct([
    ['long wrapper', wrapperMints.long],
    ['short wrapper', wrapperMints.short],
    ['quotes.wsolMint', quoteMints.wsol],
    ['quotes.usdcMint', quoteMints.usdc],
  ]);

  const assets: Record<AssetId, string | null> = {
    long: wrapperMints.long,
    short: wrapperMints.short,
    wsol: quoteMints.wsol,
    usdc: quoteMints.usdc,
  };

  for (const configuredId of Object.keys(configuredMarkets)) {
    if (!MARKET_IDS.includes(configuredId as MarketId)) throw new Error(`unknown market ${configuredId}`);
  }

  const markets = MARKET_IDS.map((id): MarketPlan => {
    const assetsForMarket = MARKET_ASSETS[id];
    const market = optionalObject(configuredMarkets[id], `markets.${id}`);
    const seed = optionalObject(market.seedRaw, `markets.${id}.seedRaw`);
    const config = address(market.config, `markets.${id}.config`);
    const mintA = assets[assetsForMarket[0]];
    const mintB = assets[assetsForMarket[1]];
    const amountA = rawAmount(seed[assetsForMarket[0]], `markets.${id}.seedRaw.${assetsForMarket[0]}`);
    const amountB = rawAmount(seed[assetsForMarket[1]], `markets.${id}.seedRaw.${assetsForMarket[1]}`);
    for (const key of Object.keys(seed)) {
      if (!assetsForMarket.includes(key as AssetId)) throw new Error(`markets.${id}.seedRaw.${key} is not in this pair`);
    }
    const missing: string[] = [];
    if (!mintA) missing.push(`${assetsForMarket[0]} mint`);
    if (!mintB) missing.push(`${assetsForMarket[1]} mint`);
    if (!config) missing.push('DAMM v2 static config');
    if (!amountA) missing.push(`${assetsForMarket[0]} seed amount`);
    if (!amountB) missing.push(`${assetsForMarket[1]} seed amount`);
    return {
      id,
      assets: assetsForMarket,
      mints: [mintA, mintB],
      config,
      pool:
        config && mintA && mintB
          ? derivePoolAddress(new PublicKey(config), new PublicKey(mintA), new PublicKey(mintB)).toBase58()
          : null,
      seedRaw: [amountA, amountB],
      missing,
    };
  });

  const feeRoutes: LaunchPlan['feeRoutes'] = [
    { quote: 'wsol', split: [50, 50], destinations: ['long-wsol', 'short-wsol'] },
    { quote: 'usdc', split: [50, 50], destinations: ['long-usdc', 'short-usdc'] },
  ];
  const feeZap: LaunchPlan['feeZap'] = {
    swapSlippageBps: bps(feeZapInput.swapSlippageBps, 'feeZap.swapSlippageBps'),
    addLiquiditySlippageBps: bps(feeZapInput.addLiquiditySlippageBps, 'feeZap.addLiquiditySlippageBps'),
    swapInputBps: bps(feeZapInput.swapInputBps, 'feeZap.swapInputBps'),
    minimumWsolClaimRaw: rawAmount(feeZapInput.minimumWsolClaimRaw, 'feeZap.minimumWsolClaimRaw'),
    minimumUsdcClaimRaw: rawAmount(feeZapInput.minimumUsdcClaimRaw, 'feeZap.minimumUsdcClaimRaw'),
  };

  return {
    cluster,
    rpcUrl,
    creator,
    wrapperProgramId,
    dbcBaseMints,
    wrapperMints,
    quoteMints,
    markets,
    feeRoutes,
    feeZap,
    ready: Boolean(rpcUrl && creator && wrapperProgramId && markets.every((market) => market.missing.length === 0)),
  };
}
