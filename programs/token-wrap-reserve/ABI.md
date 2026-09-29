# Wire format v1

Program: `4mEQkdKdjZS7q4963gduWRVqtKhkqpWuAr6oh2GUeB35`.
Every instruction starts with eight ASCII bytes `TWRSIX01`, followed by the Borsh
variant tag (u8) and fields in the order below. Integers are little-endian, amounts
are unwrapped u64 units, addresses/nonces are 32 bytes. Trailing data is rejected.
`Fees` = five u16s: mint_bps, redeem_bps, transfer_bps, lp_bps, bid_bps. All fee
parameters are 0..10000 except transfer_bps which is 1..10000; lp_bps + bid_bps
must be less than 10000. The remainder burns. There is no configurable fee cap.

| Tag | Instruction | Fields |
| --- | --- | --- |
| 0 | CreateMint | nonce[32], Fees, amount u64, min_wrapped u64 |
| 1 | Wrap | amount u64, min_wrapped u64 |
| 2 | Unwrap | shares u64, min_unwrapped_received u64 |
| 3 | Harvest | none |
| 4 | ScheduleFees | Fees |

Use the Rust builders in `src/instruction.rs`. Builders use the fixed new ID and
correct account order; the existing CLI and IDL do not encode this ABI.

## Derived addresses

All use this program ID and canonical bump derivation.

- Config: `["config", creator, nonce]`
- Wrapped mint: `["wrapped", config]`
- Unwrapped reserve: `["reserve", config]`
- Locked seed account: `["locked", config]`
- LP fee account: `["lp", config]`
- Bid fee account: `["bids", config]`
- Fee collector: `["collector", config]`

The config is the mint/token/fee authority. Token vaults are owned by their token
program; their token owner is the config. The creator's initial output is the ATA
for creator + wrapped mint + Token-2022. Subsequent user token accounts need not be
ATAs but must have the correct mint and signing user owner.

## Accounts in exact order

`w` writable, `s` signer; unmarked accounts readonly. The transaction payer can be
separate from the user on Wrap/Unwrap/Harvest. CreateMint's creator signs and funds
account rent and the seed deposit. There is no signing authority on Harvest.

**CreateMint (16)**: creator(w,s), config(w), wrapped mint(w), unwrapped mint, user unwrapped source(w),
reserve(w), locked(w), lp(w), bids(w), collector(w), creator wrapped ATA(w), reward
mint, unwrapped token program, Token-2022 program, System program, ATA program.

**Wrap / Unwrap (12)**: user(s), config, wrapped mint(w), unwrapped mint, user unwrapped account(w),
reserve(w), user wrapped account(w), locked, lp(w), bids(w), unwrapped token program,
Token-2022 program. Wrap debits unwrapped and credits wrapped; Unwrap burns wrapped and
credits unwrapped. Neither instruction accepts an arbitrary recipient.

**Harvest (9..25)**: config, wrapped mint(w), unwrapped mint, reserve, locked, lp(w), bids(w),
collector(w), Token-2022 program, then up to 16 wrapped token accounts(w) with
withheld fees. An empty source list settles fees already harvested to the mint.

**ScheduleFees (4)**: creator(s), config(w), wrapped mint(w), Token-2022 program.

Readonly account identities can repeat where meaningful: reward mint may equal unwrapped
mint, and unwrapped program may equal Token-2022. Vault identities remain distinct and
canonical. Token program executables are validated, not just supplied as accounts.

## Config account layout

239 bytes, program-owned. Eight-byte `TWRSCFG1` discriminator, then Borsh fields:
version(u8 = 1), bump(u8), creator[32], nonce[32], unwrapped_mint[32], unwrapped_program[32],
wrapped_mint[32], reward_mint[32], decimals(u8), locked_shares(u64), current_fees(10
bytes), next_fees(10 bytes), effective_epoch(u64). Before effective_epoch use
current_fees; on/after it use next_fees. On initialization both policies are equal.

Discovery filters can use dataSize=239 and discriminator bytes at offset 0; the
creator is at offset 10, unwrapped mint at offset 74 and wrapped mint at offset 138.
Always verify owner, version, canonical PDA and the actual token/vault accounts
before calculating backing or building a transaction.
