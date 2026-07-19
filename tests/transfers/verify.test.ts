import { describe, it, expect } from "vitest";
import { verifyEvmTxMatchesQuote } from "../../src/transfers/verify";

const QUOTED_STEP = {
  n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit",
  unsignedTxs: [
    { to: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", data: "0x095ea7b3000000000000000000000000abc...", value: "0", estimatedGas: "60000" },
    { to: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", data: "0xf856ddb6000000000000000000000000000000000000000000000000000000000000006400000000000000000000000000000000000000000000000000000000000000050000000000000000000000003403e0de09bc76ca7d74762f264e4f6b649a05620000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c7238", value: "0", estimatedGas: "180000" },
  ],
};

describe("verifyEvmTxMatchesQuote", () => {
  it("accepts a tx whose to/data/value match the quote", () => {
    const onchainTx = {
      to: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
      data: "0xf856ddb6000000000000000000000000000000000000000000000000000000000000006400000000000000000000000000000000000000000000000000000000000000050000000000000000000000003403e0de09bc76ca7d74762f264e4f6b649a05620000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c7238",
      value: "0",
    };
    const r = verifyEvmTxMatchesQuote(QUOTED_STEP, onchainTx);
    expect(r.ok).toBe(true);
  });

  it("rejects on wrong to-address", () => {
    const r = verifyEvmTxMatchesQuote(QUOTED_STEP, { to: "0xdead", data: "0xf856ddb6...", value: "0" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/to/);
  });

  it("rejects on selector mismatch", () => {
    const r = verifyEvmTxMatchesQuote(QUOTED_STEP, { to: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", data: "0xdeadbeef00000000", value: "0" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/selector/);
  });

  it("rejects on non-zero value when quote requires zero", () => {
    const r = verifyEvmTxMatchesQuote(QUOTED_STEP, { to: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", data: QUOTED_STEP.unsignedTxs[1]?.data ?? "0x", value: "1" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/value/);
  });
});
