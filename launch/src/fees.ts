import type { MarketId } from "./plan.js";

const U64_MAX = (1n << 64n) - 1n;

export interface FeeAllocation {
  market: MarketId;
  quote: "wsol" | "usdc";
  amount: bigint;
}

export function parseClaimedRaw(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(label + " must be an unsigned integer string in raw units");
  }
  const amount = BigInt(value);
  if (amount > U64_MAX) throw new Error(label + " exceeds u64");
  return amount;
}

export function splitClaimedFees(wsolRaw: bigint, usdcRaw: bigint): FeeAllocation[] {
  if (wsolRaw < 0n || usdcRaw < 0n || wsolRaw > U64_MAX || usdcRaw > U64_MAX) {
    throw new Error("claimed amounts must be unsigned u64 values");
  }
  const wsolLong = wsolRaw / 2n;
  const usdcLong = usdcRaw / 2n;
  const allocations: FeeAllocation[] = [
    { market: "long-wsol", quote: "wsol", amount: wsolLong },
    { market: "short-wsol", quote: "wsol", amount: wsolRaw - wsolLong },
    { market: "long-usdc", quote: "usdc", amount: usdcLong },
    { market: "short-usdc", quote: "usdc", amount: usdcRaw - usdcLong },
  ];
  return allocations.filter((allocation) => allocation.amount > 0n);
}

export interface CompoundingSwapAmounts {
  excludedFeeInputAmount: bigint;
  outputAmount: bigint;
  claimingFee: bigint;
  compoundingFee: bigint;
  protocolFee: bigint;
  referralFee: bigint;
}

// The SDK's compounding swap quote reports the fee split used to update pool
// reserves; this mirrors that update without relying on spot price.
export function compoundingPostSwapReserves(
  quoteReserve: bigint,
  wrapperReserve: bigint,
  amounts: CompoundingSwapAmounts,
  quoteIsTokenA: boolean,
): { quoteReserve: bigint; wrapperReserve: bigint } {
  if (quoteReserve <= 0n || wrapperReserve <= 0n || amounts.outputAmount <= 0n) {
    throw new Error('invalid compounding swap or reserves');
  }
  // Compounding mode charges fees on the output for A->B, and on the input
  // for B->A. Only the compounding fee remains in token B reserves.
  const outputFees = quoteIsTokenA
    ? amounts.claimingFee + amounts.compoundingFee + amounts.protocolFee + amounts.referralFee
    : 0n;
  const nextQuoteReserve = quoteReserve + amounts.excludedFeeInputAmount +
    (quoteIsTokenA ? 0n : amounts.compoundingFee);
  const nextWrapperReserve = wrapperReserve - amounts.outputAmount - outputFees +
    (quoteIsTokenA ? amounts.compoundingFee : 0n);
  if (nextQuoteReserve <= 0n || nextWrapperReserve <= 0n) {
    throw new Error('compounding quote exhausts pool reserves');
  }
  return { quoteReserve: nextQuoteReserve, wrapperReserve: nextWrapperReserve };
}

// Positive means the swap bought more wrapper than the remaining quote can LP.
export function compoundingDepositGap(
  quoteReserve: bigint,
  wrapperReserve: bigint,
  allocation: bigint,
  swapInput: bigint,
  amounts: CompoundingSwapAmounts,
  quoteIsTokenA: boolean,
): bigint {
  if (swapInput <= 0n || swapInput >= allocation) {
    throw new Error('invalid compounding swap or reserves');
  }
  const post = compoundingPostSwapReserves(
    quoteReserve, wrapperReserve, amounts, quoteIsTokenA,
  );
  return amounts.outputAmount * post.quoteReserve -
    (allocation - swapInput) * post.wrapperReserve;
}

export function utilizationBps(deposited: bigint, budget: bigint): bigint {
  if (budget <= 0n || deposited < 0n || deposited > budget) {
    throw new Error('invalid LP utilization amounts');
  }
  return deposited * 10_000n / budget;
}

export interface PairUtilization {
  quoteBps: bigint;
  wrapperBps: bigint;
}

// At fixed projected pool state, the smaller swap output can leave quote
// underused, while the larger output can leave wrapper underused. Check both.
export function worstCaseProjectedUtilization(
  expectedWrapperOut: bigint,
  minimumWrapperOut: bigint,
  project: (wrapperBudget: bigint) => PairUtilization,
): PairUtilization {
  if (minimumWrapperOut <= 0n || minimumWrapperOut > expectedWrapperOut) {
    throw new Error("invalid minimum wrapper output for LP preview");
  }
  const atExpected = project(expectedWrapperOut);
  const atMinimum = minimumWrapperOut === expectedWrapperOut
    ? atExpected
    : project(minimumWrapperOut);
  return {
    quoteBps: atExpected.quoteBps < atMinimum.quoteBps
      ? atExpected.quoteBps : atMinimum.quoteBps,
    wrapperBps: atExpected.wrapperBps < atMinimum.wrapperBps
      ? atExpected.wrapperBps : atMinimum.wrapperBps,
  };
}
