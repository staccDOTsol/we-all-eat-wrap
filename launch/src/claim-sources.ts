import { createHash } from "node:crypto";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { LaunchPlan } from "./plan.js";

const U64_MAX = (1n << 64n) - 1n;
const RUN_ID = /^[a-zA-Z0-9._-]{1,100}$/;

export interface ClaimSource {
  id: string;
  signature: string;
}

interface ClaimReceipt {
  phase: "done";
  cluster: string;
  tokenId: "long" | "short";
  share: "partner" | "creator";
  signer: string;
  pool: string;
  quoteMint: string;
  quoteAta: string;
  maxQuoteRaw: string;
  actualQuoteDeltaRaw: string;
  tx: { signature: string; rawBase64: string };
}

export interface ClaimSelection {
  wsolRaw: bigint;
  usdcRaw: bigint;
  sources: ClaimSource[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

function positiveRaw(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(label + " must be a positive raw integer string");
  }
  const amount = BigInt(value);
  if (amount > U64_MAX) throw new Error(label + " exceeds u64");
  return amount;
}

function address(value: unknown, label: string): PublicKey {
  if (typeof value !== "string") throw new Error(label + " must be a base58 address");
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(label + " must be a base58 address");
  }
}

function base58(buffer: Buffer): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt("0x" + buffer.toString("hex"));
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of buffer) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded;
}

function claimDiscriminator(share: "partner" | "creator"): Buffer {
  const name = share === "partner" ? "claim_trading_fee2" : "claim_creator_trading_fee2";
  return createHash("sha256").update("global:" + name).digest().subarray(0, 8);
}

// DBC claim2 encodes two u64 caps followed by TransferHookAccountsInfo:
// a Borsh vec of { AccountsType (u8), length (u8) } slices. The slice lengths
// account for every remaining account after the fixed Anchor account list.
function validHookAccountSlices(data: Buffer, remainingAccounts: number): boolean {
  if (data.length < 28) return false;
  const count = data.readUInt32LE(24);
  if (count > (data.length - 28) / 2 || data.length !== 28 + count * 2) return false;
  let total = 0;
  for (let index = 0; index < count; index++) {
    const type = data[28 + index * 2];
    if (type !== 0 && type !== 1) return false;
    total += data[29 + index * 2];
  }
  return total === remainingAccounts;
}

function validateReceipt(value: unknown, id: string, plan: LaunchPlan): { receipt: ClaimReceipt; quote: "wsol" | "usdc"; amount: bigint } {
  const row = object(value, "claim receipt " + id);
  if (row.phase !== "done" || (row.tokenId !== "long" && row.tokenId !== "short") ||
      (row.share !== "partner" && row.share !== "creator")) {
    throw new Error("claim receipt " + id + " must be a completed long/short partner or creator claim");
  }
  if (row.cluster !== plan.cluster) throw new Error("claim receipt " + id + " cluster differs from launch");
  const quote = row.tokenId === "long" ? "wsol" : "usdc";
  const expectedMint = plan.quoteMints[quote];
  if (!expectedMint || row.quoteMint !== expectedMint) {
    throw new Error("claim receipt " + id + " quote mint differs from the " + row.tokenId + " DBC");
  }
  if (!plan.creator) throw new Error("launch creator is missing");
  const expectedAta = getAssociatedTokenAddressSync(
    new PublicKey(expectedMint), new PublicKey(plan.creator), false, TOKEN_PROGRAM_ID,
  );
  if (row.quoteAta !== expectedAta.toBase58()) {
    throw new Error("claim receipt " + id + " did not pay the settlement creator ATA; use --manual for transferred claims");
  }
  if (typeof row.pool !== "string" || typeof row.signer !== "string" ||
      typeof row.maxQuoteRaw !== "string" || typeof row.actualQuoteDeltaRaw !== "string") {
    throw new Error("claim receipt " + id + " is missing pool, signer, cap, or delta");
  }
  address(row.pool, "claim pool");
  address(row.signer, "claim signer");
  const cap = positiveRaw(row.maxQuoteRaw, "claim receipt " + id + " cap");
  const amount = positiveRaw(row.actualQuoteDeltaRaw, "claim receipt " + id + " delta");
  if (amount > cap) throw new Error("claim receipt " + id + " exceeds its signed cap");
  const tx = object(row.tx, "claim receipt " + id + " transaction");
  if (typeof tx.signature !== "string" || typeof tx.rawBase64 !== "string" || !tx.rawBase64) {
    throw new Error("claim receipt " + id + " lacks a signed transaction");
  }
  return { receipt: row as unknown as ClaimReceipt, quote, amount };
}

export function selectClaimSources(
  claimJournal: unknown,
  ids: string[],
  plan: LaunchPlan,
): { selection: ClaimSelection; receipts: ClaimReceipt[] } {
  const journal = object(claimJournal, "DBC claim journal");
  if (ids.length === 0) throw new Error("at least one --claim-run is required");
  const seenIds = new Set<string>();
  const seenSignatures = new Set<string>();
  const selection: ClaimSelection = { wsolRaw: 0n, usdcRaw: 0n, sources: [] };
  const receipts: ClaimReceipt[] = [];
  for (const id of ids) {
    if (!RUN_ID.test(id) || seenIds.has(id)) throw new Error("duplicate or invalid claim run ID " + id);
    seenIds.add(id);
    const { receipt, quote, amount } = validateReceipt(journal[id], id, plan);
    if (seenSignatures.has(receipt.tx.signature)) throw new Error("duplicate claim signature " + receipt.tx.signature);
    seenSignatures.add(receipt.tx.signature);
    selection[quote + "Raw" as "wsolRaw" | "usdcRaw"] += amount;
    if (selection[quote + "Raw" as "wsolRaw" | "usdcRaw"] > U64_MAX) {
      throw new Error("total " + quote + " claims exceed u64");
    }
    selection.sources.push({ id, signature: receipt.tx.signature });
    receipts.push(receipt);
  }
  const together = selection.sources.map((source, index) => ({ source, receipt: receipts[index] }));
  together.sort((a, b) => a.source.signature.localeCompare(b.source.signature));
  selection.sources = together.map((entry) => entry.source);
  return { selection, receipts: together.map((entry) => entry.receipt) };
}

export function assertClaimSourcesUnused(
  settlementJournal: Record<string, { claimSources?: ClaimSource[] }>,
  runId: string,
  sources: ClaimSource[],
): void {
  const selected = new Set(sources.map((source) => source.signature));
  if (selected.size !== sources.length) throw new Error("claim signatures must be unique within a settlement");
  for (const [otherRunId, run] of Object.entries(settlementJournal)) {
    if (otherRunId === runId) continue;
    for (const source of run.claimSources ?? []) {
      if (selected.has(source.signature)) {
        throw new Error("DBC claim signature " + source.signature + " was already reserved by settlement " + otherRunId);
      }
    }
  }
}

export async function verifyClaimSourcesOnChain(
  connection: Connection,
  receipts: ClaimReceipt[],
  plan: LaunchPlan,
): Promise<void> {
  for (const receipt of receipts) {
    const baseMintString = plan.dbcBaseMints[receipt.tokenId];
    if (!baseMintString) throw new Error("missing " + receipt.tokenId + " DBC base mint");
    const local = Transaction.from(Buffer.from(receipt.tx.rawBase64, "base64"));
    const signature = local.signature;
    if (!signature || base58(signature) !== receipt.tx.signature || !local.verifySignatures(true) ||
        local.instructions.length !== 1 || !local.feePayer?.equals(address(receipt.signer, "claim signer"))) {
      throw new Error("claim receipt " + receipt.tx.signature + " has an invalid signed transaction");
    }
    const ix = local.instructions[0];
    const partner = receipt.share === "partner";
    const expected = partner
      ? { pool: 2, quoteAta: 4, baseMint: 7, quoteMint: 8, signer: 9 }
      : { pool: 1, quoteAta: 3, baseMint: 6, quoteMint: 7, signer: 8 };
    const fixedAccountCount = partner ? 14 : 13;
    if (!ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) ||
        ix.keys.length < fixedAccountCount ||
        !validHookAccountSlices(ix.data, ix.keys.length - fixedAccountCount) ||
        !ix.data.subarray(0, 8).equals(claimDiscriminator(receipt.share)) ||
        ix.data.readBigUInt64LE(8) !== 0n ||
        ix.data.readBigUInt64LE(16) !== BigInt(receipt.maxQuoteRaw) ||
        !ix.keys[expected.pool]?.pubkey.equals(address(receipt.pool, "claim pool")) ||
        !ix.keys[expected.quoteAta]?.pubkey.equals(address(receipt.quoteAta, "claim quote ATA")) ||
        !ix.keys[expected.baseMint]?.pubkey.equals(new PublicKey(baseMintString)) ||
        !ix.keys[expected.quoteMint]?.pubkey.equals(new PublicKey(receipt.quoteMint)) ||
        !ix.keys[expected.signer]?.pubkey.equals(address(receipt.signer, "claim signer")) ||
        !ix.keys[expected.signer]?.isSigner) {
      throw new Error("claim receipt " + receipt.tx.signature + " is not the expected quote-only DBC claim");
    }
    const confirmed = await connection.getTransaction(receipt.tx.signature, {
      commitment: "finalized", maxSupportedTransactionVersion: 0,
    });
    if (!confirmed?.meta || confirmed.meta.err ||
        confirmed.transaction.signatures[0] !== receipt.tx.signature) {
      throw new Error("claim transaction " + receipt.tx.signature + " is not finalized successfully");
    }
    const meta = confirmed.meta;
    const keys = confirmed.transaction.message.getAccountKeys().staticAccountKeys;
    const index = keys.findIndex((key) => key.equals(new PublicKey(receipt.quoteAta)));
    if (index < 0) throw new Error("claim receiver ATA absent from confirmed transaction");
    function tokenAmount(balances: typeof meta.preTokenBalances): bigint {
      const balance = balances?.find((entry) =>
        entry.accountIndex === index && entry.mint === receipt.quoteMint);
      if (!balance) throw new Error("claim receiver balance metadata is missing");
      return BigInt(balance.uiTokenAmount.amount);
    }
    const delta = tokenAmount(meta.postTokenBalances) - tokenAmount(meta.preTokenBalances);
    if (delta !== BigInt(receipt.actualQuoteDeltaRaw)) {
      throw new Error("claim receipt " + receipt.tx.signature + " delta differs from confirmed chain metadata");
    }
  }
}
