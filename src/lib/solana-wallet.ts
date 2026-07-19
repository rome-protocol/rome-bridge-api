import { PublicKey } from "@solana/web3.js";
import { bridgeError } from "../errors.js";

/**
 * Parse a caller-supplied Solana WALLET address for a source-side signer.
 * A signing wallet is an ed25519 keypair pubkey — it must be ON-CURVE. An
 * off-curve address (a PDA or an ATA) can never sign, and passing one to
 * `getAssociatedTokenAddressSync` throws `TokenOwnerOffCurveError` deep in the
 * builder → an opaque 500. Validate up front and fail clean (400).
 */
export function parseWalletPubkey(addr: string, ctx: string): PublicKey {
  let key: PublicKey;
  try {
    key = new PublicKey(addr);
  } catch {
    throw bridgeError("rome.bridge.recipient-invalid", `${ctx}: '${addr}' is not a valid Solana address`);
  }
  if (!PublicKey.isOnCurve(key.toBytes())) {
    throw bridgeError("rome.bridge.recipient-invalid", `${ctx}: '${addr}' is off-curve — a signing wallet must be an on-curve account, not a PDA or token account`);
  }
  return key;
}
