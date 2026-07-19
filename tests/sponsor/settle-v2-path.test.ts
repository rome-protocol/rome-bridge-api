import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { BridgeSponsor } from "../../src/sponsor/bridge-sponsor";

const HADRIAN_PROGRAM = "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const USER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const SIG = "0x" + "49".repeat(32) + "7f".repeat(32) + "1b"; // r||s||v=27

function settleStep() {
  return {
    n: 3, kind: "settle-inbound-bridge-sponsored", status: "ready",
    chainId: "200010", user: USER, bridgedAmount: "1000000", sourceChain: "11155111",
    sourceTxHash: "0x" + "ab".repeat(32), rollupProgramId: HADRIAN_PROGRAM, mintAddress: USDC,
  };
}

function makeSponsor(hooks: Record<string, unknown>) {
  const posts: Array<{ url: string; body: unknown }> = [];
  const record = { id: "tv2", outcome: "pending", steps: [settleStep()] };
  const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") { posts.push({ url: String(url), body: JSON.parse(String(init.body)) }); return new Response("{}", { status: 200 }); }
    return new Response(JSON.stringify(record), { status: 200 });
  }) as unknown as typeof fetch;
  const feePayer = Keypair.generate();
  const sponsor = new BridgeSponsor({
    bridgeApiUrl: "https://api.example",
    sponsorKeypair: feePayer,
    solanaConnection: {} as never,
    fetch: fetchFn,
    getMintForChain: vi.fn().mockResolvedValue({ toBase58: () => USDC }),
    ...hooks,
  } as never);
  return { sponsor, posts, feePayer };
}

describe("BridgeSponsor.handleSettle — trustless v2 path", () => {
  it("when settle material is present, builds v2 with the user's sig + a FEE-PAYER (no bridge_settler_key)", async () => {
    const buildAndSendSettleV2 = vi.fn().mockResolvedValue("sigV2settle");
    const buildAndSendSettle = vi.fn(); // v1 hook — must NOT be called
    const getSettleMaterial = vi.fn().mockResolvedValue({
      userSettleSig: SIG, deadline: Math.floor(Date.now() / 1000) + 3600, sourceEvmChainId: "11155111",
    });
    const { sponsor, posts, feePayer } = makeSponsor({ buildAndSendSettleV2, buildAndSendSettle, getSettleMaterial });

    const r = await sponsor.tickOnce("tv2");
    expect(r.acted).toBe(true);
    expect(buildAndSendSettle).not.toHaveBeenCalled();
    expect(buildAndSendSettleV2).toHaveBeenCalledTimes(1);
    const arg = buildAndSendSettleV2.mock.calls[0]![0];
    // fee-payer is the sponsor keypair — a payer, NOT an authority
    expect(arg.signer).toBe(feePayer);
    expect(arg.sigV).toBe(27);
    expect(Buffer.from(arg.sigR).toString("hex")).toBe("49".repeat(32));
    expect(arg.user).toBe(USER);
    expect(arg.deadline).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(arg.sourceEvmChainId).toBe("11155111");
    // settle step reported + settle material purge requested
    expect(posts.some((p) => p.url.includes("/steps/3"))).toBe(true);
    expect(posts.some((p) => (p.body as { purgeSettleMaterial?: boolean }).purgeSettleMaterial)).toBe(true);
  });

  it("falls back to the v1 path when NO settle material (legacy bridges still work)", async () => {
    const buildAndSendSettleV2 = vi.fn();
    const buildAndSendSettle = vi.fn().mockResolvedValue("sigV1settle");
    const getSettleMaterial = vi.fn().mockResolvedValue(null);
    const { sponsor } = makeSponsor({ buildAndSendSettleV2, buildAndSendSettle, getSettleMaterial });
    const r = await sponsor.tickOnce("tv2");
    expect(r.acted).toBe(true);
    expect(buildAndSendSettleV2).not.toHaveBeenCalled();
    expect(buildAndSendSettle).toHaveBeenCalledTimes(1);
  });

  it("v2 still honors the OwnerInfo mint gate — mismatch reports a skip, never settles", async () => {
    const buildAndSendSettleV2 = vi.fn();
    const getSettleMaterial = vi.fn().mockResolvedValue({ userSettleSig: SIG, deadline: Math.floor(Date.now() / 1000) + 3600, sourceEvmChainId: "11155111" });
    const { sponsor, posts } = makeSponsor({
      buildAndSendSettleV2, getSettleMaterial,
      getMintForChain: vi.fn().mockResolvedValue({ toBase58: () => "So11111111111111111111111111111111111111112" }),
    });
    const r = await sponsor.tickOnce("tv2");
    expect(r.acted).toBe(true);
    expect(buildAndSendSettleV2).not.toHaveBeenCalled();
    expect(posts.some((p) => (p.body as { skip?: unknown }).skip)).toBe(true);
  });

  it("expired authorization is TERMINAL — posts a settle-expired skip + purge, never builds v2 (no retry-storm)", async () => {
    // An expired deadline is a permanent on-chain rejection (SignatureExpired);
    // retrying it every tick would stall the record pending forever. The worker
    // must detect expiry and terminate the record honestly.
    const buildAndSendSettleV2 = vi.fn();
    const getSettleMaterial = vi.fn().mockResolvedValue({
      userSettleSig: SIG, deadline: Math.floor(Date.now() / 1000) - 10, sourceEvmChainId: "11155111",
    });
    const { sponsor, posts } = makeSponsor({ buildAndSendSettleV2, getSettleMaterial });
    const r = await sponsor.tickOnce("tv2");
    expect(r.acted).toBe(true);
    expect(buildAndSendSettleV2).not.toHaveBeenCalled();
    expect(posts.some((p) => p.url.includes("/steps/3") && (p.body as { skip?: { degradation?: string } }).skip?.degradation === "settle-expired")).toBe(true);
    expect(posts.some((p) => (p.body as { purgeSettleMaterial?: boolean }).purgeSettleMaterial)).toBe(true);
  });
});
