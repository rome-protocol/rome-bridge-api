/**
 * POST /v1/worker/heartbeat — the sponsor worker reports each drive pass so
 * /v1/health can surface REAL worker liveness. The deployed-server incident this
 * closes: no worker container existed at all, yet health said "ok" — the only
 * failure signal was transfers silently never advancing.
 *
 * Same gate as the other worker-internal endpoints (WORKER_INTERNAL_TOKEN;
 * unset ⇒ 404, wrong token ⇒ 404 — indistinguishable from absent).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import RedisMock from "ioredis-mock";
import Fastify from "fastify";
import { workerRoutes, WORKER_HEARTBEAT_KEY } from "../../src/routes/worker.js";

async function buildApp(redis: import("ioredis").Redis) {
  const app = Fastify();
  app.decorate("redis", redis);
  await app.register((scope, _opts, done) => { workerRoutes(scope as never); done(); }, { prefix: "/v1" });
  return app;
}

describe("POST /v1/worker/heartbeat", () => {
  let redis: import("ioredis").Redis;
  beforeEach(async () => {
    redis = new RedisMock() as unknown as import("ioredis").Redis;
    await redis.flushall();
    process.env.WORKER_INTERNAL_TOKEN = "test-worker-token";
  });
  afterEach(() => {
    delete process.env.WORKER_INTERNAL_TOKEN;
    vi.useRealTimers();
  });

  it("404s without the worker token (and when the token is wrong)", async () => {
    const app = await buildApp(redis);
    const noToken = await app.inject({ method: "POST", url: "/v1/worker/heartbeat", payload: { processed: 1, acted: 0, durationMs: 12 } });
    expect(noToken.statusCode).toBe(404);
    const wrongToken = await app.inject({
      method: "POST", url: "/v1/worker/heartbeat",
      headers: { "x-worker-token": "nope" },
      payload: { processed: 1, acted: 0, durationMs: 12 },
    });
    expect(wrongToken.statusCode).toBe(404);
    expect(await redis.get(WORKER_HEARTBEAT_KEY)).toBeNull();
    await app.close();
  });

  it("stores the pass stats with a server-side timestamp", async () => {
    const app = await buildApp(redis);
    const res = await app.inject({
      method: "POST", url: "/v1/worker/heartbeat",
      headers: { "x-worker-token": "test-worker-token" },
      payload: { processed: 4, acted: 2, durationMs: 830 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const stored = JSON.parse((await redis.get(WORKER_HEARTBEAT_KEY))!);
    expect(stored).toMatchObject({ processed: 4, acted: 2, durationMs: 830 });
    expect(typeof stored.ts).toBe("number");
    expect(Math.abs(Date.now() - stored.ts)).toBeLessThan(5_000);
    await app.close();
  });

  it("rejects malformed stats with 400 (never poisons the health signal)", async () => {
    const app = await buildApp(redis);
    const res = await app.inject({
      method: "POST", url: "/v1/worker/heartbeat",
      headers: { "x-worker-token": "test-worker-token" },
      payload: { processed: "many" },
    });
    expect(res.statusCode).toBe(400);
    expect(await redis.get(WORKER_HEARTBEAT_KEY)).toBeNull();
    await app.close();
  });
});

describe("POST /v1/worker/heartbeat — sponsor balance", () => {
  it("stores optional sponsorLamports alongside the pass stats", async () => {
    process.env.WORKER_INTERNAL_TOKEN = "test-worker-token";
    const redis2 = new RedisMock() as unknown as import("ioredis").Redis;
    const app = await buildApp(redis2);
    const res = await app.inject({
      method: "POST", url: "/v1/worker/heartbeat",
      headers: { "x-worker-token": "test-worker-token" },
      payload: { processed: 2, acted: 1, durationMs: 400, sponsorLamports: 123_456_789 },
    });
    expect(res.statusCode).toBe(200);
    const stored = JSON.parse((await redis2.get(WORKER_HEARTBEAT_KEY))!);
    expect(stored.sponsorLamports).toBe(123_456_789);
    await app.close();
    delete process.env.WORKER_INTERNAL_TOKEN;
  });
});
