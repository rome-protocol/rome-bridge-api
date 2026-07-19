import { describe, it, expect, vi } from "vitest";
import { BridgeSponsor } from "../../src/sponsor/bridge-sponsor";
import { buildUsdcCctpInboundQuote } from "../../src/route-builders/usdc-cctp-inbound";
import { loadFixtureChain } from "../helpers/chains";

const HADRIAN = await loadFixtureChain("200010");
const SAMPLE_EVM = "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562";

function makeSponsor(record: unknown, hooks: Record<string, unknown>) {
  const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("/steps/")) return new Response("{}", { status: 200 });
    return new Response(JSON.stringify(record), { status: 200 });
  }) as unknown as typeof fetch;
  const sponsor = new BridgeSponsor({
    bridgeApiUrl: "https://api.example",
    sponsorKeypair: { publicKey: { toBase58: () => "SponsorPubkey11111111111111111111111111111" } } as never,
    fetch: fetchFn,
    ...hooks,
  } as never);
  return { sponsor, fetchFn };
}

describe("settle step metadata — stamped at quote time (the Rome app parity: source_chain = source EVM chain id)", () => {
  const base = {
    amount: "1000000",
    sender: { ethereum: SAMPLE_EVM },
    recipient: SAMPLE_EVM,
    chain: HADRIAN,
    programId: HADRIAN.romeEvmProgramId!,
    intent: "gas" as const,
  };

  it("gas-mode step 3 carries everything the sponsor's settle needs (default source)", () => {
    const q = buildUsdcCctpInboundQuote(base);
    const s3 = q.steps.find((s) => s.kind === "settle-inbound-bridge-sponsored")!;
    expect(s3.chainId).toBe("200010");
    expect(s3.user).toBe(SAMPLE_EVM);
    expect(s3.bridgedAmount).toBe("1000000");
    expect(s3.sourceChain).toBe("11155111"); // EVM chain id, NOT the CCTP domain (the Rome app replay-key parity)
    expect(s3.rollupProgramId).toBe(HADRIAN.romeEvmProgramId);
    expect(s3.mintAddress).toBe(HADRIAN.gasToken!.mintId);
    expect(s3.sourceTxHash).toBeUndefined(); // only known at registration
  });

  it("Monad source stamps sourceChain 10143", () => {
    const q = buildUsdcCctpInboundQuote({ ...base, sourceChainId: 10143 });
    expect(q.steps.find((s) => s.kind === "settle-inbound-bridge-sponsored")!.sourceChain).toBe("10143");
  });

  it("fast quotes settle the conservative post-fee amount", () => {
    const q = buildUsdcCctpInboundQuote({ ...base, speed: "fast", fast: { available: true, bps: 1 } });
    expect(q.steps.find((s) => s.kind === "settle-inbound-bridge-sponsored")!.bridgedAmount).toBe("999900");
  });
});

describe("sponsor dispatch — ensure-ata step (V2 receive is its own tx; ATA create precedes it)", () => {
  const ensureAtaStep = {
    n: 2, kind: "ensure-ata", status: "ready",
    recipientAta: "AfRKkAdG72zaaSvoHmTna1dg9G2eb8UjMWevW3q5LFvD",
    recipientPdaOwner: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA",
    programs: { splTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
  };

  it("calls the buildAndSendEnsureAta hook and posts the signature", async () => {
    const buildAndSendEnsureAta = vi.fn().mockResolvedValue("sigEnsureAta");
    const record = { id: "t1", outcome: "pending", steps: [ensureAtaStep] };
    const { sponsor, fetchFn } = makeSponsor(record, { buildAndSendEnsureAta });
    const r = await sponsor.tickOnce("t1");
    expect(r.acted).toBe(true);
    expect(buildAndSendEnsureAta).toHaveBeenCalledWith(expect.objectContaining({
      recipientAta: ensureAtaStep.recipientAta,
      recipientPdaOwner: ensureAtaStep.recipientPdaOwner,
    }));
    const posted = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).find((u) => u.includes("/steps/2"));
    expect(posted).toBeDefined();
  });

  it("refuses an ensure-ata step missing its ATA metadata", async () => {
    const record = { id: "t1", outcome: "pending", steps: [{ n: 2, kind: "ensure-ata", status: "ready" }] };
    const { sponsor } = makeSponsor(record, { buildAndSendEnsureAta: vi.fn() });
    const r = await sponsor.tickOnce("t1");
    expect(r.acted).toBe(false);
    expect(r.reason).toMatch(/recipientAta/);
  });
});
