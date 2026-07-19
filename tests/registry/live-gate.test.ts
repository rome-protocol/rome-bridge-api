import { describe, it, expect } from "vitest";
import { RegistryClient } from "../../src/registry/client";
import { buildUsdcCctpInboundQuote } from "../../src/route-builders/usdc-cctp-inbound";

/**
 * Phase-1 rollout gate: the quote path must
 * succeed against LIVE registry content, not fixtures. Gated: needs a synced
 * registry checkout. Run: REGISTRY_LIVE=1 REGISTRY_PATH=/path/to/rome-registry npm test
 */
const REGISTRY_PATH = process.env.REGISTRY_PATH;
const enabled = process.env.REGISTRY_LIVE === "1" && !!REGISTRY_PATH;

describe.skipIf(!enabled)("live registry gate (REGISTRY_LIVE=1)", () => {
  it("every live chain parses; Hadrian quotes CCTP inbound end-to-end", async () => {
    const client = new RegistryClient({ source: { kind: "local", path: REGISTRY_PATH! } });
    const chains = await client.listChains();
    expect(chains.length).toBeGreaterThanOrEqual(2);
    for (const chain of chains) {
      expect(chain.romeEvmProgramId, `${chain.slug} missing romeEvmProgramId`).toBeTruthy();
    }
    const hadrian = chains.find((c) => c.chainId === "200010");
    expect(hadrian).toBeDefined();
    const quote = buildUsdcCctpInboundQuote({
      amount: "1000000",
      sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: hadrian!,
      programId: hadrian!.romeEvmProgramId!,
      intent: "gas",
    });
    expect(quote.steps.length).toBeGreaterThanOrEqual(2);
  });
});
