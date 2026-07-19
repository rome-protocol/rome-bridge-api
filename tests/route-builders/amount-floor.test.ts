import { describe, it, expect } from "vitest";
import { effectiveMinAmount, assertAmountInRange, ROUTE_SPECS } from "../../src/route-builders/route-keys";
import { buildUsdcCctpOutboundQuote } from "../../src/route-builders/usdc-cctp-outbound";
import { buildUsdcCctpInboundQuote } from "../../src/route-builders/usdc-cctp-inbound";
import { loadFixtureChain } from "../helpers/chains";

// The per-route minAmount floor exists to protect MAINNET users from
// net-negative bridges (destination gas exceeds the delivered value).
// On devnet/testnet chains value is play money and dust-probing a route
// with a tiny amount is the standard first test — so the floor collapses
// to 1 base unit off mainnet. maxAmount (blast-radius cap) applies
// everywhere. A chain with NO network field is treated as mainnet
// (fail-safe: registry drift must not silently drop the guardrail).
const SPEC = ROUTE_SPECS["usdc-cctp-from-rome"];
const HADRIAN = await loadFixtureChain("200010"); // network: devnet
const EVM = "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562";

describe("effectiveMinAmount", () => {
  it("devnet → 1 base unit", () => {
    expect(effectiveMinAmount(SPEC, { network: "devnet" })).toBe("1");
  });
  it("testnet → 1 base unit", () => {
    expect(effectiveMinAmount(SPEC, { network: "testnet" })).toBe("1");
  });
  it("mainnet → the route floor", () => {
    expect(effectiveMinAmount(SPEC, { network: "mainnet" })).toBe(SPEC.minAmount);
  });
  it("missing network → the route floor (fail-safe)", () => {
    expect(effectiveMinAmount(SPEC, {})).toBe(SPEC.minAmount);
  });
});

describe("assertAmountInRange", () => {
  it("accepts a sub-floor amount on a devnet chain", () => {
    expect(() => assertAmountInRange(SPEC, { amount: "500000", chain: { network: "devnet" } })).not.toThrow();
  });
  it("rejects zero everywhere (min is 1 base unit even off mainnet)", () => {
    expect(() => assertAmountInRange(SPEC, { amount: "0", chain: { network: "devnet" } })).toThrow(/amount/);
  });
  it("rejects a sub-floor amount on mainnet", () => {
    expect(() => assertAmountInRange(SPEC, { amount: "500000", chain: { network: "mainnet" } })).toThrow(/amount/);
  });
  it("enforces the max cap on every network", () => {
    const over = (BigInt(SPEC.maxAmount) + 1n).toString();
    expect(() => assertAmountInRange(SPEC, { amount: over, chain: { network: "devnet" } })).toThrow(/amount/);
    expect(() => assertAmountInRange(SPEC, { amount: over, chain: { network: "mainnet" } })).toThrow(/amount/);
  });
});

describe("builders honor the network-scoped floor (operator repro: 0.5 USDC Hadrian→Sepolia)", () => {
  const outBase = {
    amount: "500000", // 0.5 USDC — below the 1-USDC mainnet floor
    sender: { rome: EVM, ethereum: EVM },
    recipient: EVM,
    chain: HADRIAN,
    programId: HADRIAN.romeEvmProgramId!,
  };
  it("outbound CCTP quotes 0.5 USDC on devnet Hadrian", () => {
    const q = buildUsdcCctpOutboundQuote(outBase);
    expect(q.route).toBe("usdc-cctp-from-rome");
  });
  it("outbound CCTP still rejects 0.5 USDC when the chain is mainnet", () => {
    expect(() =>
      buildUsdcCctpOutboundQuote({ ...outBase, chain: { ...HADRIAN, network: "mainnet" } }),
    ).toThrow(/amount/);
  });
  it("inbound CCTP quotes 0.5 USDC on devnet Hadrian", () => {
    const q = buildUsdcCctpInboundQuote({
      ...outBase,
      sender: { ethereum: EVM },
    });
    expect(q.route).toBe("usdc-cctp-to-rome");
  });
});
