import assert from "node:assert/strict";
import test from "node:test";
import {
  compoundingDepositGap,
  parseClaimedRaw,
  splitClaimedFees,
  utilizationBps,
  worstCaseProjectedUtilization,
} from "../src/fees.js";

test("fee claims are split by quote asset and routed to both wrapper markets", () => {
  assert.deepEqual(splitClaimedFees(100n, 101n), [
    { market: "long-wsol", quote: "wsol", amount: 50n },
    { market: "short-wsol", quote: "wsol", amount: 50n },
    { market: "long-usdc", quote: "usdc", amount: 50n },
    { market: "short-usdc", quote: "usdc", amount: 51n },
  ]);
});

test("zero input creates no route and one raw unit stays explicit", () => {
  assert.deepEqual(splitClaimedFees(0n, 0n), []);
  assert.deepEqual(splitClaimedFees(1n, 0n), [
    { market: "short-wsol", quote: "wsol", amount: 1n },
  ]);
});

test("raw claim amounts reject imprecise JSON numbers and overflow", () => {
  assert.equal(parseClaimedRaw("18446744073709551615", "claim"), (1n << 64n) - 1n);
  assert.throws(() => parseClaimedRaw("18446744073709551616", "claim"), /exceeds u64/);
  assert.throws(() => parseClaimedRaw("1.5", "claim"), /unsigned integer string/);
  assert.throws(() => parseClaimedRaw("-1", "claim"), /unsigned integer string/);
});

test("compounding swap match uses post-swap reserves instead of a fixed half", () => {
  const gap = (swapInput: bigint, quoteIsTokenA: boolean) => {
    const outputAmount = 1_000n * swapInput / (1_000n + swapInput);
    return compoundingDepositGap(1_000n, 1_000n, 1_000n, swapInput, {
      excludedFeeInputAmount: swapInput,
      outputAmount,
      claimingFee: 0n,
      compoundingFee: 0n,
      protocolFee: 0n,
      referralFee: 0n,
    }, quoteIsTokenA);
  };
  for (const quoteIsTokenA of [true, false]) {
    assert.ok(gap(414n, quoteIsTokenA) < 0n);
    assert.ok(gap(415n, quoteIsTokenA) > 0n);
    assert.ok(gap(500n, quoteIsTokenA) > 0n);
  }
});

test("compounding fee reserve changes and LP utilization are explicit", () => {
  const amounts = {
    excludedFeeInputAmount: 500n,
    outputAmount: 300n,
    claimingFee: 10n,
    compoundingFee: 5n,
    protocolFee: 5n,
    referralFee: 0n,
  };
  assert.equal(compoundingDepositGap(1_000n, 1_000n, 1_000n, 500n, amounts, true),
    300n * 1_500n - 500n * 685n);
  assert.equal(compoundingDepositGap(1_000n, 1_000n, 1_000n, 500n, amounts, false),
    300n * 1_505n - 500n * 700n);
  assert.equal(utilizationBps(990n, 1_000n), 9_900n);
  assert.throws(() => utilizationBps(1_001n, 1_000n), /invalid LP utilization/);
});

test("LP preflight checks the permitted minimum swap output, not only expected output", () => {
  const evaluated: bigint[] = [];
  const quoteBudget = 100n;
  const utilization = worstCaseProjectedUtilization(100n, 80n, (wrapperBudget) => {
    evaluated.push(wrapperBudget);
    // A 1:1 LP can pair only the smaller of the quote and wrapper budgets.
    const paired = quoteBudget < wrapperBudget ? quoteBudget : wrapperBudget;
    return {
      quoteBps: utilizationBps(paired, quoteBudget),
      wrapperBps: utilizationBps(paired, wrapperBudget),
    };
  });
  assert.deepEqual(evaluated, [100n, 80n]);
  assert.deepEqual(utilization, { quoteBps: 8_000n, wrapperBps: 10_000n });
  assert.ok(utilization.quoteBps < 9_000n);
  assert.throws(
    () => worstCaseProjectedUtilization(100n, 0n, () => ({ quoteBps: 10_000n, wrapperBps: 10_000n })),
    /invalid minimum wrapper output/,
  );
});
