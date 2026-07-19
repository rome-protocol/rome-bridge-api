import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { parseCctpMessageV2 } from "../../src/cctp/message-v2";
import { parseCctpMessageView } from "../../src/cctp/lens";

/**
 * Fixtures are REAL captured V2 messages (Monad domain 15 + Sepolia domain 0)
 * from the Rome app e2e/monad-cctp-v2-probe, each carrying an independent decode
 * to assert against. 376 bytes = 148B V2 header + 228B BurnMessage body.
 */
const FIX = join(__dirname, "..", "fixtures", "cctp-v2");
const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));
const load = (name: string) => {
  const f = JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8"));
  return { msg: hexToBytes(f.message), decoded: f.decodedMessage, body: f.decodedMessage.decodedMessageBody };
};

for (const name of ["monad-burn-01", "sepolia-burn-01"]) {
  describe(`parseCctpMessageV2 — captured ${name}`, () => {
    const { msg, decoded, body } = load(name);

    it("parses every header field to the fixture's independent decode", () => {
      const p = parseCctpMessageV2(msg);
      expect(p.version).toBe(1); // V2 protocol uses message-format version 1
      expect(p.sourceDomain).toBe(Number(decoded.sourceDomain));
      expect(p.destDomain).toBe(Number(decoded.destinationDomain));
      expect("0x" + Buffer.from(p.nonce).toString("hex")).toBe(decoded.nonce);
      expect(Buffer.from(p.sender.subarray(12)).toString("hex")).toBe(decoded.sender.slice(2));
      expect(Buffer.from(p.recipient)).toEqual(Buffer.from(new PublicKey(decoded.recipient).toBytes()));
      expect(Buffer.from(p.destCaller)).toEqual(Buffer.from(new PublicKey(decoded.destinationCaller).toBytes()));
      expect(p.minFinalityThreshold).toBe(Number(decoded.minFinalityThreshold));
      expect(p.finalityThresholdExecuted).toBe(Number(decoded.finalityThresholdExecuted));
    });

    it("parses every burn-body field to the fixture's independent decode", () => {
      const p = parseCctpMessageV2(msg);
      expect("0x" + Buffer.from(p.burnToken20).toString("hex")).toBe(body.burnToken);
      expect(Buffer.from(p.mintRecipient)).toEqual(Buffer.from(new PublicKey(body.mintRecipient).toBytes()));
      expect(p.amount).toBe(BigInt(body.amount));
      expect("0x" + Buffer.from(p.messageSender.subarray(12)).toString("hex")).toBe(body.messageSender);
      expect(p.maxFee).toBe(BigInt(body.maxFee));
      expect(p.feeExecuted).toBe(BigInt(body.feeExecuted));
      expect(p.expirationBlock).toBe(BigInt(body.expirationBlock));
    });
  });
}

describe("parseCctpMessageV2 — refusals", () => {
  it("rejects messages shorter than header+body", () => {
    expect(() => parseCctpMessageV2(new Uint8Array(100))).toThrow(/too short/);
  });
});

describe("version-blind common view (lens)", () => {
  it("V2 view exposes the normalized 32-byte hex nonce + shared fields", () => {
    const { msg, decoded, body } = load("monad-burn-01");
    const v = parseCctpMessageView(msg, 2);
    expect(v.cctpVersion).toBe(2);
    expect(v.sourceDomain).toBe(15);
    expect(v.nonce).toBe(decoded.nonce); // already 32B hex
    expect(v.amount).toBe(BigInt(body.amount));
    expect("0x" + Buffer.from(v.burnToken20).toString("hex")).toBe(body.burnToken);
    expect(v.nonceBytes32).toBeDefined();
    expect(v.nonceU64).toBeUndefined();
  });

  it("V1 view left-pads the u64 nonce into the same 32-byte hex shape", () => {
    // Synthetic V1 message (248B): header nonce u64 = 12345.
    const buf = Buffer.alloc(248);
    buf.writeUInt32BE(0, 0);          // version
    buf.writeUInt32BE(0, 4);          // sourceDomain (Sepolia)
    buf.writeUInt32BE(5, 8);          // destDomain (Solana)
    buf.writeBigUInt64BE(12345n, 12); // nonce u64
    buf.writeUInt32BE(0, 116);        // body version
    Buffer.from("00".repeat(12) + "1c7d4b196cb0c7b01d743fbc6116a902379c7238", "hex").copy(buf, 120); // burnToken
    buf.writeBigUInt64BE(200000n, 184 + 24); // amount u256 (low word)
    const v = parseCctpMessageView(new Uint8Array(buf), 1);
    expect(v.cctpVersion).toBe(1);
    expect(v.nonce).toBe("0x" + "0".repeat(60) + "3039"); // 12345 left-padded to 32B
    expect(v.nonceU64).toBe(12345n);
    expect(v.nonceBytes32).toBeUndefined();
    expect(v.amount).toBe(200000n);
    expect(v.sourceDomain).toBe(0);
  });

  it("both versions expose the identical shared shape (downstream is version-blind)", () => {
    const { msg } = load("sepolia-burn-01");
    const v2 = parseCctpMessageView(msg, 2);
    const shared = ["cctpVersion", "sourceDomain", "destDomain", "nonce", "sender", "recipient", "destCaller", "burnToken", "burnToken20", "mintRecipient", "amount", "messageSender"] as const;
    for (const k of shared) expect(v2[k], `missing shared field ${k}`).toBeDefined();
  });
});
