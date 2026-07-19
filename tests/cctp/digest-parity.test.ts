/**
 * Regression (found via live E2E, settle-v2 SignerNotUser): the digest the
 * CLIENT actually signs — hashTypedData over the quote's `signatureRequests[0]`
 * typedData, whose values are STRINGIFIED for JSON transport — MUST equal the
 * numeric/program digest (the golden vector the on-chain program recomputes).
 * If they diverge, client sign + POST-verify still agree with each other
 * (both stringified) but the program rejects with SignerNotUser.
 */
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { hashTypedData, type Hex } from "viem";
import { buildSettleAuthorizationRequest } from "../../src/cctp/settle-auth";
import { settleAuthorizationDigest } from "../../src/cctp/eip712-settle";

// Golden fixture — identical to settle_inbound_bridge_v2.rs (Rust === viem === pycryptodome).
const P = {
  romeEvmProgramId: new PublicKey("RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf"),
  sourceEvmChainId: 11155111n,
  destinationChainId: 200010n,
  mint: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  amount: 1000000n,
  sourceChain: 11155111n,
  deadline: 1751630000n,
};
const BURN = ("0x" + "ab".repeat(32)) as Hex;
const GOLDEN = "0x0237b5760e2d135e1d9d2049e365d73023bfed0a49f8392a1bf8ecbef0d9996e";

describe("EIP-712 digest parity: stringified quote typedData vs numeric/program", () => {
  it("numeric path equals the golden vector (sanity)", () => {
    expect(settleAuthorizationDigest({ ...P, sourceTxHash: BURN })).toBe(GOLDEN);
  });

  it("STRINGIFIED quote typedData (what the client signs) equals the golden vector", () => {
    const req = buildSettleAuthorizationRequest(P); // stringifies chainId + message uints (JSON transport)
    const td = { ...req.typedData, message: { ...req.typedData.message, sourceTxHash: BURN } };
    const clientDigest = hashTypedData(td as never);
    expect(clientDigest).toBe(GOLDEN); // if this fails → the on-chain SignerNotUser bug
  });
});
