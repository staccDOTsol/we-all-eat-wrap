# Two-pool power-transfer math

This standalone Rust crate implements the **user-selected power-loss rule**
for a pair of long and short collateral pools. It is pure `no_std` arithmetic
with no external dependencies, so the core can later be called from a Solana
program. It does not move any tokens today.

For a positive oracle move from `P0` to `P1`, SHORT retains approximately
`SHORT × (P0/P1)^k`; the remainder moves to LONG. On a decline, LONG retains
approximately `LONG × (P1/P0)^k`; the remainder moves to SHORT. `k` is any
integer from 1 through 100,000. The exponentiation uses at most 34 Q64
multiplications instead of looping `k` times. Each loser retains **at least
one raw collateral unit**, and the transfer is subtracted from one side and
added to the other, preserving the total exactly. A reversal can therefore
replenish a side that fell to one unit. A round trip is path dependent and
does not generally restore the initial side balances.

Tracer's [Perpetual Pools litepaper](https://tracer.finance/static/Tracer%20Perpetual%20Pools-efc7c29f638cb788832aafe0f41c07bd.pdf) is the product reference. The pinned V2 contracts' [`getLossMultiplier` function](https://github.com/mycelium-ethereum/perpetual-pools-contracts/blob/48264d782859d59d04bcd3f7991576333c2c76f2/contracts/libraries/PoolSwapLibrary.sol#L203-L235) expresses the same power retention ratio as the user-selected rule above, but that helper has **no callers in the pinned V2 repository**. V2's active [`calculateValueTransfer` implementation](https://github.com/mycelium-ethereum/perpetual-pools-contracts/blob/48264d782859d59d04bcd3f7991576333c2c76f2/contracts/libraries/PoolSwapLibrary.sol#L241-L363) instead uses a sigmoid transfer and also charges fees. This crate matches the specified power rule and the unused V2 helper; it is **not** a port of V2's active settlement path.

## Run

```sh
cargo test --manifest-path strategy/Cargo.toml
cargo run --manifest-path strategy/Cargo.toml --example simulate
cargo run --manifest-path strategy/Cargo.toml --example simulate -- \
  100000 1000000000 1000000000 100 101 100
```

The simulator arguments are `POWER LONG_RAW SHORT_RAW PRICE0 PRICE1 [PRICE2 ...]`.
Prices must share one positive integer scale and each be at most
`1,000,000,000,000,000` raw units; only their ratio matters within that domain.
An oracle adapter must choose and consistently enforce a scale that fits this
ceiling without erasing the market moves the strategy is meant to observe.
Balances are raw units of the **same settlement mint** on both sides. The
current launch design quotes one DBC in WSOL and the other in USDC, so those
reserves cannot be transferred directly under this formula. A common
collateral vault or an explicit, bounded conversion would be needed.

## Arithmetic and limits

- Oracle prices and each collateral account are `u64`, but accepted prices are
  `1..=1,000,000,000,000,000`. Power is accepted only in `1..=100,000`.
  Out-of-domain inputs fail, including on flat-price updates.
- The price ratio and exponentiation use unsigned Q64 fixed point, rounded
  down. The retained collateral amount rounds **up**, then clamps to at least
  one raw unit. When extreme `k` makes the Q64 ratio underflow to zero, the
  one-unit floor remains in force.
- For any accepted `k`, the Q64 retention fraction understates the exact
  real-number fraction by **less than `2k / 2^64`**. Each floored square has
  less than one Q64 unit of local error; propagating and adding the errors for
  the set exponent bits gives this bound. Since a nonflat price move changes
  at least one raw tick and `price <= 10^15`, the ideal loss fraction is at
  least `k / (2 × 10^15)` throughout the accepted domain. Thus the Q64 error
  is less than `4 × 10^15 / 2^64`, or **0.022% of the ideal loss fraction**,
  before rounding collateral to raw units. In absolute units, the Q64 error
  can still be as large as `losing_balance × 2k / 2^64`; final raw-unit
  rounding and the one-unit floor add their own effects.
- If adding the transfer would overflow the winner's `u64` balance, the
  calculation returns an error. Both inputs are unchanged.
- The Q64 ratio and each multiplication round down, biasing retention
  downward and transfer upward. Rounding the final raw retained balance up
  partly offsets this. At extremes, the one-unit floor biases transfer
  downward.
  Repeated updates can accumulate these differences; an on-chain monetary
  implementation needs an explicit error budget and rounding-policy review.
  The tests assert conservation, direction, overflow rejection, large powers,
  one-unit floors, and recovery after reversals.

Oracle authentication, staleness checks, update cadence, collateral custody,
tokenized share minting and redemption, and the link from these balances to
the five DAMM v2 markets are **not implemented**. The one-unit floor guarantees
only that a side's vault remains positive. It does **not** guarantee a
nonzero redemption for an individual share: if outstanding shares exceed the
side's raw collateral units, an individual redemption may round to zero. A
future mint/redeem design must define share units, rounding, and fees.
