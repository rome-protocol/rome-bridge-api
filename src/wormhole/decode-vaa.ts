/**
 * Decode a signed Wormhole VAA (as returned by Wormholescan `data.vaa`) into
 * raw bytes for the Solana receive flow / @wormhole-foundation/sdk deserialize().
 *
 * Wormholescan returns the VAA base64-encoded — decode it as base64, exactly as
 * the Rome app and the SDK do. (The prior `Buffer.from(vaa.slice(2), "hex")` assumed
 * a "0x" prefix that never exists and hex-parsed base64 → a corrupt VAA that
 * failed completion on-chain.)
 */
export function decodeVaa(vaa: string): Uint8Array {
  return new Uint8Array(Buffer.from(vaa, "base64"));
}
