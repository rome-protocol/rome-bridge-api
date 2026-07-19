import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { OwnerInfoClient, parseOwnerInfoData, OWNER_INFO_ENTRY_SIZE } from "../../src/chains/owner-info-reader";

// Synthesized OwnerInfo account-data builder for tests.
// Layout (per the Rome EVM program/src/accounts/owner_info.rs):
//   [account_type:1 | version:1 | entry1(50) | entry2(50) | ...]
//   each entry: chain:u64 LE (8) | mint Option<Pubkey> (1 tag + 32 = 33) | slot:u64 LE (8) | single_state:bool (1) = 50 bytes
function buildOwnerInfoBuffer(entries: Array<{ chain: bigint; mint: PublicKey | null; slot: bigint; singleState: boolean }>): Buffer {
  const HEADER_SIZE = 2; // AccountType(1) + Version(1)
  const buf = Buffer.alloc(HEADER_SIZE + entries.length * OWNER_INFO_ENTRY_SIZE);
  buf[0] = 5;     // arbitrary AccountType placeholder
  buf[1] = 2;     // Version 2

  let offset = HEADER_SIZE;
  for (const e of entries) {
    buf.writeBigUInt64LE(e.chain, offset);
    offset += 8;
    if (e.mint) {
      buf[offset] = 1; // Some
      e.mint.toBuffer().copy(buf, offset + 1);
    } else {
      buf[offset] = 0; // None — 32 mint bytes remain zero
    }
    offset += 33;
    buf.writeBigUInt64LE(e.slot, offset);
    offset += 8;
    buf[offset] = e.singleState ? 1 : 0;
    offset += 1;
  }
  return buf;
}

const HADRIAN_PROGRAM = new PublicKey("RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf");
const USDC_DEVNET_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

describe("parseOwnerInfoData", () => {
  it("parses a buffer with one entry (Some(mint))", () => {
    const buf = buildOwnerInfoBuffer([
      { chain: 200010n, mint: USDC_DEVNET_MINT, slot: 12345n, singleState: false },
    ]);
    const entries = parseOwnerInfoData(buf);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.chain).toBe(200010n);
    expect(entries[0]?.mint?.equals(USDC_DEVNET_MINT)).toBe(true);
    expect(entries[0]?.slot).toBe(12345n);
    expect(entries[0]?.singleState).toBe(false);
  });

  it("parses multiple entries, including None mint", () => {
    const buf = buildOwnerInfoBuffer([
      { chain: 200010n, mint: USDC_DEVNET_MINT, slot: 100n, singleState: false },
      { chain: 200012n, mint: WSOL_MINT,        slot: 200n, singleState: true  },
      { chain: 999n,    mint: null,             slot: 300n, singleState: false },
    ]);
    const entries = parseOwnerInfoData(buf);
    expect(entries).toHaveLength(3);
    expect(entries[1]?.mint?.equals(WSOL_MINT)).toBe(true);
    expect(entries[1]?.singleState).toBe(true);
    expect(entries[2]?.mint).toBeNull();
    expect(entries[2]?.chain).toBe(999n);
  });

  it("returns empty array on a header-only account (no entries registered)", () => {
    const buf = buildOwnerInfoBuffer([]);
    expect(parseOwnerInfoData(buf)).toEqual([]);
  });

  it("throws on malformed (truncated) account data", () => {
    const buf = Buffer.alloc(20); // < header + one full entry
    buf[0] = 5; buf[1] = 2;        // valid header
    expect(() => parseOwnerInfoData(buf)).toThrow(/owner_info|malformed|size/i);
  });
});

describe("OwnerInfoClient.listEntries", () => {
  it("fetches account info from RPC, parses, returns entries", async () => {
    const buf = buildOwnerInfoBuffer([
      { chain: 200010n, mint: USDC_DEVNET_MINT, slot: 12345n, singleState: false },
    ]);
    const getAccountInfo = vi.fn().mockResolvedValue({ data: buf, executable: false, lamports: 1, owner: HADRIAN_PROGRAM, rentEpoch: 0 });
    const client = new OwnerInfoClient({ connection: { getAccountInfo } as any });
    const entries = await client.listEntries(HADRIAN_PROGRAM);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.chain).toBe(200010n);
    expect(getAccountInfo).toHaveBeenCalledWith(expect.any(PublicKey), { commitment: "confirmed" });
  });

  it("returns empty array when the account doesn't exist (PDA never initialized)", async () => {
    const getAccountInfo = vi.fn().mockResolvedValue(null);
    const client = new OwnerInfoClient({ connection: { getAccountInfo } as any });
    const entries = await client.listEntries(HADRIAN_PROGRAM);
    expect(entries).toEqual([]);
  });
});

describe("OwnerInfoClient.getMintForChain", () => {
  it("returns the mint pubkey for a registered chain", async () => {
    const buf = buildOwnerInfoBuffer([
      { chain: 200010n, mint: USDC_DEVNET_MINT, slot: 0n, singleState: false },
      { chain: 200012n, mint: WSOL_MINT,        slot: 0n, singleState: false },
    ]);
    const getAccountInfo = vi.fn().mockResolvedValue({ data: buf, executable: false, lamports: 1, owner: HADRIAN_PROGRAM, rentEpoch: 0 });
    const client = new OwnerInfoClient({ connection: { getAccountInfo } as any });
    expect((await client.getMintForChain(HADRIAN_PROGRAM, 200010n))?.equals(USDC_DEVNET_MINT)).toBe(true);
    expect((await client.getMintForChain(HADRIAN_PROGRAM, 200012n))?.equals(WSOL_MINT)).toBe(true);
  });

  it("returns null for an unregistered chain", async () => {
    const buf = buildOwnerInfoBuffer([{ chain: 200010n, mint: USDC_DEVNET_MINT, slot: 0n, singleState: false }]);
    const getAccountInfo = vi.fn().mockResolvedValue({ data: buf, executable: false, lamports: 1, owner: HADRIAN_PROGRAM, rentEpoch: 0 });
    const client = new OwnerInfoClient({ connection: { getAccountInfo } as any });
    expect(await client.getMintForChain(HADRIAN_PROGRAM, 999n)).toBeNull();
  });
});
