/**
 * Solana `settle_inbound_bridge_v2` instruction builder.
 *
 * Sibling of solana-settle.ts (v1). Same account layout + settle core; the
 * difference is authorization: v1's data ends at source_tx_hash and requires a
 * bridge_settler_key signer, v2 appends {deadline, source_evm_chain_id, r, s,
 * v} (the user's EIP-712 signature) and is submittable by ANY caller. The
 * program recovers the signer from the recomputed digest — no privileged key.
 *
 * Wire format (opcode + 157B data), matching the Rust args() parser exactly:
 *   [0]        opcode = 21 (SettleInboundBridgeV2)
 *   chain_id            u64 LE (8)
 *   user                H160 (20)
 *   bridged_amount      u64 LE (8)
 *   source_chain        u64 LE (8)
 *   source_tx_hash      H256 (32)
 *   deadline            u64 LE (8)
 *   source_evm_chain_id u64 LE (8)
 *   sig_r               (32)
 *   sig_s               (32)
 *   sig_v               u8 (1)
 */
import { Buffer } from "node:buffer";
import { AccountMeta, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  findBalancePda, findBridgeProcessedPda, findExternalAuthPda, findOwnerInfoPda, findSolWalletPda,
} from "./solana-settle.js";

/** the Rome EVM entrypoint dispatch slot for SettleInboundBridgeV2 (append-only, slot 21). */
export const SETTLE_INBOUND_BRIDGE_V2_IX_ID = 21;

function requireLen(name: string, b: Uint8Array, n: number): void {
  if (b.length !== n) throw new Error(`${name} must be ${n} bytes, got ${b.length}`);
}

export interface BuildSettleV2Params {
  chainId: bigint;
  /** Whoever pays for + signs the Solana tx — NOT an authority (any caller). */
  submitter: PublicKey;
  user: Uint8Array;
  bridgedAmount: bigint;
  sourceChain: bigint;
  sourceTxHash: Uint8Array;
  deadline: bigint;
  sourceEvmChainId: bigint;
  /** secp256k1 signature components of the user's EIP-712 SettleAuthorization. */
  sigR: Uint8Array;
  sigS: Uint8Array;
  sigV: number;
  rollupProgramId: PublicKey;
  mintAddress: PublicKey;
  splTokenProgram?: PublicKey;
}

export function buildSettleInboundBridgeV2Instruction(p: BuildSettleV2Params): TransactionInstruction {
  requireLen("user", p.user, 20);
  requireLen("sourceTxHash", p.sourceTxHash, 32);
  requireLen("sigR", p.sigR, 32);
  requireLen("sigS", p.sigS, 32);
  if (p.sigV !== 27 && p.sigV !== 28) throw new Error(`sigV must be 27 or 28, got ${p.sigV}`);
  if (p.bridgedAmount <= 0n) throw new Error(`bridgedAmount must be > 0, got ${p.bridgedAmount}`);

  const splTokenProgram = p.splTokenProgram ?? TOKEN_PROGRAM_ID;

  const data = Buffer.alloc(1 + 157);
  let off = 0;
  data.writeUInt8(SETTLE_INBOUND_BRIDGE_V2_IX_ID, off); off += 1;
  data.writeBigUInt64LE(p.chainId, off); off += 8;
  Buffer.from(p.user).copy(data, off); off += 20;
  data.writeBigUInt64LE(p.bridgedAmount, off); off += 8;
  data.writeBigUInt64LE(p.sourceChain, off); off += 8;
  Buffer.from(p.sourceTxHash).copy(data, off); off += 32;
  data.writeBigUInt64LE(p.deadline, off); off += 8;
  data.writeBigUInt64LE(p.sourceEvmChainId, off); off += 8;
  Buffer.from(p.sigR).copy(data, off); off += 32;
  Buffer.from(p.sigS).copy(data, off); off += 32;
  data.writeUInt8(p.sigV, off);

  const userPda = findExternalAuthPda(p.user, p.rollupProgramId);
  const userAta = getAssociatedTokenAddressSync(p.mintAddress, userPda, true, splTokenProgram);
  const solWalletPda = findSolWalletPda(p.chainId, p.rollupProgramId);
  const solWalletAta = getAssociatedTokenAddressSync(p.mintAddress, solWalletPda, true, splTokenProgram);

  const keys: AccountMeta[] = [
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: p.submitter, isSigner: true, isWritable: true },
    { pubkey: findOwnerInfoPda(p.rollupProgramId), isSigner: false, isWritable: false },
    { pubkey: findBridgeProcessedPda(p.chainId, p.sourceChain, p.sourceTxHash, p.rollupProgramId), isSigner: false, isWritable: true },
    { pubkey: findBalancePda(p.chainId, p.user, p.rollupProgramId), isSigner: false, isWritable: true },
    { pubkey: userPda, isSigner: false, isWritable: false },
    { pubkey: userAta, isSigner: false, isWritable: true },
    { pubkey: solWalletPda, isSigner: false, isWritable: false },
    { pubkey: solWalletAta, isSigner: false, isWritable: true },
    { pubkey: p.mintAddress, isSigner: false, isWritable: false },
    { pubkey: splTokenProgram, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: p.rollupProgramId, keys, data });
}
