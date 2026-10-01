import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Keypair, PublicKey } from '@solana/web3.js'
import { analyzeStatic, isActiveHookProgram, USDC_MINT, WSOL_MINT } from '../src/preflight.js'

function validPlan(): Record<string, unknown> {
  const plan = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')) as Record<string, unknown>
  const tokens = plan.tokens as Array<Record<string, unknown>>
  for (const token of tokens) {
    token.hookProgramId = Keypair.generate().publicKey.toBase58()
    token.configAddress = Keypair.generate().publicKey.toBase58()
    token.baseMint = Keypair.generate().publicKey.toBase58()
    token.creator = Keypair.generate().publicKey.toBase58()
    token.feeClaimer = Keypair.generate().publicKey.toBase58()
    token.mintAuthorityPolicy = 'retained-partner'
    token.tokenAuthorityOption = 4
    token.creatorTradingFeePercentage = 0
  }
  return plan
}

test('the two planned DBCs bind to WSOL and mainnet USDC and derive distinct wrappers', () => {
  const result = analyzeStatic(validPlan())
  assert.deepEqual(result.issues.filter((item) => item.level !== 'info'), [])
  assert.notEqual(result.wrapperMints.long, result.wrapperMints.short)
})

test('rejects a swapped quote or wrong USDC mint before any launch', () => {
  const plan = validPlan()
  const tokens = plan.tokens as Array<Record<string, unknown>>
  tokens[0].quoteMint = USDC_MINT.toBase58()
  tokens[1].quoteMint = WSOL_MINT.toBase58()
  const result = analyzeStatic(plan)
  assert.equal(result.issues.filter((item) => item.path.endsWith('.quoteMint') && item.level === 'error').length, 2)
})

test('devnet uses the explicit configured USDC-like mint while WSOL stays canonical', () => {
  const plan = validPlan()
  const tokens = plan.tokens as Array<Record<string, unknown>>
  const devnetUsdc = Keypair.generate().publicKey.toBase58()
  plan.cluster = 'devnet'
  plan.devnetUsdcMint = devnetUsdc
  tokens[1].quoteMint = devnetUsdc
  assert.equal(analyzeStatic(plan).issues.some((item) => item.level === 'error'), false)
  tokens[1].quoteMint = USDC_MINT.toBase58()
  assert.equal(analyzeStatic(plan).issues.some((item) => item.path.endsWith('.quoteMint') && item.level === 'error'), true)
})

test('rejects hook program reentry and accidental quote/base fee mode changes', () => {
  const plan = validPlan()
  const tokens = plan.tokens as Array<Record<string, unknown>>
  tokens[0].hookProgramId = plan.wrapperProgramId
  tokens[0].collectFeeMode = 1
  tokens[1].migrationOption = 0
  const paths = analyzeStatic(plan).issues.filter((item) => item.level === 'error').map((item) => item.path)
  assert(paths.includes('tokens[0].hookProgramId'))
  assert(paths.includes('tokens[0].collectFeeMode'))
  assert(paths.includes('tokens[1].migrationOption'))
})

test('retained mint authority must match DBC authority option', () => {
  const plan = validPlan()
  const tokens = plan.tokens as Array<Record<string, unknown>>
  tokens[0].mintAuthorityPolicy = 'retained-creator'
  assert(analyzeStatic(plan).issues.some((item) => item.path === 'tokens[0].mintAuthorityPolicy' && item.level === 'error'))
  tokens[0].tokenAuthorityOption = 3
  assert.equal(analyzeStatic(plan).issues.some((item) => item.path === 'tokens[0].mintAuthorityPolicy' && item.level === 'error'), false)
})

test('revoked Token-2022 hook program ID is represented by the default pubkey', () => {
  assert.equal(isActiveHookProgram(PublicKey.default), false)
  assert.equal(isActiveHookProgram(null), false)
  assert.equal(isActiveHookProgram(Keypair.generate().publicKey), true)
})
