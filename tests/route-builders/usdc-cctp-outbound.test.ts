import { describe, it, expect } from "vitest";
import { buildUsdcCctpOutboundQuote } from "../../src/route-builders/usdc-cctp-outbound";
import { loadFixtureChain } from "../helpers/chains";

// v6 golden tests (calldata, per-destination domains, claim metadata) live in
// cctp-outbound-v6.test.ts; this file keeps the route-shape + validation
// regression coverage against the published Hadrian fixture.
const HADRIAN = await loadFixtureChain("200010");
const EVM = "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562";
const base = {
  amount: "100000000",
  sender: { rome: EVM, ethereum: EVM },
  recipient: EVM,
  chain: HADRIAN,
  programId: HADRIAN.romeEvmProgramId!,
};

describe("buildUsdcCctpOutboundQuote", () => {
  it("produces 2 steps: rome burn → destination claim", () => {
    const q = buildUsdcCctpOutboundQuote(base);
    expect(q.route).toBe("usdc-cctp-from-rome");
    expect(q.steps).toHaveLength(2);
    expect(q.steps[0]?.chain).toBe("rome-200010");
    expect(q.steps[0]?.kind).toBe("cctp-burn-usdc");
    expect(q.steps[0]?.unsignedTxs).toHaveLength(1);
    expect(q.steps[1]?.chain).toBe("evm-11155111"); // default destination = the chain's default source entry
    expect(q.steps[1]?.kind).toBe("cctp-claim-on-destination");
    expect(q.steps[1]?.blockedBy).toContain("step-1");
    expect(q.steps[1]?.blockedBy).toContain("circle-attestation");
  });

  it("exposes burnToken = the Rome-side wUSDC wrapper so a client shows the bridgeable balance, not native gas", () => {
    // burnUSDC burns the 6-dec wUSDC spl_wrapper, NOT the 18-dec native gas
    // USDC. Without this a client reads the gas balance, users over-enter, and
    // the burn reverts InsufficientBalance (MetaMask then shows a garbage fee).
    const q = buildUsdcCctpOutboundQuote(base);
    expect((q as { burnToken?: string }).burnToken).toBe("0xd4cc34b67c805d472b5a709a22a1037f6b16ef28");
    // wUSDC is 6-dec on-chain; route amountIn is also 6-dec → burnAmount == amountIn.
    expect((q as { burnTokenDecimals?: number }).burnTokenDecimals).toBe(6);
    expect((q as { burnAmount?: string }).burnAmount).toBe(base.amount);
  });

  it("rejects amount below minimum ON MAINNET (devnet floor is 1 base unit — see amount-floor.test.ts)", () => {
    expect(() =>
      buildUsdcCctpOutboundQuote({ ...base, amount: "500000", chain: { ...HADRIAN, network: "mainnet" } }),
    ).toThrow(/amount/);
  });

  it("rejects missing sender.rome", () => {
    expect(() => buildUsdcCctpOutboundQuote({ ...base, sender: { ethereum: EVM } })).toThrow(/sender.rome/);
  });

  it("rejects a non-EVM recipient (outbound delivers to an EVM address)", () => {
    expect(() => buildUsdcCctpOutboundQuote({ ...base, recipient: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA" })).toThrow(/recipient/);
  });
});
