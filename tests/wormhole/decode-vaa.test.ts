import { describe, it, expect } from "vitest";
import { decodeVaa } from "../../src/wormhole/decode-vaa";

// Wormholescan returns the signed VAA base64-encoded in `data.vaa`
// (src/attestation/wormhole.ts). the Rome app and the @wormhole-foundation SDK both
// decode it as base64 (`Buffer.from(vaa, "base64")`). The prior bug decoded it
// as `Buffer.from(vaa.slice(2), "hex")` — slice(2) assumes a "0x" prefix the
// string never carries, and hex-parsing a base64 string yields garbage → the
// Solana receive flow gets a corrupt VAA and completion fails on-chain.
describe("decodeVaa", () => {
  // A representative VAA byte prefix (version 0x01, guardian-set 0, …).
  const raw = Uint8Array.from([1, 0, 0, 0, 0, 0, 12, 255, 200, 42, 7, 99, 250, 16, 88, 3]);
  const b64 = Buffer.from(raw).toString("base64");

  it("decodes a base64 VAA to the exact bytes", () => {
    expect(Uint8Array.from(decodeVaa(b64))).toEqual(raw);
  });

  it("does not corrupt the VAA by treating it as 0x-hex (regression)", () => {
    const buggyHex = Uint8Array.from(Buffer.from(b64.slice(2), "hex"));
    expect(Uint8Array.from(decodeVaa(b64))).not.toEqual(buggyHex);
  });
});
