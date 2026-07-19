import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { makeGasMintResolver } from "../../src/chains/gas-mint-resolver";
import { OWNER_INFO_HEADER_SIZE, OWNER_INFO_ENTRY_SIZE } from "../../src/chains/owner-info-reader";

const PROGRAM = "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8";
const GAS_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // devnet USDC

/** Build a one-entry OwnerInfo account buffer (header + 50-byte entry). */
function ownerInfoBuf(chainId: bigint, mint: string | null): Buffer {
  const buf = Buffer.alloc(OWNER_INFO_HEADER_SIZE + OWNER_INFO_ENTRY_SIZE);
  buf[0] = 1; // account_type
  buf[1] = 1; // version
  const off = OWNER_INFO_HEADER_SIZE;
  buf.writeBigUInt64LE(chainId, off);
  if (mint) {
    buf[off + 8] = 1; // Some
    new PublicKey(mint).toBuffer().copy(buf, off + 9);
  } else {
    buf[off + 8] = 0; // None
  }
  buf.writeBigUInt64LE(0n, off + 41); // slot
  buf[off + 49] = 0; // single_state
  return buf;
}

class FakeConn {
  calls = 0;
  constructor(private buf: Buffer | null) {}
  async getAccountInfo() {
    this.calls++;
    return this.buf ? { data: this.buf } : null;
  }
}

describe("makeGasMintResolver", () => {
  it("resolves the on-chain gas mint for a registered chain", async () => {
    const conn = new FakeConn(ownerInfoBuf(121301n, GAS_MINT));
    const r = makeGasMintResolver(conn as never);
    expect(await r.resolve(PROGRAM, "121301")).toBe(GAS_MINT);
  });

  it("caches within TTL — a second call issues no RPC", async () => {
    const conn = new FakeConn(ownerInfoBuf(121301n, GAS_MINT));
    const r = makeGasMintResolver(conn as never);
    await r.resolve(PROGRAM, "121301");
    await r.resolve(PROGRAM, "121301");
    expect(conn.calls).toBe(1);
  });

  it("returns null when the chain is not registered on-chain", async () => {
    const conn = new FakeConn(ownerInfoBuf(999n, GAS_MINT));
    const r = makeGasMintResolver(conn as never);
    expect(await r.resolve(PROGRAM, "121301")).toBeNull();
  });

  it("returns null (never throws) when the OwnerInfo account is missing", async () => {
    const conn = new FakeConn(null);
    const r = makeGasMintResolver(conn as never);
    expect(await r.resolve(PROGRAM, "121301")).toBeNull();
  });
});
