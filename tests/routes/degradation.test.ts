import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server";
import { writePublishedChain } from "../helpers/chains";
import { BridgeSponsor } from "../../src/sponsor/bridge-sponsor";
import { PublicKey } from "@solana/web3.js";

let app: Awaited<ReturnType<typeof buildApp>>;
const readTx = vi.fn();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  writePublishedChain(dir, "121301-degtest", {
    chain: { chainId: 121301, name: "Marcus", network: "devnet", status: "live", rpcUrl: "https://marcus.invalid", romeEvmProgramId: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8", solana: { cluster: "devnet" } },
    bridge: {
      cctpIrisApiBase: "https://iris-api-sandbox.circle.com",
      sourceEvm: { chainId: 11155111, name: "Sepolia", cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", cctpMessageTransmitter: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD" },
      solana: { cctpDomain: 5 },
      assets: [{ id: "usdc", symbol: "USDC", solanaMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", sourceEvm: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", protocol: "cctp" } }],
    },
    tokens: [{ kind: "gas", mintId: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", gasPool: "AkZ6NSKzoM6Q3TqVwgtCixpjBDRqEhs5YTZxYzX6s2Jt", symbol: "USDC" }],
  });
  process.env.BRIDGE_API_USE_IN_MEMORY_REDIS = "1";
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
  (app as never as { decorate: (k: string, v: unknown) => void }).decorate("ethereumReader", { readTx });
});
afterAll(async () => { await app.close(); });

async function registeredTransfer(): Promise<{ id: string; settleN: number }> {
  const qres = await app.inject({ method: "POST", url: "/v1/quote", payload: {
    asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301",
    amount: "1000000", sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
  }});
  const quote = qres.json();
  const expectedTx = quote.steps[0].unsignedTxs.at(-1);
  readTx.mockResolvedValue({ to: expectedTx.to, data: expectedTx.data, value: expectedTx.value });
  const tres = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: "0x" + Math.random().toString(16).slice(2).padEnd(64, "a") } });
  const record = tres.json();
  const settleN = record.steps.find((s: { kind: string }) => s.kind === "settle-inbound-bridge-sponsored").n;
  // advance: receive confirmed → settle ready
  const receiveN = record.steps.find((s: { kind: string }) => s.kind === "cctp-receive-message").n;
  await app.redis.set(`bridge:v1:transfer:${record.id}`, JSON.stringify({
    ...record,
    steps: record.steps.map((s: { n: number }) => (s.n === receiveN ? { ...s, status: "ready" } : s)),
  }));
  await app.inject({ method: "POST", url: `/v1/transfers/${record.id}/steps/${receiveN}`, payload: { txHash: "5qSolanaSigReceive" } });
  return { id: record.id, settleN };
}

describe("sponsor attribution on quotes", () => {
  it("every step carries sponsor: user|rome consistent with userSigns", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/quote", payload: {
      asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301",
      amount: "1000000", sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    }});
    const q = res.json();
    expect(q.steps[0].sponsor).toBe("user");
    for (const s of q.steps.slice(1)) expect(s.sponsor).toBe("rome");
  });
});

describe("degradation surfacing (outcome enum unchanged) — the bridge spec the specc", () => {
  it("a skipped settle completes the record as complete + degradation: settle-skipped", async () => {
    const { id, settleN } = await registeredTransfer();
    const res = await app.inject({
      method: "POST", url: `/v1/transfers/${id}/steps/${settleN}`,
      payload: { skip: { degradation: "settle-skipped", reason: "OwnerInfo mint mismatch — bridged asset is not this chain's gas mint" } },
    });
    expect(res.statusCode).toBe(200);
    const record = res.json();
    expect(record.outcome).toBe("complete");           // enum UNCHANGED — no complete-degraded value
    expect(record.degradation).toBe("settle-skipped");
    expect(record.degradationReason).toMatch(/mint mismatch/);
    const settle = record.steps.find((s: { n: number }) => s.n === settleN);
    expect(settle.status).toBe("confirmed");
    expect(settle.skipped).toBe(true);
  });

  it("skip is refused on non-settle steps", async () => {
    const { id } = await registeredTransfer();
    const res = await app.inject({
      method: "POST", url: `/v1/transfers/${id}/steps/1`,
      payload: { skip: { degradation: "settle-skipped" } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("sponsor reports terminal wrapper-only settles as skips", () => {
  it("wrapper-only → POSTs skip (acted); settle-skipped hook failure → retries silently (not acted)", async () => {
    const record = {
      id: "t9", outcome: "pending",
      steps: [{
        n: 3, kind: "settle-inbound-bridge-sponsored", status: "ready",
        chainId: "121301", user: "0xabc", bridgedAmount: "1", sourceChain: "11155111",
        sourceTxHash: "0x" + "ab".repeat(32), rollupProgramId: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8",
        mintAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      }],
    };
    const posts: Array<{ url: string; body: unknown }> = [];
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { posts.push({ url: String(url), body: JSON.parse(String(init.body)) }); return new Response("{}", { status: 200 }); }
      return new Response(JSON.stringify(record), { status: 200 });
    }) as unknown as typeof fetch;

    // wrapper-only (terminal): mint gate refuses
    const sponsor = new BridgeSponsor({
      bridgeApiUrl: "https://api.example", sponsorKeypair: {} as never, fetch: fetchFn,
      buildAndSendSettle: vi.fn(),
      getMintForChain: vi.fn().mockResolvedValue(new PublicKey("So11111111111111111111111111111111111111112")),
    } as never);
    const r = await sponsor.tickOnce("t9");
    expect(r.acted).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ skip: { degradation: "settle-skipped" } });

    // settle-skipped (hook failure): retryable — nothing posted
    posts.length = 0;
    const sponsor2 = new BridgeSponsor({
      bridgeApiUrl: "https://api.example", sponsorKeypair: {} as never, fetch: fetchFn,
      buildAndSendSettle: vi.fn().mockRejectedValue(new Error("rpc down")),
      getMintForChain: vi.fn().mockResolvedValue(new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")),
    } as never);
    const r2 = await sponsor2.tickOnce("t9");
    expect(r2.acted).toBe(false);
    expect(posts).toHaveLength(0);
  });
});
