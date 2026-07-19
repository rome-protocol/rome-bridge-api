/**
 * Read the on-chain OwnerInfo PDA for a rome-evm program.
 *
 * The PDA's data is an append-only array of OwnerInfo entries, one per registered chain.
 * Per the Rome EVM/program/src/accounts/owner_info.rs:
 *
 *   #[repr(C, packed)]
 *   pub struct OwnerInfo {
 *     pub chain: u64,           // 8 bytes LE
 *     pub mint: Option<Pubkey>, // 1 tag + 32 bytes = 33 bytes (0 = None, 1 = Some)
 *     pub slot: u64,            // 8 bytes LE
 *     pub single_state: bool,   // 1 byte
 *   }
 *
 * Account-data layout:
 *   [ account_type:u8 | version:u8 | entry_0 (50B) | entry_1 (50B) | ... ]
 *
 * The array fills the remaining bytes — no length prefix. `(data.length - 2) / 50` = number of entries.
 *
 * Source of truth for "which chains are registered + what's their gas mint." The registry is a mirror;
 * on-chain data is authoritative per the API spec
 */

import { PublicKey, type Commitment } from "@solana/web3.js";

export const OWNER_INFO_SEED = Buffer.from("OWNER_INFO");
export const OWNER_INFO_HEADER_SIZE = 2;     // AccountType(1) + Version(1)
export const OWNER_INFO_ENTRY_SIZE = 50;     // 8 + 33 + 8 + 1

export interface OwnerInfoEntry {
  chain: bigint;
  mint: PublicKey | null;
  slot: bigint;
  singleState: boolean;
}

export function deriveOwnerInfoPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([OWNER_INFO_SEED], programId)[0];
}

export function parseOwnerInfoData(buf: Buffer): OwnerInfoEntry[] {
  if (buf.length < OWNER_INFO_HEADER_SIZE) {
    throw new Error(`owner_info: account data too small (${buf.length}B), missing header`);
  }
  const bodyLen = buf.length - OWNER_INFO_HEADER_SIZE;
  if (bodyLen % OWNER_INFO_ENTRY_SIZE !== 0) {
    throw new Error(`owner_info: malformed body size ${bodyLen}B — not a multiple of ${OWNER_INFO_ENTRY_SIZE}`);
  }
  const count = bodyLen / OWNER_INFO_ENTRY_SIZE;
  const entries: OwnerInfoEntry[] = [];
  for (let i = 0; i < count; i++) {
    const off = OWNER_INFO_HEADER_SIZE + i * OWNER_INFO_ENTRY_SIZE;
    const chain = buf.readBigUInt64LE(off);
    const tag = buf[off + 8];
    const mint = tag === 1 ? new PublicKey(buf.subarray(off + 9, off + 9 + 32)) : null;
    const slot = buf.readBigUInt64LE(off + 41);
    const singleState = buf[off + 49] === 1;
    entries.push({ chain, mint, slot, singleState });
  }
  return entries;
}

interface RpcConnection {
  getAccountInfo(pubkey: PublicKey, opts?: { commitment?: Commitment }): Promise<{ data: Buffer } | null>;
}

export interface OwnerInfoClientOpts {
  connection: RpcConnection;
}

export class OwnerInfoClient {
  constructor(private opts: OwnerInfoClientOpts) {}

  async listEntries(programId: PublicKey): Promise<OwnerInfoEntry[]> {
    const pda = deriveOwnerInfoPda(programId);
    const info = await this.opts.connection.getAccountInfo(pda, { commitment: "confirmed" as Commitment });
    if (!info) return [];
    return parseOwnerInfoData(info.data);
  }

  async getMintForChain(programId: PublicKey, chainId: bigint): Promise<PublicKey | null> {
    const entries = await this.listEntries(programId);
    const hit = entries.find((e) => e.chain === chainId);
    return hit?.mint ?? null;
  }
}
