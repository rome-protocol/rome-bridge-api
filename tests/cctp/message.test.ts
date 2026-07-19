import { describe, it, expect } from "vitest";
import { parseCctpMessage } from "../../src/cctp/message.js";

/**
 * Build a synthetic CCTP v1 message:
 *   header (116B) = [version:u32 | sourceDomain:u32 | destDomain:u32 | nonce:u64 |
 *                    sender:32 | recipient:32 | destCaller:32]
 *   body   (132B) = [bodyVersion:u32 | burnToken:32 | mintRecipient:32 |
 *                    amount:u256 | messageSender:32]
 * All multi-byte fields are big-endian on the wire.
 */
function buildMessage(opts: {
  version?: number; sourceDomain: number; destDomain: number; nonce: bigint;
  sender?: Uint8Array; recipient?: Uint8Array; destCaller?: Uint8Array;
  burnToken: Uint8Array; mintRecipient: Uint8Array; amount: bigint;
  messageSender?: Uint8Array;
  bodyVersion?: number;
}): Uint8Array {
  const buf = Buffer.alloc(248);
  buf.writeUInt32BE(opts.version ?? 0,      0);
  buf.writeUInt32BE(opts.sourceDomain,      4);
  buf.writeUInt32BE(opts.destDomain,        8);
  buf.writeBigUInt64BE(opts.nonce,         12);
  buf.set(opts.sender     ?? new Uint8Array(32), 20);
  buf.set(opts.recipient  ?? new Uint8Array(32), 52);
  buf.set(opts.destCaller ?? new Uint8Array(32), 84);

  buf.writeUInt32BE(opts.bodyVersion ?? 0, 116);
  if (opts.burnToken.length !== 32)     throw new Error("burnToken must be 32 bytes");
  if (opts.mintRecipient.length !== 32) throw new Error("mintRecipient must be 32 bytes");
  buf.set(opts.burnToken,     120);
  buf.set(opts.mintRecipient, 152);
  const amtHex = opts.amount.toString(16).padStart(64, "0");
  buf.set(Buffer.from(amtHex, "hex"), 184);
  buf.set(opts.messageSender ?? new Uint8Array(32), 216);

  return new Uint8Array(buf);
}

const SEPOLIA_USDC_PADDED = Buffer.from(
  "0000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c7238",
  "hex",
);
const SOLANA_PUBKEY_32 = Buffer.from(
  "0a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728ff",
  "hex",
);

describe("parseCctpMessage", () => {
  it("decodes a v1 BurnMessage with known fields", () => {
    const msg = buildMessage({
      sourceDomain: 0, destDomain: 5, nonce: 12345n,
      burnToken: new Uint8Array(SEPOLIA_USDC_PADDED),
      mintRecipient: new Uint8Array(SOLANA_PUBKEY_32),
      amount: 1_000_000n,
    });

    const p = parseCctpMessage(msg);
    expect(p.version).toBe(0);
    expect(p.sourceDomain).toBe(0);
    expect(p.destDomain).toBe(5);
    expect(p.nonce).toBe(12345n);
    expect(p.amount).toBe(1_000_000n);
    expect(Buffer.from(p.burnToken).toString("hex")).toBe(SEPOLIA_USDC_PADDED.toString("hex"));
    expect(Buffer.from(p.mintRecipient).toString("hex")).toBe(SOLANA_PUBKEY_32.toString("hex"));
  });

  it("preserves field widths (sender/recipient/destCaller/messageSender are 32B each)", () => {
    const sender        = Buffer.alloc(32, 0xaa);
    const recipient     = Buffer.alloc(32, 0xbb);
    const destCaller    = Buffer.alloc(32, 0xcc);
    const messageSender = Buffer.alloc(32, 0xdd);
    const msg = buildMessage({
      sourceDomain: 0, destDomain: 5, nonce: 1n,
      sender, recipient, destCaller, messageSender,
      burnToken: new Uint8Array(SEPOLIA_USDC_PADDED),
      mintRecipient: new Uint8Array(SOLANA_PUBKEY_32),
      amount: 1n,
    });

    const p = parseCctpMessage(msg);
    expect(Buffer.from(p.sender).toString("hex")).toBe(sender.toString("hex"));
    expect(Buffer.from(p.recipient).toString("hex")).toBe(recipient.toString("hex"));
    expect(Buffer.from(p.destCaller).toString("hex")).toBe(destCaller.toString("hex"));
    expect(Buffer.from(p.messageSender).toString("hex")).toBe(messageSender.toString("hex"));
  });

  it("handles amount near 2^256 - 1", () => {
    const maxAmt = (1n << 256n) - 1n;
    const msg = buildMessage({
      sourceDomain: 0, destDomain: 5, nonce: 1n,
      burnToken: new Uint8Array(SEPOLIA_USDC_PADDED),
      mintRecipient: new Uint8Array(SOLANA_PUBKEY_32),
      amount: maxAmt,
    });
    const p = parseCctpMessage(msg);
    expect(p.amount).toBe(maxAmt);
  });

  it("throws when message is shorter than 248 bytes", () => {
    expect(() => parseCctpMessage(new Uint8Array(247)))
      .toThrow(/too short/i);
  });

  it("exposes burnToken20 — the unpadded 20-byte EVM address slice", () => {
    // Convenience: callers (settle/builder side) often need the EVM address
    // without the left-padding. Verify it matches the trailing 20 bytes.
    const msg = buildMessage({
      sourceDomain: 0, destDomain: 5, nonce: 1n,
      burnToken: new Uint8Array(SEPOLIA_USDC_PADDED),
      mintRecipient: new Uint8Array(SOLANA_PUBKEY_32),
      amount: 1n,
    });
    const p = parseCctpMessage(msg);
    expect(Buffer.from(p.burnToken20).toString("hex"))
      .toBe("1c7d4b196cb0c7b01d743fbc6116a902379c7238");
  });
});
