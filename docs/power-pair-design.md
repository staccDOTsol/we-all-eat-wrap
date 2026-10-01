# Power pair: pricing and execution boundary

This is the Tracer-style **two-side collateral transfer** the two future DBC
launches are meant to express. It is not implemented by the wrapper fork or
the market scripts. In particular, a DBC curve, two wrappers, five DAMM v2
pools, and fee recycling alone do not create that exposure.

## What is priced today

| Asset | Native quote | USD reference while DBC remains active |
| --- | --- | --- |
| Long DBC base | WSOL | DBC long curve price in WSOL × independent SOL/USD price |
| Short DBC base | USDC | DBC short curve price in USDC × independent USDC/USD price |
| Either SPL wrapper | Its DBC base | Base price × `base tokens in wrapper escrow / wrappers outstanding` |

Each DAMM v2 market has its own traded price. Arbitrage may pull that price
toward the corresponding base and wrapper redemption prices, but pool price is
not a safe oracle for the strategy that trades the pool. This launch intends
to remain on DBC with a very high **finite** migration threshold. DBC requires
that threshold to be reachable within the curve, so continued bonding is an
operating assumption, not a protocol guarantee. If the curve completes, DBC
revokes the base mint's transfer hook. The wrapper
exchange rate still comes from its base escrow and wrapper supply.

Permissionless wrap/unwrap gives arbitrageurs a conversion path between each
base and wrapper. Therefore a strategy that trades only the five wrapper pools
cannot hold a wrapper price far from `DBC base price × wrapper exchange rate`.
To express the collateral move through traded prices while a DBC is active,
the strategy must also budget for moving that underlying DBC market, or define
an authorized supply policy. The static DBC curve is a traded price schedule,
not an oracle-driven power payoff.

## Tracer-style power transfer

Let `P0` and `P1` be successive values from an independent underlying oracle,
`k` the power-leverage setting, and `L` and `S` the **current collateral
balances** of the long and short sides in the same classic SPL mint. At each
rebalance:

```
if P1 > P0:
    move = S * (1 - (P0/P1)^k)
    S -= move; L += move
if P1 < P0:
    move = L * (1 - (P1/P0)^k)
    L -= move; S += move
```

The source side gives up **less than all** of its current balance for any
finite positive price move and finite `k`; the destination gains exactly what
the source loses, before fees. A reversal transfers from the new source side,
so the path matters. Starting from `L=S=100`, a +0.1% oracle move with
`k=1000` gives approximately `L=163.19, S=36.81`. A move back to the original
oracle price gives `L=60.07, S=139.93`: the short side rebounds about **3.80×
from its trough**, despite the oracle returning to its starting value. Higher
`k` can put the losing side much closer to zero and make the rebound multiple
much larger. Integer implementation must retain a minimum raw unit on each
side; otherwise rounding could permanently zero it.

With `L=S=100`, the winning side can hold at most 200 at that instant. That
does **not** cap a token holder's return from a later near-zero price: a side
that went from 100 to 0.1 can rebound hundreds or thousands of times. `k`
controls how aggressively value moves per oracle change; it does not promise
a particular traded-token return. The [Perpetual Pools power-loss helper](https://github.com/mycelium-ethereum/perpetual-pools-contracts/blob/48264d782859d59d04bcd3f7991576333c2c76f2/contracts/libraries/PoolSwapLibrary.sol#L204-L228)
contains this retention ratio, but that helper is unused in the pinned V2
repository. Its active `calculateValueTransfer` path uses a sigmoid and fees.
Our [pure math prototype](../strategy/README.md) implements the power rule
above, not that active V2 path.

Tracer makes its long and short tokens redeemable for each side's collateral,
so the vault balance per token is the price anchor. The present DBC base and
SPL wrapper tokens **do not** have that claim: the wrapper redeems only DBC
base tokens. If we keep the earlier choice of market-price exposure without a
collateral redemption right, a separate rebalancer must trade the DBC and
wrapper markets to make prices reflect the two vault balances. Finite
inventory means it cannot guarantee tracking. This pricing bridge remains the
core design and implementation gap.

## Where execution belongs

The Token-2022 transfer hook runs on transfers of a DBC **base** mint. It does
not run when a classic SPL wrapper trades on DAMM v2. A custom hook may use
Tokenkeg CPI to move classic SPL tokens from strategy-owned vaults if its
authority, mint, token program, vault, pool, and transfer direction are all
bound in state and verified. The transfer must be based on an absolute target
with a per-call cap, so repeated tiny base transfers cannot drain a vault.
The hook cannot reenter Token-2022 and cannot assume it will remain enabled
after the DBC curve completes.

The durable rebalance path is a separate top-level strategy/keeper instruction:
read the independent oracle and current same-mint collateral balances, apply
the transfer rule, then trade under explicit fair-price, inventory, and impact
limits to communicate that value to markets. It must account for both WSOL and
USDC in one unit of value when trading the DBCs and five wrapper markets. DBC
quote fees first require authorized fee claims; the current market tool starts
from already-claimed quote assets. Direct transfers into DAMM vaults do not
mint a position or update its tracked liquidity.

Before a hook can implement reserve moves, specify the shared classic SPL
collateral mint, exponent, independent oracle, reserve ownership, update
interval, minimum balance, per-call and epoch caps, and how vault NAV is
reflected in tradable DBC and wrapper prices. The two DBC quote mints may differ
from this shared collateral mint. Those choices define the token economics; a
generic hook cannot infer them from DBC transfers.
