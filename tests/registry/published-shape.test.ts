import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RegistryClient } from "../../src/registry/client";
import { buildUsdcCctpInboundQuote } from "../../src/route-builders/usdc-cctp-inbound";

/**
 * Contract tests against the registry AS PUBLISHED — fixtures are generated
 * verbatim from a registry checkout by scripts/gen-registry-fixtures.ts
 * (never hand-written; see manifest.json for provenance).
 */
const FIXTURES = join(__dirname, "..", "fixtures", "registry");
const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"));

const client = () => new RegistryClient({ source: { kind: "local", path: FIXTURES } });

describe(`published registry shapes (registry ${manifest.registryVersion} @ ${manifest.gitSha.slice(0, 12)})`, () => {
  it("listChains parses published chain.json (numeric chainId, no slug field, romeEvmProgramId)", async () => {
    const chains = await client().listChains();
    expect(chains.length).toBeGreaterThanOrEqual(2); // hadrian + nerva are live today
    const hadrian = chains.find((c) => String(c.chainId) === "200010");
    expect(hadrian, "hadrian missing from listChains").toBeDefined();
    expect(hadrian!.romeEvmProgramId).toBe("RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf");
  });

  it("merges bridge.json into the chain config (sourceEvm + sourceEvms catalog + solana block)", async () => {
    const chains = await client().listChains();
    const hadrian = chains.find((c) => String(c.chainId) === "200010")!;
    const bridge = hadrian.bridge as Record<string, unknown> | undefined;
    expect(bridge, "bridge block missing — bridge.json not merged").toBeDefined();
    const sourceEvm = bridge!.sourceEvm as Record<string, unknown>;
    expect(sourceEvm.chainId).toBe(11155111);
    // the flat published fields — NOT the phantom nested sourceEvm.cctp.tokenMessenger shape
    expect(typeof sourceEvm.cctpTokenMessenger).toBe("string");
    expect(sourceEvm.cctpVersion).toBe(2);
    const sourceEvms = bridge!.sourceEvms as Array<{ chainId: number }>;
    expect(sourceEvms.length).toBeGreaterThanOrEqual(5);
    expect(sourceEvms.map((e) => e.chainId)).toContain(10143); // Monad
    expect((bridge!.solana as Record<string, unknown>).cctpDomain).toBe(5);
  });

  it("merges the gas token from tokens.json (kind=gas)", async () => {
    const chains = await client().listChains();
    const hadrian = chains.find((c) => String(c.chainId) === "200010")!;
    const gas = (hadrian as unknown as { gasToken?: { mintId: string; gasPool: string } }).gasToken;
    expect(gas, "gasToken missing — tokens.json not merged").toBeDefined();
    expect(gas!.mintId).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    expect(typeof gas!.gasPool).toBe("string");
  });

  it("skips chains with unknown status values instead of throwing", async () => {
    const chains = await client().listChains();
    expect(chains.find((c) => String(c.chainId) === "999999")).toBeUndefined();
  });

  it("builds a Sepolia CCTP inbound quote from the published Hadrian config (the resurrection gate)", async () => {
    const chains = await client().listChains();
    const hadrian = chains.find((c) => String(c.chainId) === "200010")!;
    const quote = buildUsdcCctpInboundQuote({
      amount: "1000000",
      sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: hadrian as never,
      programId: hadrian.romeEvmProgramId as string,
      intent: "gas",
    });
    expect(quote.steps.length).toBeGreaterThanOrEqual(2);
    const burn = quote.steps[0]!.unsignedTxs!.at(-1)!;
    // approve target == burn target invariant rides on the same catalog entry
    expect(quote.steps[0]!.unsignedTxs![0]!.data.slice(34, 74)).toBe(burn.to.slice(2).toLowerCase().padStart(40, "0"));
  });
});
