# Hooked DBC launch preflight

This directory checks the two proposed DBC launches before any transaction is
broadcast. The `long` DBC is quoted in WSOL; the `short` DBC is quoted in USDC.
Both base mints are Token-2022 with a transfer hook, and this fork wraps each
into an ordinary SPL Token mint. The external five-market plan is in
[`../launch/README.md`](../launch/README.md).

No private keys belong in this directory. The checked-in JSON is a template;
the `null` fields are decisions or addresses still needed. `preflight` reads
accounts only. `claim-fees` can sign a quote-only claim after the DBC pools
exist, but never signs unless explicitly invoked with `--execute --keypair`.

## Run

```sh
cd dbc
npm install
cp config.example.json config.local.json
npm run preflight -- --config config.local.json
npm run preflight -- --config config.local.json --rpc https://api.mainnet-beta.solana.com
```

Use `cluster: "devnet"` for a rehearsal. Set `devnetUsdcMint` to the devnet
USDC-like mint you have selected, and set the short token's `quoteMint` to that
same address. WSOL remains `So11111111111111111111111111111111111111112`.
Mainnet requires Circle's canonical
`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` USDC mint. The RPC
check verifies quote mint existence, Tokenkeg ownership, and decimals; the
config check binds the DBC quote to the specified mint. Solana notes that
devnet and mainnet token addresses differ and that USDC-like symbols alone are
not proof of identity ([Solana production readiness](https://solana.com/docs/tools/production-readiness)).

Exit code `0` means the configured accounts passed all checks. `2` means
expected setup is still pending. `1` means a mismatch or invalid plan. Without
`--rpc`, chain checks remain pending. The wrapper addresses printed by the CLI
are deterministic PDAs, not deployed accounts. When `--rpc` is present, the
preflight compares the RPC's genesis hash with the configured mainnet or devnet
cluster before reading any account
([Solana `getGenesisHash`](https://solana.com/docs/rpc/http/getgenesishash)).

## Sequence and exact checks

1. Choose curve economics with the current Meteora SDK, including a finite
   `migrationQuoteThreshold`, supply parameters, fee schedule, migrated DAMM v2
   fee settings, and any first-buy behavior. Build and validate the curve with
   the SDK. This preflight checks the identity and policy fields in the JSON;
   it does **not** replace curve math or `validateConfigParameters`. The design
   aims to keep both pools active on DBC, so choose a threshold that is
   economically unlikely to be reached, then rehearse a completion anyway.
   The threshold is a nonzero `u64` of raw quote units and must be reachable
   within the configured curve for DBC to accept the config. It cannot be set
   to infinity or beyond the curve's quote capacity merely to disable
   migration.
2. Deploy a **separate executable hook program** and the wrapper fork. A DBC
   transfer-hook config cannot name the DBC program or either SPL Token program
   as the hook. The hook must also differ from the wrapper program so the
   underlying transfer cannot reenter that program indirectly.
3. Generate each DBC config keypair outside the repo. Call
   `client.partner.createConfigWithTransferHook` with the selected quote mint,
   hook program, fee claimer, `tokenType = 1`, `collectFeeMode = 0` (quote
   only), and `migrationOption = 1` (DAMM v2). Separate WSOL and USDC quote
   mints require separate configs. Record each public `configAddress` in the
   local JSON. The preflight decodes the resulting `ConfigWithTransferHook`
   account and compares all those fields, including the creator fee share and
   mint-authority option.
4. Generate each **base mint keypair** outside the repo. Call
   `client.creator.createPoolWithTransferHook` with its matching config,
   `baseMint`, `poolCreator`, metadata, payer, and the same hook program. The
   on-chain `initialize_virtual_pool_with_token2022_transfer_hook` instruction
   initializes the Token-2022 mint, metadata pointer, hook extension, base and
   quote vaults, and `TransferHookPool` **atomically**. The mint does not exist
   as a separately pre-created account. Its initial supply is minted into the
   DBC base vault. The preflight derives the expected pool PDA from quote mint,
   base mint, and config; checks its transfer-hook discriminator, creator and
   base type; and reads the quote vault to confirm the actual quote mint.
5. Initialize the hook's `ExtraAccountMetaList` PDA for the **now-created** base
   mint, using the hook program's own initialization instruction. Check that the
   list is owned by the hook program. Do this before any swap or wrapper
   transfer that moves the base token. A first buy can be bundled only if its
   transaction places the meta-list initialization **between** the DBC pool
   instruction and buy instruction. Meteora's SDK test explicitly inserts it
   there; the plain first-buy builder does not create your hook's list for you.
6. Initialize each ordinary SPL wrapper mint using this fork. The preflight
   derives the `mint` PDA from the base mint and Tokenkeg program, then checks
   legacy SPL ownership, decimals, and the fork's mint-authority PDA. Wrap
   enough base tokens to seed the five DAMM v2 markets.

After both base mints exist, copy `tokens[id=long].baseMint` and
`tokens[id=short].baseMint` into `launch/config.local.json` fields
`dbc.longBaseMint` and `dbc.shortBaseMint`. Copy the short token's `quoteMint`
into `quotes.usdcMint`, and keep the same `wrapperProgramId` in both files.
The DBC config addresses are checked here; the external DAMM v2 pool configs
in `launch/` are different accounts.

The current DBC source requires base decimals from 6 through 9, two viable fee
schedule modes (`0` linear or `1` exponential), a nonzero migration quote
threshold, a valid curve, and migration liquidity shares totaling 100%.
Rate-limiter configs and new DAMM v1 migrations are rejected. The preflight
checks the fields it can read from the config and mint; run a full SDK curve
validation before config creation. Sources:
[DBC config validation](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/f552f20aa3c1c7631427c3827aeea7c58b902813/programs/dynamic-bonding-curve/src/instructions/partner/create_config/process_create_config.rs),
[transfer-hook pool initialization](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/f552f20aa3c1c7631427c3827aeea7c58b902813/programs/dynamic-bonding-curve/src/instructions/initialize_pool/ix_initialize_virtual_pool_with_token2022_transfer_hook.rs),
[SDK hook-pool tests](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/a28b7239e71899eb52ff7aacac4dec90441885c4/packages/dynamic-bonding-curve/tests/transferHook.test.ts).

## Mint authority and wrapper economics

The template uses `mintAuthorityPolicy: "retained-partner"` and
`tokenAuthorityOption: 4` for both DBCs, retaining mint authority in each
config's `feeClaimer` address. `feeClaimer` remains `null` until the specific
partner/strategy authority public key is chosen. Option `3` instead retains
mint authority for the pool creator; use
`mintAuthorityPolicy: "retained-creator"` with that option.
Options `0`, `1`, and `2` leave mint authority unset; use
`mintAuthorityPolicy: "none"` with one of them. The preflight checks this
choice against the on-chain mint authority. This is separate from DBC's
optional `tokenSupply` parameters that set pre/post-migration supply levels.

With no wrapper supply, this fork initially mints wrapper units 1:1 against
base tokens deposited into escrow. Thereafter it uses **escrowed base reserve
divided by wrapper supply**, rounding down, on both wrap and unwrap. Reserve
donations therefore change the redemption rate. Retaining base mint authority
allows further base minting outside the DBC's initial mint, changing total
supply and the market economics of both the base and wrapper. A NAV or
leverage model must account for both the mint authority and this reserve/supply
exchange rate. If no post-launch minting is intended, keep a non-mint-authority
option. The DBC pool creation code sets the final mint authority according to this enum
([source](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/f552f20aa3c1c7631427c3827aeea7c58b902813/programs/dynamic-bonding-curve/src/instructions/initialize_pool/process_initialize_virtual_pool_with_token2022.rs)).

## Fees and curve-completion contingency

Quote-only mode (`collectFeeMode: 0`) makes active-curve trading fee claims
come out in the quote mint. DBC takes its protocol share first; the config's
`creatorTradingFeePercentage` divides the claimable trading share between the
creator and partner. The partner claim requires the configured `feeClaimer`
signer; a nonzero creator share also requires the pool creator signer for its
claim. SDK 1.5.13 uses `claimPartnerTradingFee2` and
`claimCreatorTradingFee2` for transfer-hook pools, with `maxBaseAmount = 0`
for a quote-only sweep. If the two signers differ, the fee keeper must collect
both streams before splitting the received quote 50/50 between that quote
asset's two wrapper markets. The resulting route is swap part of each
allocation for that market's wrapper, then add the wrapper and remaining quote
as DAMM v2 liquidity. The LP position NFT owner must authorize additions.
The cross-wrapper market is seeded separately. See
[DBC fee claims](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk/blob/a28b7239e71899eb52ff7aacac4dec90441885c4/packages/dynamic-bonding-curve/CHANGELOG.md)
and [`../launch/README.md`](../launch/README.md).

If `feeClaimer` is a strategy PDA, an ordinary off-chain SDK transaction
cannot sign as it. A strategy program must invoke the DBC claim with its PDA
signer seeds. Until that exists, an off-chain fee settlement tool can begin
only with quote assets that have already been claimed to a wallet it controls.

### Claim quote trading fees after launch

The `claim-fees` command claims **one share from one DBC pool per run**. It
calls the SDK's `claimPartnerTradingFee2` or `claimCreatorTradingFee2`,
always sets `maxBaseAmount = 0`, and caps the quote claim at the smaller of
the pool's currently recorded claimable fee and `--max-quote-raw` (default:
u64 maximum). It validates the configured cluster, transfer-hook pool,
config, Token-2022 base mint, classic SPL quote mint, vaults, creator and
partner authority, and both receiver token accounts before building a
transaction.

The partner command requires the **configured fee claimer keypair**. The
creator command requires the **pool creator keypair**. If the two authorities
are different, run them separately with different IDs and keypairs. A PDA
fee claimer cannot use this CLI; its owning strategy program must sign the
DBC claim through CPI.

Create the signer's associated Token-2022 base token account and classic SPL
quote account first. The base account is required by the DBC instruction even
though the base claim cap is zero. For WSOL, the SDK normally closes the
quote account and unwraps **its entire balance** to native SOL after claiming.
This command checks and removes that helper instruction, retaining the
existing WSOL account so the exact new WSOL balance can be measured. It also
removes only verified idempotent account-creation helpers because both token
accounts must already exist.

```sh
cd dbc

# Read live state, verify accounts, and build a claim; send nothing:
npm run claim-fees -- --config config.local.json --rpc YOUR_RPC \
  --token long --share partner --run LONG_PARTNER_CLAIM_001

# Claim the partner share after reviewing the dry run:
npm run claim-fees -- --config config.local.json --rpc YOUR_RPC \
  --token long --share partner --run LONG_PARTNER_CLAIM_001 \
  --execute --keypair /absolute/path/to/fee-claimer.json

# If creator fees are nonzero, claim them with the creator authority:
npm run claim-fees -- --config config.local.json --rpc YOUR_RPC \
  --token long --share creator --run LONG_CREATOR_CLAIM_001 \
  --execute --keypair /absolute/path/to/creator.json
```

Repeat for the Short/USDC DBC. Use a distinct `--run` ID for each claim and
the **same** ID when retrying it. The command records each signed transaction
before broadcast in the private `claim-receipts.json` journal. On retry it
checks its signature, DBC claim instruction, pool and token accounts against
the unchanged config before resending that exact transaction. A changed
config, RPC URL, or lower `--max-quote-raw` cap rejects the retry; use the
original settings to inspect its status. An expired signature without a
confirmed status requires manual chain inspection. Its output includes the
confirmed quote ATA balance delta in raw units. If the recipient differs from
the creator that owns DAMM v2 LP positions, transfer only those newly claimed
quote units to the creator's quote ATA. Sum partner and creator deltas for
each quote mint, then pass the totals as `--claimed-wsol-raw` and
`--claimed-usdc-raw` to `../launch/`'s `settle-fees` command.

The claim command spends SOL only for its transaction fee and maintains a
default 50,000,000 lamport gas reserve. It does not claim DAMM v2 position
fees or DBC migration fees. No on-chain claim has been executed for the
unlaunched mints in this plan.

The design intends neither curve to finish, but a high threshold is no
guarantee against it. As a contingency, the swap that
finishes a transfer-hook DBC curve revokes **both** the mint's
hook program ID and transfer-hook authority before DAMM v2 migration. After
that swap, transfers of the original base mint, including wrapper wrap/unwrap,
no longer execute the hook. Any strategy depending on the hook must define its
post-bonding behavior separately. The preflight accepts a revoked hook only
when the DBC pool has left pre-bonding state
([DBC swap source](https://github.com/MeteoraAg/dynamic-bonding-curve/blob/f552f20aa3c1c7631427c3827aeea7c58b902813/programs/dynamic-bonding-curve/src/instructions/swap/process_swap.rs)).
