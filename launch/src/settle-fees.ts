import { createHash } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import BN from "bn.js";
import {
  CP_AMM_PROGRAM_ID,
  CollectFeeMode,
  CpAmm,
  PoolStatus,
  Rounding,
  SwapMode,
  derivePoolAuthority,
  derivePositionAddress,
  derivePositionNftAccount,
  deriveTokenVaultAddress,
  getAmountAFromLiquidityDelta,
  getAmountBFromLiquidityDelta,
  getCurrentPoint,
  type PoolState,
  type Quote2Result,
} from "@meteora-ag/cp-amm-sdk";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  compoundingDepositGap,
  compoundingPostSwapReserves,
  parseClaimedRaw,
  splitClaimedFees,
  utilizationBps,
  worstCaseProjectedUtilization,
  type FeeAllocation,
} from "./fees.js";
import { buildLaunchPlan, MARKET_IDS, type LaunchPlan, type MarketId, type MarketPlan } from "./plan.js";
import { onlyDammInstruction } from "./sdk-instruction.js";
import {
  assertClaimSourcesUnused,
  selectClaimSources,
  verifyClaimSourcesOnChain,
  type ClaimSource,
} from "./claim-sources.js";

interface Options {
  configPath: string;
  receiptsPath: string;
  settlementPath: string;
  runId: string;
  wsolRaw: bigint;
  usdcRaw: bigint;
  manual: boolean;
  claimJournalPath: string | null;
  claimRunIds: string[];
  execute: boolean;
  keypairPath: string | null;
  minSolLamports: bigint;
  minWrapperOutRaw: Partial<Record<MarketId, bigint>>;
  minLpUtilizationBps: number;
}

interface PoolReceipt {
  pool: string;
  tokenAMint: string;
  tokenBMint: string;
  positionNftMint: string;
  position: string;
  positionNftAccount: string;
}

interface SignedTx {
  signature: string;
  rawBase64: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

interface RouteJournal {
  phase: "swap-submitted" | "swapped" | "lp-submitted" | "done" | "needs-rebalance";
  allocationRaw: string;
  swapInputRaw: string;
  minimumWrapperOutRaw: string;
  swapTx: SignedTx;
  wrapperReceivedRaw?: string;
  lpTx?: SignedTx;
  liquidityDeltaRaw?: string;
  wrapperDepositedRaw?: string;
  quoteDepositedRaw?: string;
  wrapperLeftoverRaw?: string;
  quoteLeftoverRaw?: string;
}

interface RunJournal {
  creator: string;
  rpcUrl: string;
  sourceMode?: "manual" | "claims";
  claimSources?: ClaimSource[];
  wsolRaw: string;
  usdcRaw: string;
  marketBoundsRaw: Partial<Record<MarketId, string>>;
  minLpUtilizationBps: number;
  planFingerprint: string;
  routes: Partial<Record<FeeAllocation["market"], RouteJournal>>;
}

type SettlementJournal = Record<string, RunJournal>;

function parseOptions(argv: string[]): Options {
  let rawAmountsProvided = false;
  const options: Options = {
    configPath: "config.example.json",
    receiptsPath: "receipts.json",
    settlementPath: "settlements.json",
    runId: "",
    wsolRaw: 0n,
    usdcRaw: 0n,
    manual: false,
    claimJournalPath: null,
    claimRunIds: [],
    execute: false,
    keypairPath: null,
    minSolLamports: 50_000_000n,
    minWrapperOutRaw: {},
    minLpUtilizationBps: 9_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (option === "--execute") {
      options.execute = true;
      continue;
    }
    if (option === "--manual") {
      options.manual = true;
      continue;
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(option + " needs a value");
    if (option === "--config") options.configPath = value;
    else if (option === "--receipts") options.receiptsPath = value;
    else if (option === "--settlements") options.settlementPath = value;
    else if (option === "--run") options.runId = value;
    else if (option === "--claimed-wsol-raw") {
      options.wsolRaw = parseClaimedRaw(value, option);
      rawAmountsProvided = true;
    }
    else if (option === "--claimed-usdc-raw") {
      options.usdcRaw = parseClaimedRaw(value, option);
      rawAmountsProvided = true;
    }
    else if (option === "--claim-journal") options.claimJournalPath = value;
    else if (option === "--claim-run") options.claimRunIds.push(value);
    else if (option === "--min-sol-lamports") options.minSolLamports = parseClaimedRaw(value, option);
    else if (option === "--keypair") options.keypairPath = value;
    else if (option === "--min-lp-utilization-bps") {
      const bps = Number(value);
      if (!Number.isInteger(bps) || bps < 5_000 || bps > 10_000) {
        throw new Error(option + " must be an integer from 5000 to 10000");
      }
      options.minLpUtilizationBps = bps;
    } else if (option.startsWith("--min-wrapper-out-") && option.endsWith("-raw")) {
      const market = option.slice("--min-wrapper-out-".length, -"-raw".length);
      if (!MARKET_IDS.includes(market as MarketId) || market === "long-short") {
        throw new Error("unknown wrapper market price floor " + market);
      }
      const amount = parseClaimedRaw(value, option);
      if (amount === 0n) throw new Error(option + " must be positive");
      options.minWrapperOutRaw[market as MarketId] = amount;
    }
    else throw new Error("unknown option " + option);
  }
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(options.runId)) {
    throw new Error("--run needs a unique claim batch ID (letters, numbers, dot, underscore, hyphen)");
  }
  if (options.manual) {
    if (options.claimJournalPath || options.claimRunIds.length) {
      throw new Error("--manual cannot be combined with --claim-journal or --claim-run");
    }
    if (options.wsolRaw === 0n && options.usdcRaw === 0n) {
      throw new Error("manual mode needs at least one positive claimed quote amount");
    }
  } else {
    if (rawAmountsProvided) {
      throw new Error("raw claimed amounts require explicit --manual mode");
    }
    if (!options.claimJournalPath || options.claimRunIds.length === 0) {
      throw new Error("receipt mode needs --claim-journal PATH and one or more --claim-run ID");
    }
  }
  if (options.execute && !options.keypairPath) throw new Error("--execute requires --keypair");
  if (!options.execute && options.keypairPath) throw new Error("--keypair requires --execute");
  return options;
}

async function loadKeypair(path: string): Promise<Keypair> {
  const raw = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.length !== 64 ||
      !raw.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new Error("keypair file must contain a Solana CLI 64-byte JSON array");
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

async function readJournal(path: string): Promise<SettlementJournal> {
  try {
    return await readJson<SettlementJournal>(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function saveJournal(path: string, value: SettlementJournal): Promise<void> {
  const absolute = resolve(path);
  const temporary = absolute + ".tmp-" + process.pid;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, absolute);
}

function assertPlan(plan: LaunchPlan): asserts plan is LaunchPlan & {
  rpcUrl: string;
  creator: string;
} {
  if (!plan.rpcUrl || !plan.creator || !plan.quoteMints.wsol || !plan.quoteMints.usdc ||
      !plan.wrapperMints.long || !plan.wrapperMints.short) {
    throw new Error("complete rpcUrl, creator, both DBC mints, wrapper program, and both quote mints");
  }
  if (plan.feeZap.swapSlippageBps === null || plan.feeZap.addLiquiditySlippageBps === null) {
    throw new Error("set feeZap.swapSlippageBps and feeZap.addLiquiditySlippageBps");
  }
}

function routeMarket(plan: LaunchPlan, route: FeeAllocation): MarketPlan & { pool: string } {
  const market = plan.markets.find((candidate) => candidate.id === route.market);
  if (!market?.pool || !market.mints[0] || !market.mints[1]) {
    throw new Error(route.market + ": configure its DAMM v2 pool and token mints");
  }
  return market as MarketPlan & { pool: string };
}

function requireKeyEqual(actual: PublicKey, expected: string | PublicKey, label: string): void {
  if (!actual.equals(typeof expected === "string" ? new PublicKey(expected) : expected)) {
    throw new Error(label + " does not match the configured pool");
  }
}

function requireU64(value: bigint, label: string): BN {
  if (value < 0n || value > (1n << 64n) - 1n) throw new Error(label + " is outside u64");
  return new BN(value.toString());
}

function bn(value: bigint): BN {
  return new BN(value.toString());
}

function fingerprint(plan: LaunchPlan, receipts: Record<string, PoolReceipt>): string {
  const scope = { plan, receipts: MARKET_IDS.map((id) => [id, receipts[id] ?? null]) };
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex");
}

function marketBounds(options: Options, routes: FeeAllocation[]): Partial<Record<MarketId, string>> {
  const bounds: Partial<Record<MarketId, string>> = {};
  for (const route of routes) {
    const floor = options.minWrapperOutRaw[route.market];
    if (options.execute && floor === undefined) {
      throw new Error("--min-wrapper-out-" + route.market + "-raw is required to execute this fee route");
    }
    if (floor !== undefined) bounds[route.market] = floor.toString();
  }
  return bounds;
}

function estimatedDeposit(
  poolState: PoolState,
  liquidityDelta: BN,
): { tokenA: bigint; tokenB: bigint } {
  const tokenA = getAmountAFromLiquidityDelta(
    poolState.sqrtPrice,
    poolState.sqrtMaxPrice,
    liquidityDelta,
    Rounding.Up,
    poolState.collectFeeMode as CollectFeeMode,
    poolState.tokenAAmount,
    poolState.liquidity,
  );
  const tokenB = getAmountBFromLiquidityDelta(
    poolState.sqrtMinPrice,
    poolState.sqrtPrice,
    liquidityDelta,
    Rounding.Up,
    poolState.collectFeeMode as CollectFeeMode,
    poolState.tokenBAmount,
    poolState.liquidity,
  );
  return { tokenA: BigInt(tokenA.toString()), tokenB: BigInt(tokenB.toString()) };
}

function quoteMint(plan: LaunchPlan, route: FeeAllocation): PublicKey {
  return new PublicKey(plan.quoteMints[route.quote]!);
}

function wrapperMint(plan: LaunchPlan, route: FeeAllocation): PublicKey {
  const side = route.market.startsWith("long") ? "long" : "short";
  return new PublicKey(plan.wrapperMints[side]!);
}

interface RouteContext {
  market: MarketPlan & { pool: string };
  pool: PublicKey;
  poolState: PoolState;
  receipt: PoolReceipt;
  quoteMint: PublicKey;
  wrapperMint: PublicKey;
  quoteAta: PublicKey;
  wrapperAta: PublicKey;
  tokenADecimal: number;
  tokenBDecimal: number;
}

async function loadRouteContext(
  connection: Connection,
  cpAmm: CpAmm,
  plan: LaunchPlan,
  receipts: Record<string, PoolReceipt>,
  route: FeeAllocation,
  creator: PublicKey,
): Promise<RouteContext> {
  const market = routeMarket(plan, route);
  const receipt = receipts[route.market];
  if (!receipt) throw new Error(route.market + ": no pool creation receipt");
  if (receipt.pool !== market.pool) throw new Error(route.market + ": receipt pool differs from plan");
  const pool = new PublicKey(market.pool);
  const poolInfo = await connection.getAccountInfo(pool, "confirmed");
  if (!poolInfo?.owner.equals(CP_AMM_PROGRAM_ID)) {
    throw new Error(route.market + ": pool account is not owned by DAMM v2");
  }
  const state = await cpAmm.fetchPoolState(pool);
  requireKeyEqual(state.tokenAMint, receipt.tokenAMint, route.market + " token A");
  requireKeyEqual(state.tokenBMint, receipt.tokenBMint, route.market + " token B");
  const quote = quoteMint(plan, route);
  const wrapper = wrapperMint(plan, route);
  if (!(state.tokenAMint.equals(quote) && state.tokenBMint.equals(wrapper)) &&
      !(state.tokenAMint.equals(wrapper) && state.tokenBMint.equals(quote))) {
    throw new Error(route.market + ": pool does not contain expected wrapper and quote");
  }
  requireKeyEqual(state.tokenAVault, deriveTokenVaultAddress(state.tokenAMint, pool), "token A vault");
  requireKeyEqual(state.tokenBVault, deriveTokenVaultAddress(state.tokenBMint, pool), "token B vault");
  const vaultA = await getAccount(connection, state.tokenAVault, "confirmed", TOKEN_PROGRAM_ID);
  const vaultB = await getAccount(connection, state.tokenBVault, "confirmed", TOKEN_PROGRAM_ID);
  requireKeyEqual(vaultA.mint, state.tokenAMint, "token A vault mint");
  requireKeyEqual(vaultB.mint, state.tokenBMint, "token B vault mint");
  requireKeyEqual(vaultA.owner, derivePoolAuthority(), "token A vault owner");
  requireKeyEqual(vaultB.owner, derivePoolAuthority(), "token B vault owner");
  const positionNft = new PublicKey(receipt.positionNftMint);
  const position = derivePositionAddress(positionNft);
  const nftAccount = derivePositionNftAccount(positionNft);
  requireKeyEqual(position, receipt.position, "position PDA");
  requireKeyEqual(nftAccount, receipt.positionNftAccount, "position NFT account");
  const positionInfo = await connection.getAccountInfo(position, "confirmed");
  if (!positionInfo?.owner.equals(CP_AMM_PROGRAM_ID)) {
    throw new Error(route.market + ": position account is not owned by DAMM v2");
  }
  const positionState = await cpAmm.fetchPositionState(position);
  requireKeyEqual(positionState.pool, pool, "position pool");
  requireKeyEqual(positionState.nftMint, positionNft, "position NFT mint");
  const nft = await getAccount(connection, nftAccount, "confirmed", TOKEN_2022_PROGRAM_ID);
  requireKeyEqual(nft.owner, creator, "position NFT owner");
  requireKeyEqual(nft.mint, positionNft, "position NFT account mint");
  if (nft.amount !== 1n) throw new Error(route.market + ": creator does not hold one position NFT");
  const quoteAta = getAssociatedTokenAddressSync(quote, creator, false, TOKEN_PROGRAM_ID);
  const wrapperAta = getAssociatedTokenAddressSync(wrapper, creator, false, TOKEN_PROGRAM_ID);
  const [quoteAccount, wrapperAccount] = await Promise.all([
    getAccount(connection, quoteAta, "confirmed", TOKEN_PROGRAM_ID),
    getAccount(connection, wrapperAta, "confirmed", TOKEN_PROGRAM_ID),
  ]);
  requireKeyEqual(quoteAccount.owner, creator, "quote ATA owner");
  requireKeyEqual(wrapperAccount.owner, creator, "wrapper ATA owner");
  requireKeyEqual(quoteAccount.mint, quote, "quote ATA mint");
  requireKeyEqual(wrapperAccount.mint, wrapper, "wrapper ATA mint");
  const [mintA, mintB] = await Promise.all([
    getMint(connection, state.tokenAMint, "confirmed", TOKEN_PROGRAM_ID),
    getMint(connection, state.tokenBMint, "confirmed", TOKEN_PROGRAM_ID),
  ]);
  if (state.poolStatus !== PoolStatus.Enable) throw new Error(route.market + ": pool swap is disabled");
  return {
    market,
    pool,
    poolState: state,
    receipt,
    quoteMint: quote,
    wrapperMint: wrapper,
    quoteAta,
    wrapperAta,
    tokenADecimal: mintA.decimals,
    tokenBDecimal: mintB.decimals,
  };
}

async function quoteSwap(
  connection: Connection,
  cpAmm: CpAmm,
  context: RouteContext,
  amount: bigint,
  swapSlippageBps: number,
  currentPoint?: BN,
): Promise<Quote2Result> {
  const point = currentPoint ?? await getCurrentPoint(connection, context.poolState.activationType);
  const quote = cpAmm.getQuote2({
    inputTokenMint: context.quoteMint,
    amountIn: requireU64(amount, "swap input"),
    swapMode: SwapMode.ExactIn,
    slippage: swapSlippageBps,
    currentPoint: point,
    poolState: context.poolState,
    tokenADecimal: context.tokenADecimal,
    tokenBDecimal: context.tokenBDecimal,
    hasReferral: false,
  });
  if (!quote.amountLeft.isZero() || !quote.includedFeeInputAmount.eq(bn(amount))) {
    throw new Error(context.market.id + ": quote would partially fill the exact-input swap");
  }
  return quote;
}

function quoteAmounts(quote: Quote2Result) {
  return {
    excludedFeeInputAmount: BigInt(quote.excludedFeeInputAmount.toString()),
    outputAmount: BigInt(quote.outputAmount.toString()),
    claimingFee: BigInt(quote.claimingFee.toString()),
    compoundingFee: BigInt(quote.compoundingFee.toString()),
    protocolFee: BigInt(quote.protocolFee.toString()),
    referralFee: BigInt(quote.referralFee.toString()),
  };
}

function projectedPoolAfterSwap(context: RouteContext, quote: Quote2Result): PoolState {
  if (context.poolState.collectFeeMode !== CollectFeeMode.Compounding) {
    return { ...context.poolState, sqrtPrice: quote.nextSqrtPrice };
  }
  const quoteIsTokenA = context.poolState.tokenAMint.equals(context.quoteMint);
  const post = compoundingPostSwapReserves(
    BigInt((quoteIsTokenA ? context.poolState.tokenAAmount : context.poolState.tokenBAmount).toString()),
    BigInt((quoteIsTokenA ? context.poolState.tokenBAmount : context.poolState.tokenAAmount).toString()),
    quoteAmounts(quote),
    quoteIsTokenA,
  );
  return {
    ...context.poolState,
    sqrtPrice: quote.nextSqrtPrice,
    tokenAAmount: bn(quoteIsTokenA ? post.quoteReserve : post.wrapperReserve),
    tokenBAmount: bn(quoteIsTokenA ? post.wrapperReserve : post.quoteReserve),
  };
}

function projectedUtilization(
  cpAmm: CpAmm,
  context: RouteContext,
  quote: Quote2Result,
  allocation: bigint,
  swapInput: bigint,
  wrapperBudget: bigint,
  addLiquiditySlippageBps: number,
): { quoteBps: bigint; wrapperBps: bigint } {
  const quoteBudget = allocation - swapInput;
  if (wrapperBudget <= 0n || quoteBudget <= 0n) {
    throw new Error(context.market.id + ": swap leaves no budget for liquidity");
  }
  const projected = projectedPoolAfterSwap(context, quote);
  const aIsQuote = projected.tokenAMint.equals(context.quoteMint);
  const budgetA = aIsQuote ? quoteBudget : wrapperBudget;
  const budgetB = aIsQuote ? wrapperBudget : quoteBudget;
  const safety = BigInt(10_000 - addLiquiditySlippageBps);
  const liquidityDelta = cpAmm.getLiquidityDelta({
    maxAmountTokenA: requireU64(budgetA * safety / 10_000n, "projected LP A"),
    maxAmountTokenB: requireU64(budgetB * safety / 10_000n, "projected LP B"),
    sqrtPrice: projected.sqrtPrice,
    sqrtMinPrice: projected.sqrtMinPrice,
    sqrtMaxPrice: projected.sqrtMaxPrice,
    collectFeeMode: projected.collectFeeMode as CollectFeeMode,
    tokenAAmount: projected.tokenAAmount,
    tokenBAmount: projected.tokenBAmount,
    liquidity: projected.liquidity,
  });
  if (liquidityDelta.isZero()) {
    throw new Error(context.market.id + ": quote would leave no positive LP liquidity");
  }
  const expected = estimatedDeposit(projected, liquidityDelta);
  const quoteDeposit = aIsQuote ? expected.tokenA : expected.tokenB;
  const wrapperDeposit = aIsQuote ? expected.tokenB : expected.tokenA;
  if (quoteDeposit > quoteBudget || wrapperDeposit > wrapperBudget) {
    throw new Error(context.market.id + ": projected LP exceeds route budget");
  }
  return {
    quoteBps: utilizationBps(quoteDeposit, quoteBudget),
    wrapperBps: utilizationBps(wrapperDeposit, wrapperBudget),
  };
}

async function chooseSwapInput(
  connection: Connection,
  cpAmm: CpAmm,
  context: RouteContext,
  allocation: bigint,
  swapSlippageBps: number,
  configuredBps: number | null,
): Promise<bigint> {
  if (allocation < 3n) throw new Error(context.market.id + ": allocation is too small to swap and LP");
  const fallbackBps = configuredBps ?? 5_000;
  const fallback = allocation * BigInt(fallbackBps) / 10_000n;
  if (configuredBps !== null) {
    if (fallback <= 0n || fallback >= allocation) throw new Error("swap input rounds to zero/full allocation");
    return fallback;
  }
  let low = 1n;
  let high = allocation - 1n;
  let best: bigint | null = null;
  let bestGap: bigint | null = null;
  const compounding = context.poolState.collectFeeMode === CollectFeeMode.Compounding;
  const quoteIsTokenA = context.poolState.tokenAMint.equals(context.quoteMint);
  const quoteReserve = BigInt((quoteIsTokenA
    ? context.poolState.tokenAAmount : context.poolState.tokenBAmount).toString());
  const wrapperReserve = BigInt((quoteIsTokenA
    ? context.poolState.tokenBAmount : context.poolState.tokenAAmount).toString());
  const currentPoint = await getCurrentPoint(connection, context.poolState.activationType);
  for (let iteration = 0; low <= high && iteration < 64; iteration++) {
    const candidate = (low + high) / 2n;
    try {
      const quote = await quoteSwap(connection, cpAmm, context, candidate, swapSlippageBps, currentPoint);
      if (quote.outputAmount.isZero()) {
        low = candidate + 1n;
        continue;
      }
      const remaining = allocation - candidate;
      let signedGap: bigint;
      if (compounding) {
        signedGap = compoundingDepositGap(
          quoteReserve, wrapperReserve, allocation, candidate,
          quoteAmounts(quote),
          quoteIsTokenA,
        );
      } else {
        const deposit = cpAmm.getDepositQuote({
          inAmount: quote.outputAmount,
          isTokenA: context.poolState.tokenAMint.equals(context.wrapperMint),
          minSqrtPrice: context.poolState.sqrtMinPrice,
          maxSqrtPrice: context.poolState.sqrtMaxPrice,
          sqrtPrice: quote.nextSqrtPrice,
          collectFeeMode: context.poolState.collectFeeMode as CollectFeeMode,
          tokenAAmount: context.poolState.tokenAAmount,
          tokenBAmount: context.poolState.tokenBAmount,
          liquidity: context.poolState.liquidity,
        });
        signedGap = remaining - BigInt(deposit.outputAmount.toString());
      }
      const gap = signedGap < 0n ? -signedGap : signedGap;
      if (bestGap === null || gap < bestGap) {
        best = candidate;
        bestGap = gap;
      }
      // In compounding mode a positive gap means overbuying wrapper. For
      // concentrated pools, a negative gap means the LP needs more quote.
      if (compounding ? signedGap > 0n : signedGap < 0n) high = candidate - 1n;
      else low = candidate + 1n;
    } catch {
      // A candidate can exceed the pool's swap range. Keep a viable quote.
      high = candidate - 1n;
    }
  }
  if (best === null || best <= 0n || best >= allocation) {
    throw new Error("no viable quote/wrapper swap split");
  }
  return best;
}

async function signForJournal(
  connection: Connection,
  transaction: Transaction,
  signer: Keypair,
  minSolLamports: bigint,
): Promise<SignedTx> {
  const block = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = signer.publicKey;
  transaction.recentBlockhash = block.blockhash;
  const fee = await connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
  if (fee.value === null) throw new Error("RPC could not estimate this transaction fee");
  const balance = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
  if (balance - BigInt(fee.value) < minSolLamports) {
    throw new Error("transaction fee would breach the signer SOL gas reserve");
  }
  transaction.sign(signer);
  const signature = transaction.signature;
  if (!signature) throw new Error("signed transaction has no signature");
  return {
    signature: encodeBase58(signature),
    rawBase64: transaction.serialize().toString("base64"),
    blockhash: block.blockhash,
    lastValidBlockHeight: block.lastValidBlockHeight,
  };
}

function encodeBase58(signature: Buffer): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = BigInt("0x" + signature.toString("hex"));
  let encoded = "";
  while (number > 0n) {
    encoded = alphabet[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  for (const byte of signature) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded;
}

function signatureBase58(signed: SignedTx): string {
  const signature = Transaction.from(Buffer.from(signed.rawBase64, "base64")).signature;
  if (!signature || encodeBase58(signature) !== signed.signature) {
    throw new Error("journal signature does not match signed transaction bytes");
  }
  return signed.signature;
}

async function confirmSigned(connection: Connection, signed: SignedTx): Promise<string> {
  const signature = signatureBase58(signed);
  const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
  if (status?.err) throw new Error("transaction " + signature + " failed: " + JSON.stringify(status.err));
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
  if (!status && await connection.getBlockHeight("confirmed") > signed.lastValidBlockHeight) {
    throw new Error("transaction " + signature + " expired without a confirmed status; inspect chain before retry");
  }
  try {
    await connection.sendRawTransaction(Buffer.from(signed.rawBase64, "base64"), {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (error) {
    const again = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (!again || again.err) throw error;
  }
  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash: signed.blockhash,
    lastValidBlockHeight: signed.lastValidBlockHeight,
  }, "confirmed");
  if (confirmation.value.err) throw new Error("transaction " + signature + " failed: " + JSON.stringify(confirmation.value.err));
  return signature;
}

async function tokenDelta(
  connection: Connection,
  signature: string,
  tokenAccount: PublicKey,
  mint: PublicKey,
): Promise<bigint> {
  const transaction = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!transaction?.meta) throw new Error("cannot read confirmed token deltas for " + signature);
  const meta = transaction.meta;
  const keys = transaction.transaction.message.getAccountKeys().staticAccountKeys;
  const index = keys.findIndex((key) => key.equals(tokenAccount));
  if (index < 0) throw new Error("token account missing from confirmed transaction");
  function amount(entries: typeof meta.preTokenBalances): bigint {
    const entry = entries?.find((item) => item.accountIndex === index && item.mint === mint.toBase58());
    if (!entry) throw new Error("missing token balance metadata for " + tokenAccount.toBase58());
    return BigInt(entry.uiTokenAmount.amount);
  }
  return amount(meta.postTokenBalances) - amount(meta.preTokenBalances);
}

async function requireGasReserve(connection: Connection, owner: PublicKey, minimum: bigint): Promise<void> {
  const lamports = BigInt(await connection.getBalance(owner, "confirmed"));
  if (lamports <= minimum) {
    throw new Error("signer SOL balance must stay above " + minimum + " lamports for gas");
  }
}

async function settleRoute(
  connection: Connection,
  cpAmm: CpAmm,
  plan: LaunchPlan,
  receipts: Record<string, PoolReceipt>,
  route: FeeAllocation,
  creator: PublicKey,
  signer: Keypair | null,
  run: RunJournal,
  journal: SettlementJournal,
  options: Options,
): Promise<void> {
  let state = run.routes[route.market];
  if (state && state.allocationRaw !== route.amount.toString()) {
    throw new Error(route.market + ": journal allocation differs from requested claim amount");
  }
  if (state?.phase === "done") {
    console.log(route.market + ": already settled; swap " + signatureBase58(state.swapTx) +
      ", LP " + signatureBase58(state.lpTx!) + "; leftover " +
      state.quoteLeftoverRaw + " quote and " + state.wrapperLeftoverRaw + " wrapper");
    return;
  }
  if (state?.phase === "needs-rebalance") {
    throw new Error(route.market + ": LP settled below minimum utilization; recorded leftovers are " +
      state.quoteLeftoverRaw + " quote and " + state.wrapperLeftoverRaw +
      " wrapper. Review this batch before starting another settlement");
  }
  if (state && !options.execute) {
    console.log(route.market + ": journal phase " + state.phase +
      "; dry run will not rebroadcast or advance this route");
    return;
  }
  const context = await loadRouteContext(connection, cpAmm, plan, receipts, route, creator);
  const wsolAta = route.quote === "wsol" ? context.quoteAta : null;
  if (!state) {
    const quoteAccount = await getAccount(connection, context.quoteAta, "confirmed", TOKEN_PROGRAM_ID);
    if (quoteAccount.amount < route.amount) {
      throw new Error(route.market + ": quote ATA has less than its explicit allocation");
    }
    const swapInput = await chooseSwapInput(
      connection,
      cpAmm,
      context,
      route.amount,
      plan.feeZap.swapSlippageBps!,
      plan.feeZap.swapInputBps,
    );
    const quote = await quoteSwap(connection, cpAmm, context, swapInput, plan.feeZap.swapSlippageBps!);
    const operatorFloor = options.minWrapperOutRaw[route.market] ?? 0n;
    const expectedOut = BigInt(quote.outputAmount.toString());
    if (!quote.minimumAmountOut) throw new Error(route.market + ": SDK omitted minimum wrapper output");
    if (operatorFloor > expectedOut) {
      throw new Error(route.market + ": live quote is below the operator's minimum wrapper output");
    }
    const sdkFloor = BigInt(quote.minimumAmountOut.toString());
    const minOut = bn(operatorFloor > sdkFloor ? operatorFloor : sdkFloor);
    if (minOut.isZero()) throw new Error(route.market + ": minimum wrapper output is zero");
    const utilization = worstCaseProjectedUtilization(
      expectedOut,
      BigInt(minOut.toString()),
      (wrapperBudget) => projectedUtilization(
        cpAmm, context, quote, route.amount, swapInput, wrapperBudget,
        plan.feeZap.addLiquiditySlippageBps!,
      ),
    );
    console.log(route.market + ": allocation " + route.amount + " raw " + route.quote +
      "; swap " + swapInput + " for expected " + quote.outputAmount +
      " wrapper (minimum " + minOut + "); reserve " + (route.amount - swapInput) +
      " quote for LP; worst-case projected utilization " + utilization.quoteBps +
      " bps quote / " + utilization.wrapperBps + " bps wrapper");
    if (!options.execute) return;
    if (utilization.quoteBps < BigInt(options.minLpUtilizationBps) ||
        utilization.wrapperBps < BigInt(options.minLpUtilizationBps)) {
      throw new Error(route.market + ": projected LP utilization is below --min-lp-utilization-bps " +
        options.minLpUtilizationBps + "; no swap was submitted");
    }
    await requireGasReserve(connection, creator, options.minSolLamports);
    const sdkTx = await cpAmm.swap2({
      payer: creator,
      pool: context.pool,
      inputTokenMint: context.quoteMint,
      outputTokenMint: context.wrapperMint,
      tokenAMint: context.poolState.tokenAMint,
      tokenBMint: context.poolState.tokenBMint,
      tokenAVault: context.poolState.tokenAVault,
      tokenBVault: context.poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
      swapMode: SwapMode.ExactIn,
      amountIn: bn(swapInput),
      minimumAmountOut: minOut,
      poolState: context.poolState,
    });
    const instruction = onlyDammInstruction(sdkTx, {
      owner: creator,
      quoteMint: context.quoteMint,
      wrapperMint: context.wrapperMint,
      quoteAta: context.quoteAta,
      wrapperAta: context.wrapperAta,
      wsolAta,
    });
    const signed = await signForJournal(
      connection, new Transaction().add(instruction), signer!, options.minSolLamports,
    );
    state = {
      phase: "swap-submitted",
      allocationRaw: route.amount.toString(),
      swapInputRaw: swapInput.toString(),
      minimumWrapperOutRaw: minOut.toString(),
      swapTx: signed,
    };
    run.routes[route.market] = state;
    await saveJournal(options.settlementPath, journal);
  }
  if (state.phase === "swap-submitted") {
    const signature = await confirmSigned(connection, state.swapTx);
    const [quoteChange, wrapperChange] = await Promise.all([
      tokenDelta(connection, signature, context.quoteAta, context.quoteMint),
      tokenDelta(connection, signature, context.wrapperAta, context.wrapperMint),
    ]);
    if (quoteChange !== -BigInt(state.swapInputRaw) ||
        wrapperChange < BigInt(state.minimumWrapperOutRaw)) {
      throw new Error(route.market + ": confirmed swap token deltas differ from signed allocation");
    }
    state.wrapperReceivedRaw = wrapperChange.toString();
    state.phase = "swapped";
    await saveJournal(options.settlementPath, journal);
    console.log(route.market + ": swap confirmed " + signature + "; received " + wrapperChange + " wrapper");
  }
  if (state.phase === "swapped") {
    const wrapperBudget = BigInt(state.wrapperReceivedRaw!);
    const quoteBudget = route.amount - BigInt(state.swapInputRaw);
    const refreshed = await loadRouteContext(connection, cpAmm, plan, receipts, route, creator);
    const [quoteAccount, wrapperAccount] = await Promise.all([
      getAccount(connection, refreshed.quoteAta, "confirmed", TOKEN_PROGRAM_ID),
      getAccount(connection, refreshed.wrapperAta, "confirmed", TOKEN_PROGRAM_ID),
    ]);
    if (quoteAccount.amount < quoteBudget || wrapperAccount.amount < wrapperBudget) {
      throw new Error(route.market + ": allocated balances were spent before LP");
    }
    const aIsQuote = refreshed.poolState.tokenAMint.equals(refreshed.quoteMint);
    const budgetA = aIsQuote ? quoteBudget : wrapperBudget;
    const budgetB = aIsQuote ? wrapperBudget : quoteBudget;
    const safety = BigInt(10_000 - plan.feeZap.addLiquiditySlippageBps!);
    const usableA = budgetA * safety / 10_000n;
    const usableB = budgetB * safety / 10_000n;
    const liquidityDelta = cpAmm.getLiquidityDelta({
      maxAmountTokenA: requireU64(usableA, "LP usable A"),
      maxAmountTokenB: requireU64(usableB, "LP usable B"),
      sqrtPrice: refreshed.poolState.sqrtPrice,
      sqrtMinPrice: refreshed.poolState.sqrtMinPrice,
      sqrtMaxPrice: refreshed.poolState.sqrtMaxPrice,
      collectFeeMode: refreshed.poolState.collectFeeMode as CollectFeeMode,
      tokenAAmount: refreshed.poolState.tokenAAmount,
      tokenBAmount: refreshed.poolState.tokenBAmount,
      liquidity: refreshed.poolState.liquidity,
    });
    if (liquidityDelta.isZero()) {
      throw new Error(route.market + ": swap succeeded but allocation is too small for positive LP; keep this run ID for recovery");
    }
    const estimated = estimatedDeposit(refreshed.poolState, liquidityDelta);
    const expectedQuote = aIsQuote ? estimated.tokenA : estimated.tokenB;
    const expectedWrapper = aIsQuote ? estimated.tokenB : estimated.tokenA;
    if (expectedQuote > quoteBudget || expectedWrapper > wrapperBudget) {
      throw new Error(route.market + ": quoted LP deposit exceeds this route's budget");
    }
    const predictedQuoteUtilization = utilizationBps(expectedQuote, quoteBudget);
    const predictedWrapperUtilization = utilizationBps(expectedWrapper, wrapperBudget);
    if (predictedQuoteUtilization < BigInt(options.minLpUtilizationBps) ||
        predictedWrapperUtilization < BigInt(options.minLpUtilizationBps)) {
      throw new Error(route.market + ": LP would use only " + predictedQuoteUtilization +
        " bps of quote and " + predictedWrapperUtilization +
        " bps of wrapper; minimum is " + options.minLpUtilizationBps +
        ". Swap is confirmed; retain this run ID and rebalance or adjust the pool before LP");
    }
    console.log(route.market + ": add liquidity " + liquidityDelta + " with maxima A=" + budgetA + " B=" + budgetB);
    await requireGasReserve(connection, creator, options.minSolLamports);
    const sdkTx = await cpAmm.addLiquidity({
      owner: creator,
      position: new PublicKey(refreshed.receipt.position),
      pool: refreshed.pool,
      positionNftAccount: new PublicKey(refreshed.receipt.positionNftAccount),
      liquidityDelta,
      maxAmountTokenA: requireU64(budgetA, "LP budget A"),
      maxAmountTokenB: requireU64(budgetB, "LP budget B"),
      tokenAAmountThreshold: requireU64(budgetA, "LP threshold A"),
      tokenBAmountThreshold: requireU64(budgetB, "LP threshold B"),
      tokenAMint: refreshed.poolState.tokenAMint,
      tokenBMint: refreshed.poolState.tokenBMint,
      tokenAVault: refreshed.poolState.tokenAVault,
      tokenBVault: refreshed.poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
    });
    const instruction = onlyDammInstruction(sdkTx, {
      owner: creator,
      quoteMint: refreshed.quoteMint,
      wrapperMint: refreshed.wrapperMint,
      quoteAta: refreshed.quoteAta,
      wrapperAta: refreshed.wrapperAta,
      wsolAta: route.quote === "wsol" ? refreshed.quoteAta : null,
    });
    state.lpTx = await signForJournal(
      connection, new Transaction().add(instruction), signer!, options.minSolLamports,
    );
    state.liquidityDeltaRaw = liquidityDelta.toString();
    state.phase = "lp-submitted";
    await saveJournal(options.settlementPath, journal);
  }
  if (state.phase === "lp-submitted") {
    const signature = await confirmSigned(connection, state.lpTx!);
    const [quoteChange, wrapperChange] = await Promise.all([
      tokenDelta(connection, signature, context.quoteAta, context.quoteMint),
      tokenDelta(connection, signature, context.wrapperAta, context.wrapperMint),
    ]);
    const quoteBudget = route.amount - BigInt(state.swapInputRaw);
    const wrapperBudget = BigInt(state.wrapperReceivedRaw!);
    if (quoteChange >= 0n || wrapperChange >= 0n ||
        -quoteChange > quoteBudget || -wrapperChange > wrapperBudget) {
      throw new Error(route.market + ": LP token deltas exceed the claimed allocation");
    }
    const quoteDeposited = -quoteChange;
    const wrapperDeposited = -wrapperChange;
    const quoteLeftover = quoteBudget - quoteDeposited;
    const wrapperLeftover = wrapperBudget - wrapperDeposited;
    state.quoteDepositedRaw = quoteDeposited.toString();
    state.wrapperDepositedRaw = wrapperDeposited.toString();
    state.quoteLeftoverRaw = quoteLeftover.toString();
    state.wrapperLeftoverRaw = wrapperLeftover.toString();
    const actualQuoteUtilization = utilizationBps(quoteDeposited, quoteBudget);
    const actualWrapperUtilization = utilizationBps(wrapperDeposited, wrapperBudget);
    state.phase = actualQuoteUtilization >= BigInt(options.minLpUtilizationBps) &&
      actualWrapperUtilization >= BigInt(options.minLpUtilizationBps)
      ? "done" : "needs-rebalance";
    await saveJournal(options.settlementPath, journal);
    console.log(route.market + ": LP confirmed " + signature +
      "; deposited " + state.quoteDepositedRaw + " quote and " +
      state.wrapperDepositedRaw + " wrapper; leftover " +
      state.quoteLeftoverRaw + " quote and " + state.wrapperLeftoverRaw + " wrapper");
    if (state.phase === "needs-rebalance") {
      throw new Error(route.market + ": LP utilization fell below the required " +
        options.minLpUtilizationBps + " bps; batch remains open for review");
    }
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const plan = buildLaunchPlan(await readJson<unknown>(options.configPath));
  assertPlan(plan);
  const creator = new PublicKey(plan.creator);
  const signer = options.keypairPath ? await loadKeypair(options.keypairPath) : null;
  if (signer && !signer.publicKey.equals(creator)) {
    throw new Error("keypair public key does not match config.creator");
  }
  const receipts = await readJson<Record<string, PoolReceipt>>(options.receiptsPath);
  const planHash = fingerprint(plan, receipts);
  const connection = new Connection(plan.rpcUrl, "confirmed");
  const cpAmm = new CpAmm(connection);
  let lock: Awaited<ReturnType<typeof open>> | null = null;
  const lockPath = resolve(options.settlementPath) + ".lock";
  if (options.execute) {
    lock = await open(lockPath, "wx", 0o600).catch(() => {
      throw new Error("settlement lock exists; verify no other settlement is running: " + lockPath);
    });
  }
  try {
    const journal = await readJournal(options.settlementPath);
    let claimSources: ClaimSource[] = [];
    if (!options.manual) {
      const claimJournal = await readJson<unknown>(options.claimJournalPath!);
      const selected = selectClaimSources(claimJournal, options.claimRunIds, plan);
      assertClaimSourcesUnused(journal, options.runId, selected.selection.sources);
      await verifyClaimSourcesOnChain(connection, selected.receipts, plan);
      options.wsolRaw = selected.selection.wsolRaw;
      options.usdcRaw = selected.selection.usdcRaw;
      claimSources = selected.selection.sources;
      console.log("Verified DBC claims: " + claimSources.map((source) => source.id + "=" + source.signature).join(", "));
    } else {
      console.log("Manual fee amounts: reconcile DBC claim deltas and source-account transfers before execution");
    }
    if (options.wsolRaw > 0n && plan.feeZap.minimumWsolClaimRaw !== null &&
        options.wsolRaw < BigInt(plan.feeZap.minimumWsolClaimRaw)) {
      throw new Error("claimed WSOL is below feeZap.minimumWsolClaimRaw");
    }
    if (options.usdcRaw > 0n && plan.feeZap.minimumUsdcClaimRaw !== null &&
        options.usdcRaw < BigInt(plan.feeZap.minimumUsdcClaimRaw)) {
      throw new Error("claimed USDC is below feeZap.minimumUsdcClaimRaw");
    }
    const routes = splitClaimedFees(options.wsolRaw, options.usdcRaw);
    const bounds = marketBounds(options, routes);
    let run = journal[options.runId];
    if (run) {
      if (run.creator !== plan.creator || run.rpcUrl !== plan.rpcUrl ||
          run.wsolRaw !== options.wsolRaw.toString() || run.usdcRaw !== options.usdcRaw.toString() ||
          run.planFingerprint !== planHash ||
          run.minLpUtilizationBps !== options.minLpUtilizationBps ||
          JSON.stringify(run.marketBoundsRaw) !== JSON.stringify(bounds) ||
          (run.sourceMode ?? "manual") !== (options.manual ? "manual" : "claims") ||
          JSON.stringify(run.claimSources ?? []) !== JSON.stringify(claimSources)) {
        throw new Error("run ID already exists with different plan, receipts, execution bounds, or claimed amounts");
      }
    } else {
      run = {
        creator: plan.creator,
        rpcUrl: plan.rpcUrl,
        sourceMode: options.manual ? "manual" : "claims",
        claimSources,
        wsolRaw: options.wsolRaw.toString(),
        usdcRaw: options.usdcRaw.toString(),
        marketBoundsRaw: bounds,
        minLpUtilizationBps: options.minLpUtilizationBps,
        planFingerprint: planHash,
        routes: {},
      };
      journal[options.runId] = run;
      if (options.execute) {
        for (const [quote, amount] of [["wsol", options.wsolRaw], ["usdc", options.usdcRaw]] as const) {
          if (amount === 0n) continue;
          const mint = new PublicKey(plan.quoteMints[quote]!);
          const ata = getAssociatedTokenAddressSync(mint, creator, false, TOKEN_PROGRAM_ID);
          const account = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
          if (account.amount < amount) {
            throw new Error(quote + " ATA has less than the explicitly claimed amount");
          }
        }
        await saveJournal(options.settlementPath, journal);
      }
    }
    for (const route of routes) {
      await settleRoute(connection, cpAmm, plan, receipts, route, creator, signer, run, journal, options);
    }
    if (!options.execute) console.log("Dry run only. Pass --execute --keypair FILE to sign.");
  } finally {
    if (lock) {
      await lock.close();
      await unlink(lockPath);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
