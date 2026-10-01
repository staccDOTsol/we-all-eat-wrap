import { createHash } from 'node:crypto'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey, type Transaction, type TransactionInstruction } from '@solana/web3.js'

export type ClaimShare = 'partner' | 'creator'

export function quoteOnlyClaimLimits(maxQuoteAmount: bigint): { maxBaseAmount: bigint; maxQuoteAmount: bigint } {
  if (maxQuoteAmount <= 0n || maxQuoteAmount > (1n << 64n) - 1n) {
    throw new Error('max quote claim must be a positive u64 raw amount')
  }
  return { maxBaseAmount: 0n, maxQuoteAmount }
}

function discriminator(share: ClaimShare): Buffer {
  const name = share === 'partner' ? 'claim_trading_fee2' : 'claim_creator_trading_fee2'
  return createHash('sha256').update('global:' + name).digest().subarray(0, 8)
}

// The SDK closes its WSOL ATA after a claim, converting the entire account to
// native SOL. We retain only its DBC instruction so preexisting WSOL stays put.
// Both ATAs must already exist before this function is called.
export function onlyClaimInstruction(
  transaction: Transaction,
  share: ClaimShare,
  signer: PublicKey,
  baseAta: PublicKey,
  quoteAta: PublicKey,
  isWsol: boolean,
): TransactionInstruction {
  const claims = transaction.instructions.filter((ix) => ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
  if (claims.length !== 1 || !claims[0].data.subarray(0, 8).equals(discriminator(share))) {
    throw new Error('expected exactly one matching DBC claim2 instruction')
  }
  for (const ix of transaction.instructions) {
    if (ix === claims[0]) continue
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && ix.data[0] === 1) {
      if (!ix.keys[0]?.pubkey.equals(signer) || !ix.keys[2]?.pubkey.equals(signer) ||
          ![baseAta, quoteAta].some((ata) => ix.keys[1]?.pubkey.equals(ata))) {
        throw new Error('unexpected DBC SDK ATA helper')
      }
      continue
    }
    if (isWsol && ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 9 &&
        ix.keys[0]?.pubkey.equals(quoteAta) &&
        ix.keys[1]?.pubkey.equals(signer) &&
        ix.keys[2]?.pubkey.equals(signer)) {
      continue
    }
    throw new Error('unexpected DBC SDK helper instruction ' + ix.programId.toBase58())
  }
  return claims[0]
}

export interface SignedClaimExpectation {
  share: ClaimShare
  signer: PublicKey
  config: PublicKey
  pool: PublicKey
  baseMint: PublicKey
  quoteMint: PublicKey
  baseAta: PublicKey
  quoteAta: PublicKey
  baseVault: PublicKey
  quoteVault: PublicKey
  maxQuoteAmount: bigint
  poolAuthority: PublicKey
}

export function validateSignedClaim(transaction: Transaction, expected: SignedClaimExpectation): void {
  if (!transaction.verifySignatures(true)) throw new Error('journal transaction has an invalid signature')
  if (!transaction.feePayer?.equals(expected.signer) ||
      transaction.signatures.length !== 1 ||
      !transaction.signatures[0].publicKey.equals(expected.signer)) {
    throw new Error('journal transaction signer or fee payer differs from claim authority')
  }
  if (transaction.instructions.length !== 1) throw new Error('journal must contain one DBC claim instruction')
  const ix = transaction.instructions[0]
  if (!ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) ||
      !ix.data.subarray(0, 8).equals(discriminator(expected.share)) ||
      ix.data.length < 24 ||
      ix.data.readBigUInt64LE(8) !== 0n ||
      ix.data.readBigUInt64LE(16) !== expected.maxQuoteAmount) {
    throw new Error('journal claim instruction or quote-only cap differs from current plan')
  }
  const core = expected.share === 'partner'
    ? [
        expected.poolAuthority, expected.config, expected.pool, expected.baseAta,
        expected.quoteAta, expected.baseVault, expected.quoteVault,
        expected.baseMint, expected.quoteMint, expected.signer,
        TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
      ]
    : [
        expected.poolAuthority, expected.pool, expected.baseAta,
        expected.quoteAta, expected.baseVault, expected.quoteVault,
        expected.baseMint, expected.quoteMint, expected.signer,
        TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
      ]
  for (let index = 0; index < core.length; index++) {
    if (!ix.keys[index]?.pubkey.equals(core[index])) {
      throw new Error('journal claim account ' + index + ' differs from current plan')
    }
  }
  const authorityIndex = expected.share === 'partner' ? 9 : 8
  if (!ix.keys[authorityIndex]?.isSigner) {
    throw new Error('journal claim authority account is not a signer')
  }
}
