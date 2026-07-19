/**
 * /v1/health — real liveness, not vibes. The deployed-server incident this
 * closes: the worker container had never been stood up AND wrapper transfers
 * were silently stuck, yet health returned "ok" with hardcoded
 * lastFetchAgeSeconds: null.
 *
 * Contract:
 * - attestation.{circle,wormhole}.lastFetchAgeSeconds = real age from the
 *   in-process poller's shared attestationHealth object (null until the first
 *   successful vendor fetch — informational, never degrades: with zero
 *   in-flight transfers there is legitimately nothing to fetch).
 * - worker block from the redis heartbeat:
 *     ok       fresh heartbeat (< 60s)
 *     stale    heartbeat exists but old            → status: "degraded"
 *     missing  no heartbeat AND the API is configured for a worker
 *              (WORKER_INTERNAL_TOKEN set)         → status: "degraded"
 *     unknown  no heartbeat, no token (API-only deploy is legitimate)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePublishedChain } from "../helpers/chains";
import { buildApp } from "../../src/server";
import { WORKER_HEARTBEAT_KEY } from "../../src/routes/worker.js";

const dir = mkdtempSync(join(tmpdir(), "registry-"));
writePublishedChain(dir, "121301-marcus", {
  chain: { chainId: 121301, name: "Marcus", network: "devnet", status: "live", rpcUrl: "https://marcus.invalid", romeEvmProgramId: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8" },
  bridge: {
    sourceEvm: { chainId: 11155111, name: "Sepolia", cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", cctpMessageTransmitter: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD" },
    solana: { cctpDomain: 5 },
    assets: [{ id: "usdc", symbol: "USDC", solanaMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, sourceEvm: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", protocol: "cctp" } }],
  },
  tokens: [{ kind: "gas", mintId: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", gasPool: "AkZ6NSKzoM6Q3TqVwgtCixpjBDRqEhs5YTZxYzX6s2Jt", symbol: "USDC", decimals: 18, address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }],
});
process.env.BRIDGE_API_USE_IN_MEMORY_REDIS = "1";

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
});
afterAll(async () => { await app.close(); });

const redis = () => (app as never as { redis: import("ioredis").Redis }).redis;
const attHealth = () => (app as never as { attestationHealth: import("../../src/routes/routes-matrix").AttestationHealth }).attestationHealth;

beforeEach(async () => {
  await redis().del(WORKER_HEARTBEAT_KEY);
  attHealth().circle = { lastSuccessAt: null, lastFailureAt: null };
  attHealth().wormhole = { lastSuccessAt: null, lastFailureAt: null };
  delete process.env.WORKER_INTERNAL_TOKEN;
});

describe("GET /v1/health — attestation telemetry", () => {
  it("surfaces real poller fetch ages (null until a vendor fetch succeeded)", async () => {
    attHealth().circle.lastSuccessAt = Date.now() - 5_000;
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    const body = res.json();
    expect(body.attestation.circle.lastFetchAgeSeconds).toBeGreaterThanOrEqual(4);
    expect(body.attestation.circle.lastFetchAgeSeconds).toBeLessThanOrEqual(8);
    expect(body.attestation.wormhole.lastFetchAgeSeconds).toBeNull();
  });
});

describe("GET /v1/health — worker liveness", () => {
  it("unknown (and overall ok) when no heartbeat and no worker is configured", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    const body = res.json();
    expect(body.worker.status).toBe("unknown");
    expect(body.worker.lastPassAgeSeconds).toBeNull();
    expect(body.status).toBe("ok");
  });

  it("missing (and overall degraded) when a worker is configured but has never heartbeat", async () => {
    process.env.WORKER_INTERNAL_TOKEN = "expected-a-worker";
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    const body = res.json();
    expect(body.worker.status).toBe("missing");
    expect(body.status).toBe("degraded");
  });

  it("ok with a fresh heartbeat — pass stats surfaced", async () => {
    await redis().set(WORKER_HEARTBEAT_KEY, JSON.stringify({ ts: Date.now() - 3_000, processed: 5, acted: 1, durationMs: 640 }));
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    const body = res.json();
    expect(body.worker.status).toBe("ok");
    expect(body.worker.lastPassAgeSeconds).toBeGreaterThanOrEqual(2);
    expect(body.worker.lastPassAgeSeconds).toBeLessThanOrEqual(6);
    expect(body.worker.lastPass).toEqual({ processed: 5, acted: 1, durationMs: 640 });
    expect(body.status).toBe("ok");
  });

  it("stale (and overall degraded) when the heartbeat stops — the wedged-worker signature", async () => {
    await redis().set(WORKER_HEARTBEAT_KEY, JSON.stringify({ ts: Date.now() - 300_000, processed: 5, acted: 1, durationMs: 640 }));
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    const body = res.json();
    expect(body.worker.status).toBe("stale");
    expect(body.worker.lastPassAgeSeconds).toBeGreaterThanOrEqual(295);
    expect(body.status).toBe("degraded");
  });
});

describe("GET /v1/health — sponsor balance gate (audit T2#9)", () => {
  // A drained fee-payer stalls every transfer with warn-spam only. The worker
  // now reports its balance with each heartbeat; health degrades below the
  // floor so ops gets ONE clear signal instead of per-transfer noise.
  it("degrades when the reported sponsor balance is below the floor", async () => {
    await redis().set(WORKER_HEARTBEAT_KEY, JSON.stringify({
      ts: Date.now() - 2_000, processed: 3, acted: 1, durationMs: 500,
      sponsorLamports: 1_000_000, // 0.001 SOL — below the 0.05 SOL default floor
    }));
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    const body = res.json();
    expect(body.worker.status).toBe("ok");            // liveness is fine
    expect(body.worker.sponsorLamports).toBe(1_000_000);
    expect(body.worker.sponsorBalanceOk).toBe(false); // funding is not
    expect(body.status).toBe("degraded");
  });

  it("stays ok when the reported balance clears the floor", async () => {
    await redis().set(WORKER_HEARTBEAT_KEY, JSON.stringify({
      ts: Date.now() - 2_000, processed: 3, acted: 1, durationMs: 500,
      sponsorLamports: 500_000_000, // 0.5 SOL
    }));
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    const body = res.json();
    expect(body.worker.sponsorBalanceOk).toBe(true);
    expect(body.status).toBe("ok");
  });

  it("omits the balance verdict when the heartbeat carries no balance (older worker)", async () => {
    await redis().set(WORKER_HEARTBEAT_KEY, JSON.stringify({ ts: Date.now() - 2_000, processed: 1, acted: 0, durationMs: 100 }));
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    const body = res.json();
    expect(body.worker.status).toBe("ok");
    expect("sponsorBalanceOk" in body.worker).toBe(false);
    expect(body.status).toBe("ok");
  });
});
