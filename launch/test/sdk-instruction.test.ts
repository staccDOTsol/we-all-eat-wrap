import assert from "node:assert/strict";
import test from "node:test";
import BN from "bn.js";
import { CP_AMM_PROGRAM_ID, CpAmm, SwapMode, type PoolState } from "@meteora-ag/cp-amm-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, Keypair, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { onlyDammInstruction } from "../src/sdk-instruction.js";

function setup() {
  const owner = Keypair.generate().publicKey;
  const quoteMint = NATIVE_MINT;
  const wrapperMint = Keypair.generate().publicKey;
  const quoteAta = getAssociatedTokenAddressSync(quoteMint, owner);
  const wrapperAta = getAssociatedTokenAddressSync(wrapperMint, owner);
  const accounts = { owner, quoteMint, wrapperMint, quoteAta, wrapperAta, wsolAta: quoteAta };
  const ataHelpers = [
    createAssociatedTokenAccountIdempotentInstruction(owner, quoteAta, owner, quoteMint),
    createAssociatedTokenAccountIdempotentInstruction(owner, wrapperAta, owner, wrapperMint),
  ];
  const damm = new TransactionInstruction({
    programId: CP_AMM_PROGRAM_ID,
    keys: [],
    data: Buffer.from([1]),
  });
  return { accounts, ataHelpers, damm };
}

test("retains only DAMM v2 instruction while discarding exact WSOL helpers", () => {
  const { accounts, ataHelpers, damm } = setup();
  const transaction = new Transaction().add(
    ...ataHelpers,
    SystemProgram.transfer({ fromPubkey: accounts.owner, toPubkey: accounts.quoteAta, lamports: 50 }),
    createSyncNativeInstruction(accounts.quoteAta, TOKEN_PROGRAM_ID),
    damm,
    createCloseAccountInstruction(accounts.quoteAta, accounts.owner, accounts.owner, [], TOKEN_PROGRAM_ID),
  );
  assert.equal(onlyDammInstruction(transaction, accounts), damm);
});

test("rejects a helper targeting another account and unexpected instructions", () => {
  const { accounts, ataHelpers, damm } = setup();
  const other = Keypair.generate().publicKey;
  const badTransfer = new Transaction().add(
    ...ataHelpers,
    SystemProgram.transfer({ fromPubkey: accounts.owner, toPubkey: other, lamports: 1 }),
    damm,
  );
  assert.throws(() => onlyDammInstruction(badTransfer, accounts), /source or destination/);
  const badHelper = new Transaction().add(
    ...ataHelpers,
    createSyncNativeInstruction(other, TOKEN_PROGRAM_ID),
    damm,
  );
  assert.throws(() => onlyDammInstruction(badHelper, accounts), /unexpected SDK helper/);
  assert.throws(() => onlyDammInstruction(new Transaction().add(...ataHelpers, damm, damm), accounts), /exactly one/);
  const wrongAta = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(accounts.owner, other, accounts.owner, accounts.quoteMint),
    ataHelpers[1],
    damm,
  );
  assert.throws(() => onlyDammInstruction(wrongAta, accounts), /unexpected SDK ATA helper/);
  assert.throws(() => onlyDammInstruction(new Transaction().add(damm), accounts), /omitted/);
});

test("extracts the DAMM instruction from the installed SDK's real addLiquidity builder", async () => {
  const { accounts } = setup();
  const cpAmm = new CpAmm(new Connection("http://127.0.0.1:8899"));
  const tx = await cpAmm.addLiquidity({
    owner: accounts.owner,
    pool: Keypair.generate().publicKey,
    position: Keypair.generate().publicKey,
    positionNftAccount: Keypair.generate().publicKey,
    liquidityDelta: new BN(1),
    maxAmountTokenA: new BN(1),
    maxAmountTokenB: new BN(1),
    tokenAAmountThreshold: new BN(1),
    tokenBAmountThreshold: new BN(1),
    tokenAMint: accounts.wrapperMint,
    tokenBMint: accounts.quoteMint,
    tokenAVault: Keypair.generate().publicKey,
    tokenBVault: Keypair.generate().publicKey,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
  });
  assert.equal(tx.instructions.length, 6);
  assert.equal(onlyDammInstruction(tx, accounts).programId.toBase58(), CP_AMM_PROGRAM_ID.toBase58());
});

test("extracts the DAMM instruction from the installed SDK's real swap2 builder", async () => {
  const { accounts } = setup();
  const cpAmm = new CpAmm(new Connection("http://127.0.0.1:8899"));
  // swap2 only reads these fee-mode fields while constructing the instruction.
  const poolState = {
    poolFees: { baseFee: { baseFeeInfo: { data: Array(9).fill(0) } } },
    activationType: 0,
  } as unknown as PoolState;
  const tx = await cpAmm.swap2({
    payer: accounts.owner,
    pool: Keypair.generate().publicKey,
    inputTokenMint: accounts.quoteMint,
    outputTokenMint: accounts.wrapperMint,
    tokenAMint: accounts.wrapperMint,
    tokenBMint: accounts.quoteMint,
    tokenAVault: Keypair.generate().publicKey,
    tokenBVault: Keypair.generate().publicKey,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    referralTokenAccount: null,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(1),
    minimumAmountOut: new BN(1),
    poolState,
  });
  assert.equal(tx.instructions.length, 6);
  assert.equal(onlyDammInstruction(tx, accounts).programId.toBase58(), CP_AMM_PROGRAM_ID.toBase58());
});
