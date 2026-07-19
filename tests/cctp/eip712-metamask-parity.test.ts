/**
 * MetaMask ↔ viem ↔ server digest parity for the SettleAuthorization request.
 *
 * The blind spot this closes (live-diagnosed): the emitted typedData.types
 * carried only SettleAuthorization — no EIP712Domain. viem's hashTypedData
 * auto-derives EIP712Domain from the domain object, so viem↔viem tests (and
 * viem-signing harnesses) always agreed. MetaMask's eth_signTypedData_v4
 * (eth-sig-util) instead falls back to an EMPTY domain type when
 * types.EIP712Domain is absent — the domain separator degenerates to
 * keccak256(keccak256("EIP712Domain()")), ignoring name/version/chainId/salt —
 * so real wallets signed digest_A while the server recovered against digest_B and
 * recovery landed on a garbage address.
 *
 * eth-sig-util here IS the wallet-faithful signer: these tests exercise the
 * exact eth_signTypedData_v4 code path MetaMask runs.
 */
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TypedDataUtils, SignTypedDataVersion, signTypedData as mmSignTypedData } from "@metamask/eth-sig-util";
import { buildSettleAuthorizationRequest, verifyAgainstTypedData } from "../../src/cctp/settle-auth.js";

const BURN = ("0x" + "ab".repeat(32)) as `0x${string}`;
// Throwaway test-only key (deterministic; never funded).
const TEST_PRIVKEY = ("0x" + "11".repeat(32)) as `0x${string}`;
const TEST_ADDRESS = privateKeyToAccount(TEST_PRIVKEY).address;

function wireRequest() {
  return buildSettleAuthorizationRequest({
    romeEvmProgramId: new PublicKey("RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf"),
    sourceEvmChainId: 11155111n,
    destinationChainId: 200010n,
    mint: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
    amount: 1_000_000n,
    sourceChain: 11155111n,
    deadline: 1790000000n,
  });
}

/** The payload a wallet receives: the wire request with the burn hash filled. */
function filledPayload() {
  const req = wireRequest();
  return {
    ...req.typedData,
    message: { ...req.typedData.message, sourceTxHash: BURN },
  };
}

describe("SettleAuthorization typed-data — MetaMask (eth_signTypedData_v4) parity", () => {
  it("emits an explicit EIP712Domain type in viem's canonical order, matching the domain's fields", () => {
    const req = wireRequest();
    expect((req.typedData.types as Record<string, unknown>).EIP712Domain).toEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ]);
  });

  it("eth-sig-util (MetaMask) and viem hash the SAME wire payload to the SAME digest", () => {
    const payload = filledPayload();
    const viemDigest = hashTypedData(payload as never);
    const mmDigest = ("0x" +
      Buffer.from(TypedDataUtils.eip712Hash(payload as never, SignTypedDataVersion.V4)).toString("hex")) as `0x${string}`;
    expect(mmDigest).toBe(viemDigest);
  });

  it("a MetaMask-faithful signature over the wire payload verifies through the server's recovery", () => {
    const req = wireRequest();
    const signature = mmSignTypedData({
      privateKey: Buffer.from(TEST_PRIVKEY.slice(2), "hex"),
      data: filledPayload() as never,
      version: SignTypedDataVersion.V4,
    });
    const verified = verifyAgainstTypedData(req.typedData as never, BURN, TEST_ADDRESS, signature);
    expect(verified).toMatchObject({ ok: true });
  });

  it("a viem signature still verifies (regression: the explicit type must not shift viem's digest)", async () => {
    const req = wireRequest();
    const account = privateKeyToAccount(TEST_PRIVKEY);
    const signature = await account.signTypedData(filledPayload() as never);
    const verified = verifyAgainstTypedData(req.typedData as never, BURN, TEST_ADDRESS, signature);
    expect(verified).toMatchObject({ ok: true });
  });
});
