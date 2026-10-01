import { CP_AMM_PROGRAM_ID } from "@meteora-ag/cp-amm-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemInstruction,
  SystemProgram,
  type Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

export interface FeeInstructionAccounts {
  owner: PublicKey;
  quoteMint: PublicKey;
  wrapperMint: PublicKey;
  quoteAta: PublicKey;
  wrapperAta: PublicKey;
  wsolAta: PublicKey | null;
}

function sameInstruction(actual: TransactionInstruction, expected: TransactionInstruction): boolean {
  return actual.programId.equals(expected.programId) && actual.data.equals(expected.data) &&
    actual.keys.length === expected.keys.length && actual.keys.every((key, index) =>
      key.pubkey.equals(expected.keys[index].pubkey) &&
      key.isSigner === expected.keys[index].isSigner &&
      key.isWritable === expected.keys[index].isWritable);
}

// CpAmm.swap2 and CpAmm.addLiquidity always prepend idempotent ATA creations;
// they also wrap and close WSOL. All ATAs were verified to exist by the caller.
// Fee settlement must spend only the already-claimed WSOL in that ATA.
export function onlyDammInstruction(
  transaction: Transaction,
  accounts: FeeInstructionAccounts,
): TransactionInstruction {
  const programInstructions = transaction.instructions.filter(
    (instruction) => instruction.programId.equals(CP_AMM_PROGRAM_ID),
  );
  if (programInstructions.length !== 1) {
    throw new Error("expected exactly one DAMM v2 instruction from SDK");
  }
  const expectedAtaInstructions = [
    createAssociatedTokenAccountIdempotentInstruction(
      accounts.owner, accounts.quoteAta, accounts.owner, accounts.quoteMint, TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      accounts.owner, accounts.wrapperAta, accounts.owner, accounts.wrapperMint, TOKEN_PROGRAM_ID,
    ),
  ];
  const seenAtas = new Set<number>();
  for (const instruction of transaction.instructions) {
    if (instruction.programId.equals(CP_AMM_PROGRAM_ID)) continue;
    if (instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      const index = expectedAtaInstructions.findIndex((expected) => sameInstruction(instruction, expected));
      if (index < 0 || seenAtas.has(index)) throw new Error("unexpected SDK ATA helper instruction");
      seenAtas.add(index);
      continue;
    }
    if (!accounts.wsolAta) throw new Error("unexpected SDK helper instruction without WSOL");
    if (instruction.programId.equals(SystemProgram.programId)) {
      if (SystemInstruction.decodeInstructionType(instruction) !== "Transfer") {
        throw new Error("unexpected SDK system helper");
      }
      const transfer = SystemInstruction.decodeTransfer(instruction);
      if (!transfer.fromPubkey.equals(accounts.owner) ||
          !transfer.toPubkey.equals(accounts.wsolAta)) {
        throw new Error("SDK WSOL wrap source or destination differs from fee account");
      }
      continue;
    }
    if (instruction.programId.equals(TOKEN_PROGRAM_ID)) {
      const sync = createSyncNativeInstruction(accounts.wsolAta, TOKEN_PROGRAM_ID);
      const close = createCloseAccountInstruction(
        accounts.wsolAta, accounts.owner, accounts.owner, [], TOKEN_PROGRAM_ID,
      );
      if (sameInstruction(instruction, sync) || sameInstruction(instruction, close)) {
        continue; // Existing WSOL ATA must remain open after fee settlement.
      }
    }
    throw new Error("unexpected SDK helper instruction: " + instruction.programId.toBase58());
  }
  if (seenAtas.size !== expectedAtaInstructions.length) {
    throw new Error("SDK omitted the expected idempotent ATA helper instructions");
  }
  return programInstructions[0];
}
