/**
 * Solana `settle_inbound_bridge` instruction builder.
 *
 * After Circle (or Wormhole) `receiveMessage` lands SPL into the user's
 * `EXTERNAL_AUTHORITY(user)`-owned ATA, the sponsor calls this on rome-evm
 * to convert the whole delivered amount into native gas credited to the
 * user's BalancePda. The instruction is signed by `bridge_settler_key`
 * (preferred) or the legacy `registration_key` — both keys are accepted
 * on-chain during the migration window.
 *
 * Wire format (77B):
 *   [0]      opcode = 15
 *   [1..9]   chain_id      u64 LE
 *   [9..29]  user          H160 (20B)
 *   [29..37] bridged_amount u64 LE  (mint base units, e.g. micro-USDC)
 *   [37..45] source_chain  u64 LE  (CCTP domain or Wormhole chain id)
 *   [45..77] source_tx_hash H256 (32B)
 *
 * Reference: the Rome EVM/program/src/api/settle_inbound_bridge.rs
 * (canonical) + the Rome app/src/utils/txs.ts::buildSettleInboundBridgeIx
 * (which is the proven wire layout from the existing worker).
 *
 * Per the architecture pin, `EXTERNAL_AUTHORITY(user)` is NOT chain-scoped
 * — same EVM address yields the same PDA across all chains hosted by a
 * given rome-evm program. The chain id only scopes the gas-pool wallet
 * (`sol_wallet`) and per-chain Balance / BridgeProcessed PDAs.
 */

import { Buffer } from "node:buffer";
import {
  AccountMeta, PublicKey, SystemProgram, TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

/** the Rome EVM entrypoint dispatch slot for SettleInboundBridge. */
export const SETTLE_INBOUND_BRIDGE_IX_ID = 15;

function require20(name: string, b: Uint8Array): void {
  if (b.length !== 20) throw new Error(`${name} must be 20 bytes, got ${b.length}`);
}
function require32(name: string, b: Uint8Array): void {
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes, got ${b.length}`);
}

function chainBuf(chainId: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(chainId);
  return b;
}

/** PDA = find_program_address([b"OWNER_INFO"], programId). */
export function findOwnerInfoPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("OWNER_INFO")], programId,
  )[0];
}

/** PDA = find_program_address([chainId u64 LE, b"CONTRACT_SOL_WALLET"], programId). */
export function findSolWalletPda(chainId: bigint, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [chainBuf(chainId), Buffer.from("CONTRACT_SOL_WALLET")], programId,
  )[0];
}

/** PDA = find_program_address([chainId u64 LE, b"ACCOUN_SEED", user], programId). */
export function findBalancePda(chainId: bigint, user: Uint8Array, programId: PublicKey): PublicKey {
  require20("user", user);
  return PublicKey.findProgramAddressSync(
    [chainBuf(chainId), Buffer.from("ACCOUN_SEED"), Buffer.from(user)], programId,
  )[0];
}

/** PDA = find_program_address([b"EXTERNAL_AUTHORITY", user], programId). NOT chain-scoped. */
export function findExternalAuthPda(user: Uint8Array, programId: PublicKey): PublicKey {
  require20("user", user);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("EXTERNAL_AUTHORITY"), Buffer.from(user)], programId,
  )[0];
}

/**
 * PDA = find_program_address(
 *   [chainId u64 LE, b"BRIDGE_PROCESSED", sourceChain u64 LE, sourceTxHash 32B],
 *   programId,
 * ). Replay marker, allocated lazily on first settle.
 */
export function findBridgeProcessedPda(
  chainId: bigint,
  sourceChain: bigint,
  sourceTxHash: Uint8Array,
  programId: PublicKey,
): PublicKey {
  require32("sourceTxHash", sourceTxHash);
  const srcChain = Buffer.alloc(8);
  srcChain.writeBigUInt64LE(sourceChain);
  return PublicKey.findProgramAddressSync(
    [chainBuf(chainId), Buffer.from("BRIDGE_PROCESSED"), srcChain, Buffer.from(sourceTxHash)],
    programId,
  )[0];
}

export interface BuildSettleInboundBridgeParams {
  /** Rome chain id (e.g. 200010n for Hadrian). */
  chainId: bigint;
  /** Signer = `bridge_settler_key` (preferred) or `registration_key` (legacy). */
  signer: PublicKey;
  /** EVM address (20B) of the user receiving the gas credit. */
  user: Uint8Array;
  /** Amount delivered by the bridge, in mint base units (e.g. micro-USDC). */
  bridgedAmount: bigint;
  /** Source-chain identifier (CCTP domain for CCTP; Wormhole chain for WH). */
  sourceChain: bigint;
  /** 32-byte source-chain tx hash; replay key. */
  sourceTxHash: Uint8Array;
  /** rome-evm program id for the chain (from registry chain.bridge.solana.romeEvmProgramId). */
  rollupProgramId: PublicKey;
  /** Chain's gas SPL mint. */
  mintAddress: PublicKey;
  /** SPL token program — defaults to classic TOKEN_PROGRAM_ID. */
  splTokenProgram?: PublicKey;
}

export function buildSettleInboundBridgeInstruction(
  p: BuildSettleInboundBridgeParams,
): TransactionInstruction {
  require20("user", p.user);
  require32("sourceTxHash", p.sourceTxHash);
  if (p.bridgedAmount <= 0n) {
    throw new Error(`bridgedAmount must be > 0, got ${p.bridgedAmount}`);
  }

  const splTokenProgram = p.splTokenProgram ?? TOKEN_PROGRAM_ID;

  const data = Buffer.alloc(1 + 8 + 20 + 8 + 8 + 32);
  let off = 0;
  data.writeUInt8(SETTLE_INBOUND_BRIDGE_IX_ID, off);     off += 1;
  data.writeBigUInt64LE(p.chainId, off);                 off += 8;
  Buffer.from(p.user).copy(data, off);                   off += 20;
  data.writeBigUInt64LE(p.bridgedAmount, off);           off += 8;
  data.writeBigUInt64LE(p.sourceChain, off);             off += 8;
  Buffer.from(p.sourceTxHash).copy(data, off);

  const userPda = findExternalAuthPda(p.user, p.rollupProgramId);
  const userAta = getAssociatedTokenAddressSync(
    p.mintAddress, userPda, /* allowOwnerOffCurve */ true, splTokenProgram,
  );
  const solWalletPda = findSolWalletPda(p.chainId, p.rollupProgramId);
  const solWalletAta = getAssociatedTokenAddressSync(
    p.mintAddress, solWalletPda, /* allowOwnerOffCurve */ true, splTokenProgram,
  );

  const keys: AccountMeta[] = [
    { pubkey: SystemProgram.programId,                                         isSigner: false, isWritable: false },
    { pubkey: p.signer,                                                         isSigner: true,  isWritable: true  },
    { pubkey: findOwnerInfoPda(p.rollupProgramId),                              isSigner: false, isWritable: false },
    { pubkey: findBridgeProcessedPda(p.chainId, p.sourceChain, p.sourceTxHash, p.rollupProgramId),
                                                                                isSigner: false, isWritable: true  },
    { pubkey: findBalancePda(p.chainId, p.user, p.rollupProgramId),             isSigner: false, isWritable: true  },
    { pubkey: userPda,                                                           isSigner: false, isWritable: false },
    { pubkey: userAta,                                                           isSigner: false, isWritable: true  },
    { pubkey: solWalletPda,                                                      isSigner: false, isWritable: false },
    { pubkey: solWalletAta,                                                      isSigner: false, isWritable: true  },
    { pubkey: p.mintAddress,                                                     isSigner: false, isWritable: false },
    { pubkey: splTokenProgram,                                                   isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: p.rollupProgramId, keys, data });
}
