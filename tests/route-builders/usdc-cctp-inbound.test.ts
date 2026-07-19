import { describe, it, expect } from "vitest";
import { buildUsdcCctpInboundQuote } from "../../src/route-builders/usdc-cctp-inbound";
import { loadFixtureChain } from "../helpers/chains";

// Published-shape Hadrian, generated from the registry (never hand-written).
const HADRIAN_CONFIG = await loadFixtureChain("200010");
const ROME_PROGRAM_ID = HADRIAN_CONFIG.romeEvmProgramId!;
const SAMPLE_EVM = "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562";

describe("buildUsdcCctpInboundQuote — gas mode (intent: 'gas')", () => {
  const baseInput = {
    amount: "100000000",
    sender: { ethereum: SAMPLE_EVM },
    recipient: SAMPLE_EVM,
    chain: HADRIAN_CONFIG,
    programId: ROME_PROGRAM_ID,
    intent: "gas" as const,
  };

  it("produces 4 V2 steps: burn → ensure-ata → receive → sponsor-paid settle", () => {
    const quote = buildUsdcCctpInboundQuote(baseInput);

    expect(quote.route).toBe("usdc-cctp-to-rome");
    expect(quote.steps).toHaveLength(4);

    const [s1, s2, s3, s4] = quote.steps;
    expect(s1?.chain).toBe("ethereum");
    expect(s1?.kind).toBe("cctp-approve-and-deposit");
    expect(s1?.userSigns).toBe(true);
    expect(s1?.sponsorPaysFees).toBe(false);

    expect(s2?.chain).toBe("solana");
    expect(s2?.kind).toBe("ensure-ata");
    expect(s2?.userSigns).toBe(false);
    expect(s2?.sponsorPaysFees).toBe(true);

    expect(s3?.chain).toBe("solana");
    expect(s3?.kind).toBe("cctp-receive-message");
    expect(s3?.userSigns).toBe(false);
    expect(s3?.sponsorPaysFees).toBe(true);
    expect(s3?.blockedBy).toContain("step-2");
    expect(s3?.blockedBy).toContain("circle-attestation");

    expect(s4?.chain).toBe("rome-200010");
    expect(s4?.kind).toBe("settle-inbound-bridge-sponsored");
    expect(s4?.userSigns).toBe(false);
    expect(s4?.sponsorPaysFees).toBe(true);
    expect(s4?.blockedBy).toContain("step-3");
  });

  it("emits outputs: [{ kind: 'gas', chainId, amount }]", () => {
    const quote = buildUsdcCctpInboundQuote(baseInput);

    expect(quote.outputs).toHaveLength(1);
    const [out] = quote.outputs;
    expect(out?.kind).toBe("gas");
    expect(out?.chainId).toBe("200010");
    expect(out?.amount).toBe("100000000");
  });
});

describe("buildUsdcCctpInboundQuote — wrapper mode (intent: 'wrapper')", () => {
  const baseInput = {
    amount: "100000000",
    sender: { ethereum: SAMPLE_EVM },
    recipient: SAMPLE_EVM,
    chain: HADRIAN_CONFIG,
    programId: ROME_PROGRAM_ID,
    intent: "wrapper" as const,
  };

  it("produces 3 steps (no settle step) since user opted into wrapper", () => {
    const quote = buildUsdcCctpInboundQuote(baseInput);

    expect(quote.steps).toHaveLength(3);

    const [s1, s2, s3] = quote.steps;
    expect(s1?.kind).toBe("cctp-approve-and-deposit");
    expect(s1?.userSigns).toBe(true);

    expect(s2?.kind).toBe("ensure-ata");

    expect(s3?.chain).toBe("solana");
    expect(s3?.kind).toBe("cctp-receive-message");
    expect(s3?.userSigns).toBe(false);
    expect(s3?.sponsorPaysFees).toBe(true);
  });

  it("emits outputs: [{ kind: 'wrapper', solanaMint, destinationAta, amount }]", () => {
    const quote = buildUsdcCctpInboundQuote(baseInput);

    expect(quote.outputs).toHaveLength(1);
    const [out] = quote.outputs;
    expect(out?.kind).toBe("wrapper");
    expect(out?.amount).toBe("100000000");
    expect(out?.solanaMint).toBe(HADRIAN_CONFIG.gasToken!.mintId);
    expect(out?.destinationAta).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/); // base58 ATA
  });

  it("carries chainId on the wrapper output — resolveStamp's ONLY Rome-chain anchor on wrapper quotes", () => {
    // Wrapper quotes have no rome-<id> step (no settle step), so registration
    // resolves the Rome chain exclusively from outputs[].chainId. Without it
    // the record registers UNSTAMPED → backfills CCTP V1 → the poller queries
    // the V1 IRIS path for a V2 burn → 404 forever → never delivers.
    const quote = buildUsdcCctpInboundQuote(baseInput);
    expect(quote.outputs?.[0]?.chainId).toBe(HADRIAN_CONFIG.chainId);
  });
});

describe("buildUsdcCctpInboundQuote — input validation (intent-agnostic)", () => {
  const validBase = {
    amount: "100000000",
    sender: { ethereum: SAMPLE_EVM },
    recipient: SAMPLE_EVM,
    chain: HADRIAN_CONFIG,
    programId: ROME_PROGRAM_ID,
    intent: "gas" as const,
  };

  it("rejects amount below minimum ON MAINNET (devnet floor is 1 base unit — see amount-floor.test.ts)", () => {
    expect(() =>
      buildUsdcCctpInboundQuote({ ...validBase, amount: "500000", chain: { ...validBase.chain, network: "mainnet" } }),
    ).toThrow(/amount/);
  });

  it("rejects missing sender.ethereum", () => {
    expect(() => buildUsdcCctpInboundQuote({ ...validBase, sender: {} })).toThrow(/sender.ethereum/);
  });
});
