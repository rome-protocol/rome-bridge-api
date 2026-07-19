import { describe, it, expect } from "vitest";
import { RowCipher, generateRowKeyBase64 } from "../../src/lib/row-crypto";

const KEY = generateRowKeyBase64();

describe("RowCipher — AES-GCM-256 at-rest encryption for user settle sigs", () => {
  it("round-trips a 65-byte signature", () => {
    const cipher = new RowCipher(KEY);
    const sig = "0x" + "ab".repeat(65);
    const enc = cipher.encrypt(sig);
    expect(enc).not.toContain(sig.slice(2)); // ciphertext must not leak the plaintext
    expect(cipher.decrypt(enc)).toBe(sig);
  });

  it("every encryption uses a fresh IV (ciphertexts differ; both decrypt)", () => {
    const cipher = new RowCipher(KEY);
    const sig = "0x" + "cd".repeat(65);
    const a = cipher.encrypt(sig);
    const b = cipher.encrypt(sig);
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe(sig);
    expect(cipher.decrypt(b)).toBe(sig);
  });

  it("a tampered ciphertext fails the GCM auth tag", () => {
    const cipher = new RowCipher(KEY);
    const enc = cipher.encrypt("0x" + "11".repeat(65));
    const bytes = Buffer.from(enc, "base64");
    bytes[bytes.length - 1] ^= 0xff; // flip a tag byte
    expect(() => cipher.decrypt(bytes.toString("base64"))).toThrow();
  });

  it("a different key cannot decrypt", () => {
    const enc = new RowCipher(KEY).encrypt("0x" + "22".repeat(65));
    expect(() => new RowCipher(generateRowKeyBase64()).decrypt(enc)).toThrow();
  });

  it("rejects a malformed key (must be 32 bytes base64)", () => {
    expect(() => new RowCipher("too-short")).toThrow(/32 bytes/);
  });
});
