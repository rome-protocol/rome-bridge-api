import { describe, it, expect, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BridgeSponsor } from "../../src/sponsor/bridge-sponsor.js";

const SPONSOR_BASE_URL = "http://bridge.example";

const HADRIAN_PROGRAM = new PublicKey("RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf");
const USDC_DEVNET     = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const USDT_DEVNET     = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

function makeFetchMock(handlers: Record<string, any>) {
  const callLog: string[] = [];
  const fn = vi.fn(async (url: string, init?: any) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    callLog.push(key);
    const handler = handlers[key];
    if (!handler) throw new Error(`unstubbed fetch: ${key}`);
    return { ok: true, status: 200, json: async () => handler };
  });
  (fn as any).callLog = callLog;
  return fn;
}

const RECV_PROGRAMS = {
  messageTransmitterProgram: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
  tokenMessengerMinterProgram: "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
  splTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  usdcMint: USDC_DEVNET.toBase58(),
};

describe("BridgeSponsor.tickOnce", () => {
  it("returns acted:false when transfer outcome is not pending", async () => {
    const fetchMock = makeFetchMock({
      "GET http://bridge.example/v1/transfers/txf_done": {
        id: "txf_done", outcome: "complete",
        steps: [{ n: 1, kind: "cctp-approve-and-deposit", status: "confirmed" }],
      },
    });
    const worker = new BridgeSponsor({
      bridgeApiUrl: SPONSOR_BASE_URL,
      sponsorKeypair: Keypair.generate(),
      solanaConnection: {} as any,
      fetch: fetchMock as any,
    });
    const r = await worker.tickOnce("txf_done");
    expect(r.acted).toBe(false);
    expect(r.reason).toMatch(/outcome/);
  });

  it("returns acted:false when no step is ready for the sponsor", async () => {
    const fetchMock = makeFetchMock({
      "GET http://bridge.example/v1/transfers/txf_a": {
        id: "txf_a", outcome: "pending",
        steps: [
          { n: 1, kind: "cctp-approve-and-deposit",         status: "submitted" },
          { n: 2, kind: "cctp-receive-message",             status: "blocked" },
        ],
      },
    });
    const worker = new BridgeSponsor({
      bridgeApiUrl: SPONSOR_BASE_URL,
      sponsorKeypair: Keypair.generate(),
      solanaConnection: {} as any,
      fetch: fetchMock as any,
      buildAndSendReceiveMessage: vi.fn(),
      buildAndSendSettle: vi.fn(),
    });
    const r = await worker.tickOnce("txf_a");
    expect(r.acted).toBe(false);
  });

  it("builds + sends + POSTs the receiveMessage tx when step 2 is ready", async () => {
    const stepMeta = {
      n: 2, kind: "cctp-receive-message", status: "ready",
      message:     "0xdeadbeef" as const,
      attestation: "0xabbaabba" as const,
      programs: RECV_PROGRAMS,
      recipientAta: "FZqPoNd9Mwtp5i7FfYMhjYAVDUCZs2yvohZhPsim6BjA",
      recipientPdaOwner: "87d9V8YGkfihZUFJuAGGrGJ2LgG9rU2Fg9HyqHH6N8QZ",
    };
    const fetchMock = makeFetchMock({
      "GET http://bridge.example/v1/transfers/txf_b": {
        id: "txf_b", outcome: "pending",
        steps: [
          { n: 1, kind: "cctp-approve-and-deposit", status: "confirmed" },
          stepMeta,
        ],
      },
      "POST http://bridge.example/v1/transfers/txf_b/steps/2": { ok: true },
    });
    const sendRecv = vi.fn().mockResolvedValue("5qRECEIVE_SIG");
    const worker = new BridgeSponsor({
      bridgeApiUrl: SPONSOR_BASE_URL,
      sponsorKeypair: Keypair.generate(),
      solanaConnection: {} as any,
      fetch: fetchMock as any,
      buildAndSendReceiveMessage: sendRecv,
    });
    const r = await worker.tickOnce("txf_b");
    expect(r.acted).toBe(true);
    expect(sendRecv).toHaveBeenCalledTimes(1);
    expect(sendRecv).toHaveBeenCalledWith(expect.objectContaining({
      message:     "0xdeadbeef",
      attestation: "0xabbaabba",
      programs:    RECV_PROGRAMS,
      recipientAta: stepMeta.recipientAta,
      recipientPdaOwner: stepMeta.recipientPdaOwner,
    }));
    expect((fetchMock as any).callLog).toContain("POST http://bridge.example/v1/transfers/txf_b/steps/2");
  });

  it("refuses CCTP receive step missing recipientAta / recipientPdaOwner (would fail with InvalidAccountData)", async () => {
    const fetchMock = makeFetchMock({
      "GET http://bridge.example/v1/transfers/txf_old_cctp": {
        id: "txf_old_cctp", outcome: "pending",
        steps: [
          { n: 1, kind: "cctp-approve-and-deposit", status: "confirmed" },
          { n: 2, kind: "cctp-receive-message", status: "ready",
            message: "0xdead" as const, attestation: "0xabba" as const, programs: RECV_PROGRAMS,
            // pre-fix-PR shape — no recipientAta/recipientPdaOwner
          },
        ],
      },
    });
    const sendRecv = vi.fn();
    const worker = new BridgeSponsor({
      bridgeApiUrl: SPONSOR_BASE_URL,
      sponsorKeypair: Keypair.generate(),
      solanaConnection: {} as any,
      fetch: fetchMock as any,
      buildAndSendReceiveMessage: sendRecv,
    });
    const r = await worker.tickOnce("txf_old_cctp");
    expect(r.acted).toBe(false);
    expect(r.reason).toMatch(/recipientAta|recipientPdaOwner/);
    expect(sendRecv).not.toHaveBeenCalled();
  });

  it("builds + sends + POSTs the settle tx when step 3 is ready and OwnerInfo mint matches", async () => {
    const settleStep = {
      n: 3, kind: "settle-inbound-bridge-sponsored", status: "ready",
      chainId:        "200010",
      user:           "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      bridgedAmount:  "1000000",
      sourceChain:    "11155111",
      sourceTxHash:   "0x" + "cd".repeat(32),
      rollupProgramId: HADRIAN_PROGRAM.toBase58(),
      mintAddress:    USDC_DEVNET.toBase58(),
    };
    const fetchMock = makeFetchMock({
      "GET http://bridge.example/v1/transfers/txf_c": {
        id: "txf_c", outcome: "pending",
        steps: [
          { n: 1, kind: "cctp-approve-and-deposit", status: "confirmed" },
          { n: 2, kind: "cctp-receive-message",     status: "confirmed" },
          settleStep,
        ],
      },
      "POST http://bridge.example/v1/transfers/txf_c/steps/3": { ok: true },
    });
    const sendSettle = vi.fn().mockResolvedValue("5qSETTLE_SIG");
    const getMintForChain = vi.fn().mockResolvedValue(USDC_DEVNET);

    const worker = new BridgeSponsor({
      bridgeApiUrl: SPONSOR_BASE_URL,
      sponsorKeypair: Keypair.generate(),
      solanaConnection: {} as any,
      fetch: fetchMock as any,
      buildAndSendSettle: sendSettle,
      getMintForChain,
    });

    const r = await worker.tickOnce("txf_c");
    expect(r.acted).toBe(true);
    expect(getMintForChain).toHaveBeenCalledWith(200010n, expect.any(PublicKey));
    expect(sendSettle).toHaveBeenCalledWith(expect.objectContaining({
      chainId: "200010",
      user: settleStep.user,
      bridgedAmount: "1000000",
      sourceChain: "11155111",
      sourceTxHash: settleStep.sourceTxHash,
      rollupProgramId: HADRIAN_PROGRAM.toBase58(),
      mintAddress: USDC_DEVNET.toBase58(),
    }));
    expect((fetchMock as any).callLog).toContain("POST http://bridge.example/v1/transfers/txf_c/steps/3");
  });

  it("refuses to settle when OwnerInfo on-chain mint != step mintAddress (mint-mismatch gate)", async () => {
    const settleStep = {
      n: 3, kind: "settle-inbound-bridge-sponsored", status: "ready",
      chainId:        "200010",
      user:           "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      bridgedAmount:  "1000000",
      sourceChain:    "11155111",
      sourceTxHash:   "0x" + "cd".repeat(32),
      rollupProgramId: HADRIAN_PROGRAM.toBase58(),
      mintAddress:    USDT_DEVNET.toBase58(),  // step claims USDT
    };
    const fetchMock = makeFetchMock({
      "GET http://bridge.example/v1/transfers/txf_d": {
        id: "txf_d", outcome: "pending",
        steps: [
          { n: 1, kind: "cctp-approve-and-deposit", status: "confirmed" },
          { n: 2, kind: "cctp-receive-message",     status: "confirmed" },
          settleStep,
        ],
      },
      "POST http://bridge.example/v1/transfers/txf_d/steps/3": { ok: true },
    });
    const sendSettle = vi.fn();
    const getMintForChain = vi.fn().mockResolvedValue(USDC_DEVNET);  // on-chain says USDC

    const worker = new BridgeSponsor({
      bridgeApiUrl: SPONSOR_BASE_URL,
      sponsorKeypair: Keypair.generate(),
      solanaConnection: {} as any,
      fetch: fetchMock as any,
      buildAndSendSettle: sendSettle,
      getMintForChain,
    });

    const r = await worker.tickOnce("txf_d");
    // Terminal mint-mismatch: the settle is REFUSED (never built/sent) but the
    // skip is REPORTED so the record completes as degraded instead of stalling.
    expect(r.acted).toBe(true);
    expect(r.reason).toMatch(/mint/i);
    expect(sendSettle).not.toHaveBeenCalled();
    const posts = (fetchMock as any).callLog.filter((c: string) => c.startsWith("POST"));
    expect(posts).toEqual(["POST http://bridge.example/v1/transfers/txf_d/steps/3"]);
  });

  it("wrapper-mode transfers complete after step 2; no step 3 means no further sponsor action", async () => {
    const fetchMock = makeFetchMock({
      "GET http://bridge.example/v1/transfers/txf_wrapper": {
        id: "txf_wrapper", outcome: "pending",
        steps: [
          { n: 1, kind: "cctp-approve-and-deposit", status: "confirmed" },
          { n: 2, kind: "cctp-receive-message",     status: "confirmed" },
          // no step 3 — wrapper mode (recipient.romeChainId absent)
        ],
      },
    });
    const sendRecv   = vi.fn();
    const sendSettle = vi.fn();
    const worker = new BridgeSponsor({
      bridgeApiUrl: SPONSOR_BASE_URL,
      sponsorKeypair: Keypair.generate(),
      solanaConnection: {} as any,
      fetch: fetchMock as any,
      buildAndSendReceiveMessage: sendRecv,
      buildAndSendSettle: sendSettle,
    });
    const r = await worker.tickOnce("txf_wrapper");
    expect(r.acted).toBe(false);
    expect(sendRecv).not.toHaveBeenCalled();
    expect(sendSettle).not.toHaveBeenCalled();
  });

  it("returns acted:false with a clear reason when buildAndSendReceiveMessage hook is unwired", async () => {
    const fetchMock = makeFetchMock({
      "GET http://bridge.example/v1/transfers/txf_e": {
        id: "txf_e", outcome: "pending",
        steps: [
          { n: 1, kind: "cctp-approve-and-deposit", status: "confirmed" },
          { n: 2, kind: "cctp-receive-message",     status: "ready",
            message: "0xdead", attestation: "0xabba", programs: RECV_PROGRAMS },
        ],
      },
    });
    const worker = new BridgeSponsor({
      bridgeApiUrl: SPONSOR_BASE_URL,
      sponsorKeypair: Keypair.generate(),
      solanaConnection: {} as any,
      fetch: fetchMock as any,
      // No buildAndSendReceiveMessage hook
    });
    const r = await worker.tickOnce("txf_e");
    expect(r.acted).toBe(false);
    expect(r.reason).toMatch(/not wired/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Wormhole inbound coverage
// ─────────────────────────────────────────────────────────────────────

const WH_PROGRAMS = {
  coreBridgeProgram: "3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5",     // Wormhole core devnet
  tokenBridgeProgram: "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",   // Wormhole token bridge devnet
  splTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  wrappedMint: "6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs",          // wormhole-wrapped wETH on devnet (well-known)
};
const WETH_WORMHOLE = new PublicKey(WH_PROGRAMS.wrappedMint);

describe("BridgeSponsor.tickOnce — Wormhole inbound", () => {
  it("when step.kind=wormhole-complete-transfer-wrapped is ready, calls buildAndSendCompleteTransfer + POSTs", async () => {
    const stepMeta = {
      n: 2, kind: "wormhole-complete-transfer-wrapped", status: "ready",
      vaa: ("0x" + "ab".repeat(200)) as `0x${string}`,
      programs: WH_PROGRAMS,
      recipientAta: "HTt1t24QmDwGX3Z55cZfFvEb59JqksL2QQcFvmqNGXZf",
      recipientPdaOwner: "937xewFZSHPRQTXKQhLKAGQRFdoQQo4YqiGEq28R45Xt",
    };
    const fetchMock = makeFetchMock({
      "GET http://bridge.example/v1/transfers/txf_wh": {
        id: "txf_wh", outcome: "pending",
        steps: [
          { n: 1, kind: "wormhole-wrap-and-transfer-eth", status: "confirmed" },
          stepMeta,
        ],
      },
      "POST http://bridge.example/v1/transfers/txf_wh/steps/2": { ok: true },
    });
    const sendWh = vi.fn().mockResolvedValue("5qWH_SIG");
    const worker = new BridgeSponsor({
      bridgeApiUrl: SPONSOR_BASE_URL,
      sponsorKeypair: Keypair.generate(),
      solanaConnection: {} as any,
      fetch: fetchMock as any,
      buildAndSendCompleteTransfer: sendWh,
    });
    const r = await worker.tickOnce("txf_wh");
    expect(r.acted).toBe(true);
    expect(sendWh).toHaveBeenCalledWith(expect.objectContaining({
      vaa: stepMeta.vaa,
      programs: WH_PROGRAMS,
      recipientAta: stepMeta.recipientAta,
      recipientPdaOwner: stepMeta.recipientPdaOwner,
    }));
    expect((fetchMock as any).callLog).toContain("POST http://bridge.example/v1/transfers/txf_wh/steps/2");
  });

  it("refuses Wormhole complete step missing recipientAta / recipientPdaOwner (would fail with InvalidAccountData otherwise)", async () => {
    const fetchMock = makeFetchMock({
      "GET http://bridge.example/v1/transfers/txf_wh_old": {
        id: "txf_wh_old", outcome: "pending",
        steps: [
          { n: 1, kind: "wormhole-wrap-and-transfer-eth", status: "confirmed" },
          { n: 2, kind: "wormhole-complete-transfer-wrapped", status: "ready",
            vaa: ("0x" + "ab".repeat(200)) as `0x${string}`,
            programs: WH_PROGRAMS,
            // pre-fix-PR shape — no recipientAta / recipientPdaOwner
          },
        ],
      },
    });
    const sendWh = vi.fn();
    const worker = new BridgeSponsor({
      bridgeApiUrl: SPONSOR_BASE_URL,
      sponsorKeypair: Keypair.generate(),
      solanaConnection: {} as any,
      fetch: fetchMock as any,
      buildAndSendCompleteTransfer: sendWh,
    });
    const r = await worker.tickOnce("txf_wh_old");
    expect(r.acted).toBe(false);
    expect(r.reason).toMatch(/recipientAta|recipientPdaOwner/);
    expect(sendWh).not.toHaveBeenCalled();
  });

  it("returns acted:false with a clear reason when buildAndSendCompleteTransfer is unwired", async () => {
    const fetchMock = makeFetchMock({
      "GET http://bridge.example/v1/transfers/txf_wh_nohook": {
        id: "txf_wh_nohook", outcome: "pending",
        steps: [
          { n: 1, kind: "wormhole-wrap-and-transfer-eth", status: "confirmed" },
          { n: 2, kind: "wormhole-complete-transfer-wrapped", status: "ready",
            vaa: "0xdead", programs: WH_PROGRAMS },
        ],
      },
    });
    const worker = new BridgeSponsor({
      bridgeApiUrl: SPONSOR_BASE_URL,
      sponsorKeypair: Keypair.generate(),
      solanaConnection: {} as any,
      fetch: fetchMock as any,
      // No buildAndSendCompleteTransfer
    });
    const r = await worker.tickOnce("txf_wh_nohook");
    expect(r.acted).toBe(false);
    expect(r.reason).toMatch(/buildAndSendCompleteTransfer not wired/i);
  });

  it("returns acted:false when Wormhole step is missing required metadata (vaa/programs)", async () => {
    const fetchMock = makeFetchMock({
      "GET http://bridge.example/v1/transfers/txf_wh_bad": {
        id: "txf_wh_bad", outcome: "pending",
        steps: [
          { n: 1, kind: "wormhole-wrap-and-transfer-eth", status: "confirmed" },
          { n: 2, kind: "wormhole-complete-transfer-wrapped", status: "ready" /* no vaa, no programs */ },
        ],
      },
    });
    const worker = new BridgeSponsor({
      bridgeApiUrl: SPONSOR_BASE_URL,
      sponsorKeypair: Keypair.generate(),
      solanaConnection: {} as any,
      fetch: fetchMock as any,
      buildAndSendCompleteTransfer: vi.fn(),
    });
    const r = await worker.tickOnce("txf_wh_bad");
    expect(r.acted).toBe(false);
    expect(r.reason).toMatch(/missing.*vaa|missing.*programs|metadata/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Mint-matrix coverage for the OwnerInfo gate
//
// These tests parameterize the (bridged mint, chain gas mint) pair against
// the BridgeSponsor's settle path, asserting the gate fires correctly
// regardless of which inbound protocol (CCTP, Wormhole) produced the
// bridged SPL.
// ─────────────────────────────────────────────────────────────────────

interface MintScenario {
  label: string;
  bridgedMint: PublicKey;
  onChainGasMint: PublicKey | null;
  expectSettle: boolean;
  reasonMatch?: RegExp;
}

const SCENARIOS: MintScenario[] = [
  {
    label: "positive: bridged USDC -> chain gas = USDC",
    bridgedMint: USDC_DEVNET,
    onChainGasMint: USDC_DEVNET,
    expectSettle: true,
  },
  {
    label: "positive: bridged wETH -> chain gas = wETH",
    bridgedMint: WETH_WORMHOLE,
    onChainGasMint: WETH_WORMHOLE,
    expectSettle: true,
  },
  {
    label: "negative: bridged wETH -> chain gas = USDC (today's Hadrian shape)",
    bridgedMint: WETH_WORMHOLE,
    onChainGasMint: USDC_DEVNET,
    expectSettle: false,
    reasonMatch: /mint.*mismatch|OwnerInfo mint/i,
  },
  {
    label: "negative: bridged USDC -> chain gas = USDT",
    bridgedMint: USDC_DEVNET,
    onChainGasMint: USDT_DEVNET,
    expectSettle: false,
    reasonMatch: /mint.*mismatch|OwnerInfo mint/i,
  },
  {
    label: "negative: chain has NO gas mint in OwnerInfo (chain registered but mint not bound)",
    bridgedMint: USDC_DEVNET,
    onChainGasMint: null,
    expectSettle: false,
    reasonMatch: /OwnerInfo did not return a mint|did not return/i,
  },
];

describe.each(SCENARIOS)("OwnerInfo mint-matrix gate: $label", (sc) => {
  it("settles iff bridged mint matches the on-chain gas mint for the chain", async () => {
    const settleStep = {
      n: 3, kind: "settle-inbound-bridge-sponsored", status: "ready",
      chainId:        "200010",
      user:           "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      bridgedAmount:  "1000000",
      sourceChain:    "11155111",
      sourceTxHash:   "0x" + "cd".repeat(32),
      rollupProgramId: HADRIAN_PROGRAM.toBase58(),
      mintAddress:    sc.bridgedMint.toBase58(),
    };
    const fetchMock = makeFetchMock({
      "GET http://bridge.example/v1/transfers/txf_matrix": {
        id: "txf_matrix", outcome: "pending",
        steps: [
          { n: 1, kind: "cctp-approve-and-deposit", status: "confirmed" },
          { n: 2, kind: "cctp-receive-message",     status: "confirmed" },
          settleStep,
        ],
      },
      "POST http://bridge.example/v1/transfers/txf_matrix/steps/3": { ok: true },
    });
    const sendSettle = vi.fn().mockResolvedValue("5qSETTLE_SIG");
    const getMintForChain = vi.fn().mockResolvedValue(sc.onChainGasMint);

    const worker = new BridgeSponsor({
      bridgeApiUrl: SPONSOR_BASE_URL,
      sponsorKeypair: Keypair.generate(),
      solanaConnection: {} as any,
      fetch: fetchMock as any,
      buildAndSendSettle: sendSettle,
      getMintForChain,
    });
    const r = await worker.tickOnce("txf_matrix");

    if (sc.expectSettle) {
      expect(r.acted).toBe(true);
      expect(sendSettle).toHaveBeenCalledTimes(1);
      expect((fetchMock as any).callLog).toContain(
        "POST http://bridge.example/v1/transfers/txf_matrix/steps/3",
      );
    } else {
      // Terminal gate refusal: settle never built, skip reported (degradation
      // surfaces on the record instead of a forever-pending stall).
      expect(r.acted).toBe(true);
      if (sc.reasonMatch) expect(r.reason).toMatch(sc.reasonMatch);
      expect(sendSettle).not.toHaveBeenCalled();
      expect((fetchMock as any).callLog).toContain(
        "POST http://bridge.example/v1/transfers/txf_matrix/steps/3",
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Step-ordering coverage — Wormhole inbound that ALSO requests settle
// (gas-mode), to prove the gate gates settle whether the upstream step
// kind was CCTP or Wormhole.
// ─────────────────────────────────────────────────────────────────────

describe("BridgeSponsor.tickOnce — Wormhole inbound + settle gate composition", () => {
  it("Wormhole completed; settle step ready and matching mint -> settles", async () => {
    const fetchMock = makeFetchMock({
      "GET http://bridge.example/v1/transfers/txf_wh_gas": {
        id: "txf_wh_gas", outcome: "pending",
        steps: [
          { n: 1, kind: "wormhole-wrap-and-transfer-eth",      status: "confirmed" },
          { n: 2, kind: "wormhole-complete-transfer-wrapped",  status: "confirmed" },
          {
            n: 3, kind: "settle-inbound-bridge-sponsored", status: "ready",
            chainId: "200010", user: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
            bridgedAmount: "1000000000000000000", sourceChain: "11155111",
            sourceTxHash: "0x" + "ab".repeat(32),
            rollupProgramId: HADRIAN_PROGRAM.toBase58(),
            mintAddress: WETH_WORMHOLE.toBase58(),
          },
        ],
      },
      "POST http://bridge.example/v1/transfers/txf_wh_gas/steps/3": { ok: true },
    });
    const sendSettle = vi.fn().mockResolvedValue("5qWHSETTLE");
    const getMintForChain = vi.fn().mockResolvedValue(WETH_WORMHOLE);

    const worker = new BridgeSponsor({
      bridgeApiUrl: SPONSOR_BASE_URL,
      sponsorKeypair: Keypair.generate(),
      solanaConnection: {} as any,
      fetch: fetchMock as any,
      buildAndSendSettle: sendSettle,
      getMintForChain,
    });
    const r = await worker.tickOnce("txf_wh_gas");
    expect(r.acted).toBe(true);
    expect(sendSettle).toHaveBeenCalledTimes(1);
  });

  it("Wormhole completed; settle step ready but OwnerInfo says different mint -> NO settle", async () => {
    const fetchMock = makeFetchMock({
      "GET http://bridge.example/v1/transfers/txf_wh_mismatch": {
        id: "txf_wh_mismatch", outcome: "pending",
        steps: [
          { n: 1, kind: "wormhole-wrap-and-transfer-eth",      status: "confirmed" },
          { n: 2, kind: "wormhole-complete-transfer-wrapped",  status: "confirmed" },
          {
            n: 3, kind: "settle-inbound-bridge-sponsored", status: "ready",
            chainId: "200010", user: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
            bridgedAmount: "1000000000000000000", sourceChain: "11155111",
            sourceTxHash: "0x" + "ab".repeat(32),
            rollupProgramId: HADRIAN_PROGRAM.toBase58(),
            mintAddress: WETH_WORMHOLE.toBase58(),    // step claims wETH
          },
        ],
      },
      "POST http://bridge.example/v1/transfers/txf_wh_mismatch/steps/3": { ok: true },
    });
    const sendSettle = vi.fn();
    const getMintForChain = vi.fn().mockResolvedValue(USDC_DEVNET);  // chain actually USDC-gas

    const worker = new BridgeSponsor({
      bridgeApiUrl: SPONSOR_BASE_URL,
      sponsorKeypair: Keypair.generate(),
      solanaConnection: {} as any,
      fetch: fetchMock as any,
      buildAndSendSettle: sendSettle,
      getMintForChain,
    });
    const r = await worker.tickOnce("txf_wh_mismatch");
    expect(r.acted).toBe(true); // skip reported (terminal); settle itself refused
    expect(r.reason).toMatch(/mint/i);
    expect(sendSettle).not.toHaveBeenCalled();
  });
});
