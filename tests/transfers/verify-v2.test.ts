import { describe, it, expect } from "vitest";
import { toFunctionSelector } from "viem";
import { verifyEvmTxMatchesQuote } from "../../src/transfers/verify";
import type { RecordStampT } from "../../src/transfers/types";

const V2_SELECTOR = toFunctionSelector("function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)");
const V1_SELECTOR = "0x6fd3504e";

const V2_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const V1_MESSENGER = "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5";

const stampV2: RecordStampT = {
  sourceChainId: 10143, cctpVersion: 2, cctpDomain: 15,
  irisBase: "https://iris-api-sandbox.circle.com",
  cctpTokenMessenger: V2_MESSENGER,
};
const stampV1: RecordStampT = {
  sourceChainId: 11155111, cctpVersion: 1, cctpDomain: 0,
  irisBase: "https://iris-api-sandbox.circle.com/v1",
  cctpTokenMessenger: V1_MESSENGER,
};

const step = (to: string, selector: string) => ({
  n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit",
  unsignedTxs: [
    { to: "0xToken", data: "0x095ea7b3" + "00".repeat(64), value: "0", estimatedGas: "1", description: "approve" },
    { to, data: selector + "ab".repeat(64), value: "0", estimatedGas: "1", description: "burn" },
  ],
});
const onchainFor = (s: ReturnType<typeof step>) => {
  const last = s.unsignedTxs.at(-1)!;
  return { to: last.to, data: last.data, value: last.value };
};

describe("stamp-bound verification", () => {
  it("accepts the recorded-version burn against the stamped messenger", () => {
    const s = step(V2_MESSENGER, V2_SELECTOR);
    expect(verifyEvmTxMatchesQuote(s, onchainFor(s), stampV2).ok).toBe(true);
    const s1 = step(V1_MESSENGER, V1_SELECTOR);
    expect(verifyEvmTxMatchesQuote(s1, onchainFor(s1), stampV1).ok).toBe(true);
  });

  it("rejects a cross-version burn even when quote == onchain (V1 selector under a V2 stamp)", () => {
    const s = step(V2_MESSENGER, V1_SELECTOR);
    const r = verifyEvmTxMatchesQuote(s, onchainFor(s), stampV2);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/version|selector/i);
  });

  it("rejects a quote whose burn targets a contract that is NOT the registry-stamped messenger", () => {
    const s = step("0xEvi1000000000000000000000000000000000bad", V2_SELECTOR);
    const r = verifyEvmTxMatchesQuote(s, onchainFor(s), stampV2);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/messenger|stamp/i);
  });

  it("a catalog edit after registration cannot retarget verification (stamp wins, not live config)", () => {
    // Same quote+onchain, stamp frozen at the OLD messenger: still passes —
    // verification never re-resolves from live config.
    const s = step(V2_MESSENGER, V2_SELECTOR);
    expect(verifyEvmTxMatchesQuote(s, onchainFor(s), { ...stampV2 }).ok).toBe(true);
  });

  it("stampless legacy call keeps the plain quote-equality behavior", () => {
    const s = step(V1_MESSENGER, V1_SELECTOR);
    expect(verifyEvmTxMatchesQuote(s, onchainFor(s)).ok).toBe(true);
  });
});
