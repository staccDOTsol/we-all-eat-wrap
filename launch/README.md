# Two DBCs, two SPL wrappers, five DAMM v2 markets

This directory plans and creates the external DAMM v2 markets. The DBC base
mints do not exist yet, so the checked-in config leaves their addresses and all
liquidity amounts empty. Nothing here creates the DBC pools or invokes the
transfer hooks.

## Topology

| Source | Quote on DBC | Classic SPL wrapper | DAMM v2 markets |
| --- | --- | --- | --- |
| Long Token-2022 hook mint | WSOL | Long wrapper | Long/WSOL, Long/USDC |
| Short Token-2022 hook mint | USDC | Short wrapper | Short/WSOL, Short/USDC |
| Both wrappers | — | — | Long/Short |

There are no base/wrapper DAMM v2 pools in this active-hook plan. DAMM v2
can admit a hooked Token-2022 mint through a badge or suitable private config,
but its pool creation, swap, and liquidity transfers do not forward the extra
accounts needed by our proposed reserve-moving hook. A base/wrapper pool
would therefore fail to transfer that token. The wrapper/base conversion path
is the Token Wrap program itself. These five DAMM pools are independent of
DBC's configured migration target and do not require either DBC to complete.
The DBC configs still have finite, reachable migration thresholds, so curve
completion remains a contingency to handle. See DAMM v2's
[mint admission](https://github.com/MeteoraAg/damm-v2/blob/a85c926607433f23f0ea60f4ca7b1ae92f4156cb/programs/cp-amm/src/utils/token.rs#L223-L289)
and [transfer helper](https://github.com/MeteoraAg/damm-v2/blob/a85c926607433f23f0ea60f4ca7b1ae92f4156cb/programs/cp-amm/src/utils/token.rs#L157-L185).

The two wrapper mint addresses are deterministic PDAs of this fork's Token Wrap
program, each DBC base mint, and the legacy SPL Token program ID. `plan` derives
them as soon as the base mint addresses are known. The wrapper program ID in
`config.example.json` is the ID currently declared by this fork; replace it if
the deployed fork uses another ID.

## Run

```sh
cd launch
npm install
cp config.example.json config.local.json
npm run plan -- --config config.local.json
```

The initial plan shows all five pairs with missing inputs. After both DBCs
launch, fill in:

- the two Token-2022 base mint addresses;
- the actual USDC mint on the selected cluster;
- the RPC URL and creator wallet public key;
- one **public static** DAMM v2 config address per market (the same config may
  be reused where appropriate);
- initial token amounts for each pair as **raw integer units in JSON strings**.

The script rejects numeric JSON amounts to avoid JavaScript precision loss.
No seed amounts, prices, or config addresses are assumed here. The initial
price of each pool comes from its two seed amounts, in the token order displayed
by `plan`.

Before building pools, deploy the wrapper fork, initialize both classic SPL
wrapper mints via the fork's CLI, wrap enough of each DBC token for the five
market seeds. Fund the creator with native SOL for the two WSOL pool seeds and
transaction rent/fees, and with USDC in its SPL token account for the USDC
seeds. The Meteora SDK wraps native SOL for each WSOL pool creation. The creation
script verifies that both DBC base mints are Token-2022 hook mints, each wrapper
is a classic SPL mint with the expected mint-authority PDA and matching
decimals, the quote mints are classic SPL, and the supplied DAMM v2 configs are
public static configs.

```sh
# Build all five creation transactions, report addresses, submit nothing:
npm run create-pools -- --config config.local.json

# Or isolate one market:
npm run create-pools -- --config config.local.json --market long-wsol

# Submit the five creation transactions, one at a time, with an explicit signer:
npm run create-pools -- --config config.local.json \
  --execute --keypair /absolute/path/to/solana-keypair.json
```

`--execute` writes `receipts.json` after each confirmed pool creation. The
receipt records pool, its actual on-chain token A/B mint order, position NFT
mint, position PDA, NFT account, signature, and time. It contains no secret
key. The builder matches each seed amount to the token A/B order it submits;
Meteora sorts mints for the pool PDA, and later transactions should use the
mint order recorded in pool state. The creator owns the initial DAMM v2
position NFT and must sign future liquidity additions, unless that NFT is
transferred to an authorized strategy PDA first. Existing pools are skipped.
Each pool creation is a separate transaction, so a partial five-pool launch is
possible; rerun after fixing any failure.

## Claimed fee route and liquidity zap

The two DBC quote fee streams stay in their original assets:

| Claimed quote | Split | Destination pools |
| --- | --- | --- |
| WSOL from Long/WSOL DBC | 50% / 50% | Long/WSOL and Short/WSOL |
| USDC from Short/USDC DBC | 50% / 50% | Long/USDC and Short/USDC |

For **each** pool allocation, `settle-fees` executes:

1. Take the **already claimed** quote balance delta supplied as a raw integer
   amount. Split it 50/50 by quote asset; if a raw unit is left over, it goes
   to the Short market for that quote.
2. Read the live DAMM v2 pool and quote an exact-input `swap2` from quote to
   that pool's wrapper. Search for the swap size closest to the projected
   post-swap deposit ratio, including the SDK's fee-adjusted reserve change
   for compounding pools. `feeZap.swapInputBps` explicitly overrides this
   search. The on-chain minimum wrapper output is the stricter of
   `feeZap.swapSlippageBps` and the operator's per-market output floor.
3. Execute the swap into the creator's SPL token accounts. Read the confirmed
   transaction's **actual token balance deltas**, then add only the received
   wrapper and this route's remaining quote to the creator-owned position.
   `feeZap.addLiquiditySlippageBps` leaves budget headroom in the calculated
   liquidity delta; on-chain token thresholds cap deposits at the route budget.
   Before the swap, the LP preview checks both the expected wrapper output
   and the minimum output permitted by the swap, using the lower utilization
   for each asset. The command requires at least 90% projected and actual utilization of
   **both** token budgets by default. Set `--min-lp-utilization-bps` from 5000
   to 10000 to choose another explicit threshold.
4. Record actual deposits and each route's leftover quote and wrapper in
   `settlements.json`. Leftovers remain in the creator's token accounts and
   are **not** automatically included in a later claim batch; reconcile them
   explicitly. Do not transfer quote directly to DAMM vaults; that does not
   create an LP position. Do not burn the quote allocation.

`feeZap.minimumWsolClaimRaw` and `feeZap.minimumUsdcClaimRaw` are optional
minimum claim thresholds. Set both slippage fields before running. The
Long/Short wrapper pool is seeded separately and receives no direct share in
this 50/50 quote-fee route.

### Run settlement after DBC fee claims

Claim the DBC creator/partner quote fees first using
[`../dbc/claim-fees`](../dbc/README.md#claim-quote-trading-fees-after-launch).
Receipt-backed mode reads one or more completed DBC claim run IDs from that
command's journal. Wait for each claim transaction to finalize. Settlement
verifies each signed quote-only DBC claim and its exact finalized quote-account
delta on chain, sums deltas by WSOL/USDC, and reserves
the claim signatures in `settlements.json`. The same signature cannot be used
by a second settlement run in that journal. This mode requires each claim to
have paid the DAMM position creator's quote ATA directly. The mints,
authorities, and destinations do not exist yet, so no live claim has been made.
The creator must also have its wrapper token accounts, own the position NFT
recorded in `receipts.json`, and retain SOL for transaction fees.

```sh
# Verify two finalized claims on chain and quote planned swaps; submit nothing:
npm run settle-fees -- --config config.local.json --run CLAIM_BATCH_ID \
  --claim-journal ../dbc/claim-receipts.json \
  --claim-run LONG_PARTNER_CLAIM_001 --claim-run SHORT_PARTNER_CLAIM_001

# Execute the four routes after reviewing the dry run:
# Set these four variables to independently calculated raw wrapper output floors.
npm run settle-fees -- --config config.local.json --run CLAIM_BATCH_ID \
  --claim-journal ../dbc/claim-receipts.json \
  --claim-run LONG_PARTNER_CLAIM_001 --claim-run SHORT_PARTNER_CLAIM_001 \
  --min-wrapper-out-long-wsol-raw "$MIN_LONG_WSOL_RAW" \
  --min-wrapper-out-short-wsol-raw "$MIN_SHORT_WSOL_RAW" \
  --min-wrapper-out-long-usdc-raw "$MIN_LONG_USDC_RAW" \
  --min-wrapper-out-short-usdc-raw "$MIN_SHORT_USDC_RAW" \
  --execute --keypair /absolute/path/to/solana-keypair.json
```

If a DBC claim paid a different signer, transfer its **newly claimed** quote
delta to the position creator's ATA, then use explicit manual mode. Manual mode
accepts operator-supplied raw amounts and cannot prove their DBC origin or
prevent an old claim from being counted again under a new settlement run ID:

```sh
npm run settle-fees -- --config config.local.json --run MANUAL_BATCH_ID \
  --manual --claimed-wsol-raw 1000000000 --claimed-usdc-raw 1000000
```

Add `--execute --keypair` and the relevant per-market `--min-wrapper-out-*-raw`
floors to execute a manual run. Reconcile claim receipts, transfers, existing
ATA balances, and prior settlement leftovers before doing so. Receipt reuse
protection applies only to runs kept in the same `settlements.json` journal.

Execution requires one positive raw wrapper output floor for **each active
market**. Set these from an independent fair-price reference for each wrapper
and quote asset, accounting for the chosen swap input and wrapper redemption
rate. The live DAMM quote alone is not a fair-price reference: a manipulated
pool can make a relative slippage limit accept an expensive trade. Dry run
shows the swap amount, expected output, and projected LP utilization; it does
not require the floors. A route is not submitted if its live quote is below
its floor or its projected utilization is below the configured threshold.

Use the same unique `--run` ID, amounts, output floors, utilization threshold,
plan, and pool receipts on a retry. The command writes a
private `settlements.json` journal before sending each signed swap and
liquidity transaction, checks confirmed signatures on restart, and never
signs a second swap for a recorded route. If a submitted signature expires
without a confirmed status, inspect the chain before changing the journal.
Each market is a separate two-transaction settlement: first swap, then add
liquidity. A failed LP step leaves the already swapped wrapper and quote in the
creator's accounts and can be retried with the same run ID. If actual LP
utilization falls below the threshold, the journal records `needs-rebalance`
and the remaining balances for operator review.

The Meteora SDK prepends idempotent token-account creation instructions on
every swap and LP transaction. For WSOL it also wraps fresh native SOL and
closes the WSOL account. This command first verifies that the relevant token
accounts exist, then checks and removes only those exact SDK helpers before
signing the DAMM v2 instruction. It spends the existing WSOL token account
and preserves unrelated native SOL. The default gas reserve is 50,000,000
lamports; `--min-sol-lamports` can raise it.

Avoid concurrent wallet activity during a run and keep both journals. Manual
mode relies on the operator's claim and transfer reconciliation; receipt-backed
mode checks the DBC claim transactions against the chain. No on-chain DBC claims
or settlements have been executed by this repository.

## Source APIs

- [Meteora DAMM v2 SDK](https://github.com/MeteoraAg/damm-v2-sdk)
- [Meteora DAMM v2 pool creation instructions](https://docs.meteora.ag/developer-guides/damm-v2/program/instructions)
- [Solana Token Wrap fork PDA derivation](../program/src/lib.rs)
