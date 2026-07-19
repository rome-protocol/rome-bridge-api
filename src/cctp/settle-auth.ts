/**
 * Settle-authorization request (quote-time) + verification (transfer-time)
 * for trustless settle.
 *
 * The user signs `SettleAuthorization` AFTER broadcasting the burn, because
 * the struct binds `sourceTxHash` (= the burn tx hash). So the quote emits a
 * TEMPLATE (all fields + a zero sourceTxHash placeholder + the deadline); the
 * client fills the real burn hash post-broadcast and signs; `POST /transfers`
 * carries the signature. The API re-verifies the sig recovers to the
 * recipient over the completed struct before storing it — the same check the
 * on-chain program makes, caught early.
 */
import { PublicKey } from "@solana/web3.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { hashTypedData, toHex, type Hex } from "viem";
import { settleAuthorizationTypedData, type SettleAuthorizationParams } from "./eip712-settle.js";

const ZERO_TX = ("0x" + "00".repeat(32)) as Hex;

export interface SettleAuthorizationRequest {
  kind: "settle-authorization-eip712";
  /** The message field the client must fill from the broadcast burn before signing. */
  fillFromBurn: "sourceTxHash";
  typedData: {
    // chainId MUST be numeric — viem hashes a string chainId to a DIFFERENT
    // domain separator than the on-chain program's uint256, causing SignerNotUser
    // (proven in tests/cctp/digest-parity.test.ts). JSON-safe: chain ids < 2^53.
    domain: { name: string; version: string; chainId: number; salt: Hex };
    types: unknown;
    primaryType: "SettleAuthorization";
    message: Record<string, string>;
  };
}

/** Quote-time: the typed-data template the wallet signs (sourceTxHash zeroed). */
export function buildSettleAuthorizationRequest(p: Omit<SettleAuthorizationParams, "sourceTxHash">): SettleAuthorizationRequest {
  const td = settleAuthorizationTypedData({ ...p, sourceTxHash: ZERO_TX });
  return {
    kind: "settle-authorization-eip712",
    fillFromBurn: "sourceTxHash",
    typedData: {
      domain: { ...td.domain, chainId: Number(td.domain.chainId) }, // numeric — see interface note
      types: td.types,
      primaryType: "SettleAuthorization",
      message: {
        destinationChainId: td.message.destinationChainId.toString(),
        mint: td.message.mint,
        amount: td.message.amount.toString(),
        sourceChain: td.message.sourceChain.toString(),
        sourceTxHash: ZERO_TX,
        deadline: td.message.deadline.toString(),
      },
    },
  };
}

export type VerifyResult =
  | { ok: true; r: Uint8Array; s: Uint8Array; v: number }
  | { ok: false; reason: string };

export interface VerifyInput extends Omit<SettleAuthorizationParams, "sourceTxHash"> {
  sourceTxHash: Hex;
  recipient: string;
  signature: string;
}

/** Transfer-time: recompute the digest from params over the completed struct and check recovery == recipient. */
export function verifySettleAuthorization(input: VerifyInput): VerifyResult {
  const td = settleAuthorizationTypedData({ ...input, sourceTxHash: input.sourceTxHash });
  return verifyAgainstTypedData(td as never, input.sourceTxHash, input.recipient, input.signature);
}

/**
 * Verify a settle sig against the EXACT typed-data the quote emitted, with the
 * client-filled burn hash. The route uses this so it doesn't reconstruct
 * registry params — the on-chain program is the authoritative gate (it
 * recomputes from registry truth); this is defense-in-depth early-reject.
 */
export function verifyAgainstTypedData(
  typedData: { domain: unknown; types: unknown; primaryType: string; message: Record<string, unknown> },
  sourceTxHash: Hex,
  recipient: string,
  signature: string,
): VerifyResult {
  const sig = signature.startsWith("0x") ? signature.slice(2) : signature;
  if (sig.length !== 130) return { ok: false, reason: `signature must be 65 bytes, got ${sig.length / 2}` };
  const v = parseInt(sig.slice(128, 130), 16);
  if (v !== 27 && v !== 28) return { ok: false, reason: `recovery byte v must be 27 or 28, got ${v}` };
  // EIP-2 low-s: the program rejects s > n/2 (NonCanonicalSignature). Mirror it
  // so a malleated high-s sig is caught before storage, not on-chain.
  const SECP256K1_N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
  if (BigInt("0x" + sig.slice(64, 128)) > SECP256K1_N_HALF) {
    return { ok: false, reason: "non-canonical signature (high-s; EIP-2) — the program rejects this" };
  }

  const completed = {
    ...typedData,
    message: { ...typedData.message, sourceTxHash },
  };
  let digest: Hex;
  let recovered: string;
  try {
    digest = hashTypedData(completed as never);
    recovered = recoverAddressSync(digest, signature as Hex);
  } catch (e) {
    return { ok: false, reason: `could not recover signer: ${(e as Error).message}` };
  }
  if (recovered.toLowerCase() !== recipient.toLowerCase()) {
    return { ok: false, reason: `signature recovers to ${recovered}, not recipient ${recipient}` };
  }
  return {
    ok: true,
    r: Uint8Array.from(Buffer.from(sig.slice(0, 64), "hex")),
    s: Uint8Array.from(Buffer.from(sig.slice(64, 128), "hex")),
    v,
  };
}

/**
 * viem's recoverAddress is async; @noble/curves (its dep) recovers
 * synchronously. Static ESM imports only — the server's dist runs as native ESM
 * where CJS require is undefined (every registration 500'd until this was
 * import-hoisted; tests/settle-auth-esm.test.ts is the tripwire).
 */
function recoverAddressSync(digest: Hex, signature: Hex): string {
  const sigHex = signature.slice(2);
  const r = sigHex.slice(0, 64);
  const s = sigHex.slice(64, 128);
  const recovery = parseInt(sigHex.slice(128, 130), 16) - 27;
  const sigObj = secp256k1.Signature.fromCompact(r + s).addRecoveryBit(recovery);
  const point = sigObj.recoverPublicKey(digest.slice(2));
  const pub = point.toRawBytes(false).slice(1); // drop 0x04 prefix
  const hash = keccak_256(pub);
  return "0x" + Buffer.from(hash.slice(12)).toString("hex");
}

/** bytes32 mint helper for callers building the params from a PublicKey. */
export function mintToBytes32(mint: PublicKey): Hex {
  return toHex(mint.toBytes());
}
