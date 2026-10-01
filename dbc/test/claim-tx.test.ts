import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { Keypair, Transaction, TransactionInstruction } from '@solana/web3.js'
import { onlyClaimInstruction, quoteOnlyClaimLimits, validateSignedClaim, type SignedClaimExpectation } from '../src/claim-tx.js'

function claimInstruction(name: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    keys: [],
    data: createHash('sha256').update('global:' + name).digest().subarray(0, 8),
  })
}

test('DBC limits always disable base-token claims', () => {
  assert.deepEqual(quoteOnlyClaimLimits(123n), { maxBaseAmount: 0n, maxQuoteAmount: 123n })
  assert.throws(() => quoteOnlyClaimLimits(0n), /positive u64/)
  assert.throws(() => quoteOnlyClaimLimits(1n << 64n), /positive u64/)
})

test('retains partner claim2 while dropping only expected WSOL close and ATA helpers', () => {
  const signer = Keypair.generate().publicKey
  const base = Keypair.generate().publicKey
  const quote = Keypair.generate().publicKey
  const baseAta = Keypair.generate().publicKey
  const quoteAta = Keypair.generate().publicKey
  const claim = claimInstruction('claim_trading_fee2')
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(signer, baseAta, signer, base, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(signer, quoteAta, signer, quote, TOKEN_PROGRAM_ID),
    claim,
    createCloseAccountInstruction(quoteAta, signer, signer),
  )
  assert.equal(onlyClaimInstruction(tx, 'partner', signer, baseAta, quoteAta, true), claim)
  assert.throws(() => onlyClaimInstruction(tx, 'creator', signer, baseAta, quoteAta, true), /matching/)
})

test('rejects WSOL closure targeting a different account', () => {
  const signer = Keypair.generate().publicKey
  const baseAta = Keypair.generate().publicKey
  const quoteAta = Keypair.generate().publicKey
  const other = Keypair.generate().publicKey
  const tx = new Transaction().add(
    claimInstruction('claim_creator_trading_fee2'),
    createCloseAccountInstruction(other, signer, signer),
  )
  assert.throws(() => onlyClaimInstruction(tx, 'creator', signer, baseAta, quoteAta, true), /unexpected/)
})

test('accepts a quote-only creator claim for USDC without SDK helpers', () => {
  const signer = Keypair.generate().publicKey
  const baseAta = Keypair.generate().publicKey
  const quoteAta = Keypair.generate().publicKey
  const claim = claimInstruction('claim_creator_trading_fee2')
  assert.equal(
    onlyClaimInstruction(new Transaction().add(claim), 'creator', signer, baseAta, quoteAta, false),
    claim,
  )
})

test('a signed journal claim is bound to pool, receiver, authority, and quote cap', () => {
  const signer = Keypair.generate()
  const random = () => Keypair.generate().publicKey
  const expected: SignedClaimExpectation = {
    share: 'partner',
    signer: signer.publicKey,
    config: random(),
    pool: random(),
    baseMint: random(),
    quoteMint: random(),
    baseAta: random(),
    quoteAta: random(),
    baseVault: random(),
    quoteVault: random(),
    maxQuoteAmount: 123n,
    poolAuthority: random(),
  }
  const data = Buffer.alloc(25)
  createHash('sha256').update('global:claim_trading_fee2').digest().copy(data, 0, 0, 8)
  data.writeBigUInt64LE(0n, 8)
  data.writeBigUInt64LE(expected.maxQuoteAmount, 16)
  const accounts = [
    expected.poolAuthority, expected.config, expected.pool, expected.baseAta,
    expected.quoteAta, expected.baseVault, expected.quoteVault,
    expected.baseMint, expected.quoteMint, expected.signer,
    TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  ]
  const instruction = new TransactionInstruction({
    programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    keys: accounts.map((pubkey, index) => ({
      pubkey,
      isSigner: index === 9,
      isWritable: index === 2 || index === 3 || index === 4,
    })),
    data,
  })
  const transaction = new Transaction().add(instruction)
  transaction.feePayer = signer.publicKey
  transaction.recentBlockhash = random().toBase58()
  transaction.sign(signer)
  assert.doesNotThrow(() => validateSignedClaim(transaction, expected))
  assert.throws(() => validateSignedClaim(transaction, { ...expected, pool: random() }), /account 2/)
  assert.throws(() => validateSignedClaim(transaction, { ...expected, quoteAta: random() }), /account 4/)
  assert.throws(() => validateSignedClaim(transaction, { ...expected, maxQuoteAmount: 122n }), /cap/)
  transaction.instructions[0].data.writeBigUInt64LE(1n, 8)
  assert.throws(() => validateSignedClaim(transaction, expected), /invalid signature/)
})
