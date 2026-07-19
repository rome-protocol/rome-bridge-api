import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server";
import { writePublishedChain } from "../helpers/chains";
import { RowCipher } from "../../src/lib/row-crypto";

const ROW_KEY = Buffer.alloc(32, 9).toString("base64");
const TOKEN = "worker-secret-token";
const SIG = "0x" + "ab".repeat(65);
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  writePublishedChain(dir, "121301-smtest", {
    chain: { chainId: 121301, name: "Marcus", network: "devnet", status: "live", rpcUrl: "https://marcus.invalid", romeEvmProgramId: "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf" },
  });
  process.env.BRIDGE_API_USE_IN_MEMORY_REDIS = "1";
  process.env.ROW_ENCRYPTION_KEY_BASE64 = ROW_KEY;
  process.env.WORKER_INTERNAL_TOKEN = TOKEN;
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
});
afterAll(async () => {
  delete process.env.ROW_ENCRYPTION_KEY_BASE64;
  delete process.env.WORKER_INTERNAL_TOKEN;
  await app.close();
});

async function seed(): Promise<string> {
  const id = "txf_smtest_" + Math.random().toString(16).slice(2, 10);
  await app.redis.set(`bridge:v1:transfer:${id}`, JSON.stringify({
    id, route: "usdc-cctp-to-rome", direction: "to-rome", amountIn: "1000000", amountOut: "1000000",
    sender: {}, recipient: "0xabc", outcome: "pending",
    steps: [{ n: 3, chain: "rome-121301", kind: "settle-inbound-bridge-sponsored", status: "ready", sourceChain: "11155111" }],
    stamp: { sourceChainId: 11155111, cctpVersion: 2, cctpDomain: 0, irisBase: "x" },
    userSettleSig: new RowCipher(ROW_KEY).encrypt(SIG),
    settleDeadline: Math.floor(Date.now() / 1000) + 3600,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  return id;
}

describe("internal settle-material endpoint", () => {
  it("public GET /transfers/:id redacts the sig — exposes only settleAuthorized:true", async () => {
    const id = await seed();
    const res = await app.inject({ method: "GET", url: `/v1/transfers/${id}` });
    const body = res.json();
    expect(body.userSettleSig).toBeUndefined();
    expect(body.settleAuthorized).toBe(true);
  });

  it("returns the DECRYPTED material to the worker with the right token", async () => {
    const id = await seed();
    const res = await app.inject({ method: "GET", url: `/v1/transfers/${id}/settle-material`, headers: { "x-worker-token": TOKEN } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userSettleSig).toBe(SIG);
    expect(body.sourceEvmChainId).toBe("11155111");
    expect(body.deadline).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("404s without the token, and on wrong tokens of both matching and differing length (const-time compare)", async () => {
    const id = await seed();
    expect((await app.inject({ method: "GET", url: `/v1/transfers/${id}/settle-material` })).statusCode).toBe(404);
    // shorter/differing-length wrong token — the length guard must not throw
    expect((await app.inject({ method: "GET", url: `/v1/transfers/${id}/settle-material`, headers: { "x-worker-token": "wrong" } })).statusCode).toBe(404);
    // same-length wrong token — timingSafeEqual path
    expect(TOKEN.length).toBe("worker-secret-WRONG".length);
    expect((await app.inject({ method: "GET", url: `/v1/transfers/${id}/settle-material`, headers: { "x-worker-token": "worker-secret-WRONG" } })).statusCode).toBe(404);
    // correct token still authorizes
    expect((await app.inject({ method: "GET", url: `/v1/transfers/${id}/settle-material`, headers: { "x-worker-token": TOKEN } })).statusCode).toBe(200);
  });

  it("POST purge clears the sig; GET then 404s", async () => {
    const id = await seed();
    const purge = await app.inject({ method: "POST", url: `/v1/transfers/${id}/settle-material`, headers: { "x-worker-token": TOKEN }, payload: { purgeSettleMaterial: true } });
    expect(purge.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: `/v1/transfers/${id}/settle-material`, headers: { "x-worker-token": TOKEN } });
    expect(after.statusCode).toBe(404);
    // public read now shows settleAuthorized:false
    expect((await app.inject({ method: "GET", url: `/v1/transfers/${id}` })).json().settleAuthorized).toBe(false);
  });
});
