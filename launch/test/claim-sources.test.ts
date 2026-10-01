import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import BN from "bn.js";
import {
  AccountsType,
  createDbcProgram,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveDbcEventAuthority,
  deriveDbcPoolAuthority,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  assertClaimSourcesUnused,
  selectClaimSources,
  verifyClaimSourcesOnChain,
} from "../src/claim-sources.js";
import type { LaunchPlan } from "../src/plan.js";

const creator = Keypair.generate();
const longBase = Keypair.generate().publicKey;
const shortBase = Keypair.generate().publicKey;
const usdc = Keypair.generate().publicKey;
const plan = {
  cluster: "devnet",
  creator: creator.publicKey.toBase58(),
  dbcBaseMints: { long: longBase.toBase58(), short: shortBase.toBase58() },
  quoteMints: { wsol: NATIVE_MINT.toBase58(), usdc: usdc.toBase58() },
} as LaunchPlan;

function base58(buffer: Buffer): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt("0x" + buffer.toString("hex"));
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  return encoded;
}

function makeClaim(tokenId: "long" | "short", share: "partner" | "creator", delta: bigint) {
  const signer = creator;
  const pool = Keypair.generate().publicKey;
  const quoteMint = tokenId === "long" ? NATIVE_MINT : usdc;
  const baseMint = tokenId === "long" ? longBase : shortBase;
  const quoteAta = getAssociatedTokenAddressSync(quoteMint, creator.publicKey, false, TOKEN_PROGRAM_ID);
  const keys = Array.from({ length: share === "partner" ? 14 : 13 }, () => ({
    pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true,
  }));
  const indices = share === "partner"
    ? { pool: 2, quoteAta: 4, baseMint: 7, quoteMint: 8, signer: 9 }
    : { pool: 1, quoteAta: 3, baseMint: 6, quoteMint: 7, signer: 8 };
  keys[indices.pool].pubkey = pool;
  keys[indices.quoteAta].pubkey = quoteAta;
  keys[indices.baseMint].pubkey = baseMint;
  keys[indices.quoteMint].pubkey = quoteMint;
  keys[indices.signer] = { pubkey: signer.publicKey, isSigner: true, isWritable: true };
  const name = share === "partner" ? "claim_trading_fee2" : "claim_creator_trading_fee2";
  const data = Buffer.alloc(28); // claim2 includes an empty Borsh hook-account slice vector.
  createHash("sha256").update("global:" + name).digest().copy(data, 0, 0, 8);
  data.writeBigUInt64LE(delta + 5n, 16);
  const tx = new Transaction().add(new TransactionInstruction({
    programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID, keys, data,
  }));
  tx.recentBlockhash = PublicKey.default.toBase58();
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  const signature = base58(tx.signature!);
  const receipt = {
    phase: "done", cluster: "devnet", tokenId, share,
    signer: signer.publicKey.toBase58(), pool: pool.toBase58(),
    quoteMint: quoteMint.toBase58(), quoteAta: quoteAta.toBase58(),
    maxQuoteRaw: (delta + 5n).toString(), actualQuoteDeltaRaw: delta.toString(),
    tx: { signature, rawBase64: tx.serialize().toString("base64") },
  };
  const accountKeys = tx.compileMessage().accountKeys;
  const index = accountKeys.findIndex((key) => key.equals(quoteAta));
  const chain = {
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: index, mint: quoteMint.toBase58(), uiTokenAmount: { amount: "100" } }],
      postTokenBalances: [{ accountIndex: index, mint: quoteMint.toBase58(), uiTokenAmount: { amount: (100n + delta).toString() } }],
    },
    transaction: {
      signatures: [signature], message: { getAccountKeys: () => ({ staticAccountKeys: accountKeys }) },
    },
  };
  return { receipt, chain };
}

test("receipt mode sums only completed claims paid directly to the settlement creator", () => {
  const long = makeClaim("long", "partner", 20n);
  const short = makeClaim("short", "creator", 31n);
  const { selection } = selectClaimSources({ long: long.receipt, short: short.receipt }, ["long", "short"], plan);
  assert.equal(selection.wsolRaw, 20n);
  assert.equal(selection.usdcRaw, 31n);
  assert.equal(selection.sources.length, 2);
  assert.throws(() => selectClaimSources({ long: long.receipt }, ["long", "long"], plan), /duplicate/);
  assert.throws(() => selectClaimSources({ long: { ...long.receipt, quoteAta: Keypair.generate().publicKey.toBase58() } }, ["long"], plan), /creator ATA/);
});

test("a DBC claim signature cannot be reserved by a second settlement run", () => {
  const source = { id: "claim-1", signature: "a-signature" };
  assertClaimSourcesUnused({ first: { claimSources: [source] } }, "first", [source]);
  assert.throws(() => assertClaimSourcesUnused({ first: { claimSources: [source] } }, "second", [source]), /already reserved/);
  assert.throws(() => assertClaimSourcesUnused({}, "second", [source, source]), /must be unique/);
});

test("receipt-backed mode verifies signed DBC claim and exact finalized ATA delta", async () => {
  const { receipt, chain } = makeClaim("long", "partner", 20n);
  const { receipts } = selectClaimSources({ claim: receipt }, ["claim"], plan);
  const commitments: string[] = [];
  const connection = {
    getTransaction: async (_signature: string, options: { commitment: string }) => {
      commitments.push(options.commitment);
      return chain;
    },
  } as unknown as Connection;
  await verifyClaimSourcesOnChain(connection, receipts, plan);
  assert.deepEqual(commitments, ["finalized"]);
  const wrongDelta = {
    ...chain,
    meta: { ...chain.meta, postTokenBalances: [{
      ...chain.meta.postTokenBalances[0], uiTokenAmount: { amount: "119" },
    }] },
  };
  await assert.rejects(
    verifyClaimSourcesOnChain({ getTransaction: async () => wrongDelta } as unknown as Connection, receipts, plan),
    /delta differs/,
  );
  const wrongCap = { ...receipt, maxQuoteRaw: "40" };
  const selected = selectClaimSources({ claim: wrongCap }, ["claim"], plan);
  await assert.rejects(verifyClaimSourcesOnChain(connection, selected.receipts, plan), /quote-only DBC claim/);
  const malformed = Transaction.from(Buffer.from(receipt.tx.rawBase64, "base64"));
  malformed.instructions[0].data.writeUInt32LE(1, 24); // Declares a slice but carries no slice bytes.
  malformed.sign(creator);
  const malformedReceipt = {
    ...receipt,
    tx: {
      signature: base58(malformed.signature!),
      rawBase64: malformed.serialize().toString("base64"),
    },
  };
  const malformedSelection = selectClaimSources({ claim: malformedReceipt }, ["claim"], plan);
  await assert.rejects(
    verifyClaimSourcesOnChain(connection, malformedSelection.receipts, plan),
    /quote-only DBC claim/,
  );
});

test("receipt verifier accepts the real SDK hook-aware claim2 builder payload", async () => {
  const { receipt } = makeClaim("long", "partner", 20n);
  const signer = creator;
  const quoteAta = new PublicKey(receipt.quoteAta);
  const pool = new PublicKey(receipt.pool);
  const extra = Keypair.generate().publicKey;
  const { program } = createDbcProgram(new Connection("http://127.0.0.1:8899"));
  const built = await program.methods.claimTradingFee2(
    new BN(0), new BN(receipt.maxQuoteRaw),
    { slices: [{ accountsType: AccountsType.TransferHookBase, length: 1 }] },
  ).accountsPartial({
    poolAuthority: deriveDbcPoolAuthority(),
    config: Keypair.generate().publicKey,
    pool,
    tokenAAccount: Keypair.generate().publicKey,
    tokenBAccount: quoteAta,
    baseVault: Keypair.generate().publicKey,
    quoteVault: Keypair.generate().publicKey,
    baseMint: longBase,
    quoteMint: NATIVE_MINT,
    feeClaimer: signer.publicKey,
    tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
    tokenQuoteProgram: TOKEN_PROGRAM_ID,
    eventAuthority: deriveDbcEventAuthority(),
    program: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  }).remainingAccounts([{ pubkey: extra, isSigner: false, isWritable: false }]).instruction();
  assert.ok(built.data.length > 28, "real claim2 carries the hook slice after the fee caps");
  const signed = new Transaction().add(built);
  signed.recentBlockhash = PublicKey.default.toBase58();
  signed.feePayer = signer.publicKey;
  signed.sign(signer);
  const signature = base58(signed.signature!);
  receipt.tx = { signature, rawBase64: signed.serialize().toString("base64") };
  const accountKeys = signed.compileMessage().accountKeys;
  const index = accountKeys.findIndex((key) => key.equals(quoteAta));
  const chain = {
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: index, mint: NATIVE_MINT.toBase58(), uiTokenAmount: { amount: "100" } }],
      postTokenBalances: [{ accountIndex: index, mint: NATIVE_MINT.toBase58(), uiTokenAmount: { amount: "120" } }],
    },
    transaction: {
      signatures: [signature], message: { getAccountKeys: () => ({ staticAccountKeys: accountKeys }) },
    },
  };
  const { receipts } = selectClaimSources({ claim: receipt }, ["claim"], plan);
  await verifyClaimSourcesOnChain({ getTransaction: async () => chain } as unknown as Connection, receipts, plan);
});
