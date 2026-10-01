import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import { buildLaunchPlan, MAINNET_USDC_MINT, MARKET_IDS } from '../src/plan.js';

async function template(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(resolve('config.example.json'), 'utf8')) as Record<string, any>;
}

test('unlaunched DBC mints leave exact five-pool plan pending', async () => {
  const plan = buildLaunchPlan(await template());
  assert.deepEqual(plan.markets.map(({ id }) => id), MARKET_IDS);
  assert.equal(plan.wrapperMints.long, null);
  assert.equal(plan.wrapperMints.short, null);
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.feeRoutes.map(({ destinations }) => destinations), [
    ['long-wsol', 'short-wsol'],
    ['long-usdc', 'short-usdc'],
  ]);
  assert.equal(plan.markets.every(({ pool }) => pool === null), true);
});

test('after base mints and seed inputs are known all PDAs resolve', async () => {
  const config = await template();
  config.rpcUrl = 'https://example.invalid';
  config.creator = Keypair.generate().publicKey.toBase58();
  config.dbc.longBaseMint = Keypair.generate().publicKey.toBase58();
  config.dbc.shortBaseMint = Keypair.generate().publicKey.toBase58();
  config.quotes.usdcMint = MAINNET_USDC_MINT;
  for (const market of Object.values(config.markets) as any[]) {
    market.config = Keypair.generate().publicKey.toBase58();
    for (const asset of Object.keys(market.seedRaw)) market.seedRaw[asset] = '1000000';
  }
  const plan = buildLaunchPlan(config);
  assert.equal(plan.ready, true);
  assert.notEqual(plan.wrapperMints.long, plan.wrapperMints.short);
  assert.equal(plan.markets.every(({ pool, missing }) => pool !== null && missing.length === 0), true);
  assert.equal(new Set(plan.markets.map(({ pool }) => pool)).size, 5);
});

test('mainnet requires canonical USDC; devnet accepts an explicit selected mint', async () => {
  const config = await template();
  config.quotes.usdcMint = Keypair.generate().publicKey.toBase58();
  assert.throws(() => buildLaunchPlan(config), /canonical USDC/);
  config.cluster = 'devnet';
  assert.equal(buildLaunchPlan(config).quoteMints.usdc, config.quotes.usdcMint);
});

test('rejects duplicate mints and imprecise numeric seed amounts', async () => {
  const config = await template();
  config.dbc.longBaseMint = config.quotes.wsolMint;
  assert.throws(() => buildLaunchPlan(config), /must be different mints/);
  config.dbc.longBaseMint = null;
  config.markets['long-wsol'].seedRaw.wsol = 1000000;
  assert.throws(() => buildLaunchPlan(config), /positive integer string/);
});
