import { describe, it, expect } from "vitest";
import { verifyEvmTxMatchesQuote } from "../../src/transfers/verify";

// Rome-side egress. The burn targets RomeBridgeWithdraw, which the registry
// resolves by status at QUOTE time — but verification only compared the tx to
// the quote, so a quote issued before a rotation still verified afterwards,
// against a contract the registry had already retired.
const LIVE = "0xAAAA000000000000000000000000000000000001";
const DEPRECATED = "0xBBBB000000000000000000000000000000000002";
const RETIRED = "0xCCCC000000000000000000000000000000000003";
const DATA = "0x1a2b3c4d" + "00".repeat(32);

const stepTo = (to: string) => ({
  n: 1, chain: "rome", kind: "rome-withdraw",
  unsignedTxs: [{ to, data: DATA, value: "0", estimatedGas: "180000" }],
});
const txTo = (to: string) => ({ to, data: DATA, value: "0" });

const CHAIN = {
  contracts: [
    {
      name: "RomeBridgeWithdraw",
      versions: [
        { address: RETIRED.toLowerCase(), version: "8.0.0", status: "retired" },
        { address: DEPRECATED.toLowerCase(), version: "9.0.0", status: "deprecated" },
        { address: LIVE.toLowerCase(), version: "10.0.0", status: "live" },
      ],
    },
  ],
};

describe("egress graded by registry status", () => {
  it("accepts the live withdraw contract with no warning", () => {
    const r = verifyEvmTxMatchesQuote(stepTo(LIVE), txTo(LIVE), undefined, CHAIN);
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("accepts a DEPRECATED contract but warns, naming the live successor", () => {
    const r = verifyEvmTxMatchesQuote(stepTo(DEPRECATED), txTo(DEPRECATED), undefined, CHAIN);
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/deprecated/i);
    expect(r.warning?.toLowerCase()).toContain(LIVE.toLowerCase());
  });

  it("REJECTS a retired contract even though the tx matches its own quote", () => {
    const r = verifyEvmTxMatchesQuote(stepTo(RETIRED), txTo(RETIRED), undefined, CHAIN);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/retired/i);
    expect(r.reason?.toLowerCase()).toContain(LIVE.toLowerCase());
  });

  // The whole point: self-consistency with the quote is exactly what the old
  // code checked, and it is what a stale quote still satisfies.
  it("the retired case is self-consistent — it is the STATUS that rejects it", () => {
    const withoutChain = verifyEvmTxMatchesQuote(stepTo(RETIRED), txTo(RETIRED));
    expect(withoutChain.ok).toBe(true);
  });

  it("does not grade an address the registry does not list (e.g. CCTP TokenMessenger)", () => {
    const external = "0xDDDD000000000000000000000000000000000004";
    const r = verifyEvmTxMatchesQuote(stepTo(external), txTo(external), undefined, CHAIN);
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("still rejects a to-mismatch before it ever looks at status", () => {
    const r = verifyEvmTxMatchesQuote(stepTo(LIVE), txTo(RETIRED), undefined, CHAIN);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/to mismatch/);
  });
});
