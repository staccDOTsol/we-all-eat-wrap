import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { isActiveHook, parseDbcSourcePlan } from '../src/dbc-source.js';
import { buildLaunchPlan, MAINNET_USDC_MINT } from '../src/plan.js';

async function fixtures(): Promise<{ launchConfig: Record<string, any>; dbcConfig: Record<string, any> }> {
  const launchConfig = JSON.parse(await readFile(resolve('config.example.json'), 'utf8')) as Record<string, any>;
  const dbcConfig = JSON.parse(await readFile(resolve('../dbc/config.example.json'), 'utf8')) as Record<string, any>;
  launchConfig.quotes.usdcMint = MAINNET_USDC_MINT;
  for (const token of dbcConfig.tokens as Array<Record<string, any>>) {
    token.baseMint = Keypair.generate().publicKey.toBase58();
    token.configAddress = Keypair.generate().publicKey.toBase58();
    token.hookProgramId = Keypair.generate().publicKey.toBase58();
    token.creator = Keypair.generate().publicKey.toBase58();
    token.feeClaimer = Keypair.generate().publicKey.toBase58();
    token.creatorTradingFeePercentage = 0;
    launchConfig.dbc[`${token.id}BaseMint`] = token.baseMint;
  }
  return { launchConfig, dbcConfig };
}

test('pool creation source must bind the exact planned DBC bases, quotes, hooks and wrapper program', async () => {
  const { launchConfig, dbcConfig } = await fixtures();
  const source = parseDbcSourcePlan(dbcConfig, buildLaunchPlan(launchConfig));
  assert.equal(source.tokens.long.baseMint.toBase58(), launchConfig.dbc.longBaseMint);
  assert.equal(source.tokens.short.quoteMint.toBase58(), MAINNET_USDC_MINT);

  dbcConfig.tokens[0].baseMint = Keypair.generate().publicKey.toBase58();
  assert.throws(() => parseDbcSourcePlan(dbcConfig, buildLaunchPlan(launchConfig)), /baseMint differs/);
});

test('rejects wrapper-as-hook and missing partner mint authority policy', async () => {
  const { launchConfig, dbcConfig } = await fixtures();
  const launch = buildLaunchPlan(launchConfig);
  dbcConfig.tokens[0].hookProgramId = launch.wrapperProgramId;
  assert.throws(() => parseDbcSourcePlan(dbcConfig, launch), /hookProgramId cannot/);
  dbcConfig.tokens[0].hookProgramId = Keypair.generate().publicKey.toBase58();
  dbcConfig.tokens[0].tokenAuthorityOption = 3;
  assert.throws(() => parseDbcSourcePlan(dbcConfig, launch), /tokenAuthorityOption must be 4/);
});

test('devnet requires matching explicitly selected USDC mint', async () => {
  const { launchConfig, dbcConfig } = await fixtures();
  const selected = Keypair.generate().publicKey.toBase58();
  launchConfig.cluster = 'devnet';
  launchConfig.quotes.usdcMint = selected;
  dbcConfig.cluster = 'devnet';
  dbcConfig.devnetUsdcMint = selected;
  dbcConfig.tokens[1].quoteMint = selected;
  assert.equal(parseDbcSourcePlan(dbcConfig, buildLaunchPlan(launchConfig)).tokens.short.quoteMint.toBase58(), selected);
  dbcConfig.devnetUsdcMint = Keypair.generate().publicKey.toBase58();
  assert.throws(() => parseDbcSourcePlan(dbcConfig, buildLaunchPlan(launchConfig)), /devnet USDC mint differs/);
});

test('revoked Token-2022 hook program ID is not active', () => {
  assert.equal(isActiveHook(PublicKey.default), false);
  assert.equal(isActiveHook(null), false);
  assert.equal(isActiveHook(Keypair.generate().publicKey), true);
});
