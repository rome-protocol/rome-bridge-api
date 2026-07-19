/**
 * GET /v1/transfers/pending — internal, token-gated enumeration of pending
 * transfer ids for the sponsor worker's tickOnce drive loop. Same gate as
 * settle-material (x-worker-token / WORKER_INTERNAL_TOKEN).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import RedisMock from "ioredis-mock";
import Fastify from "fastify";
import { TransferStore } from "../../src/transfers/store.js";
import { transfersRoutes } from "../../src/routes/transfers.js";

const TOKEN = "worker-secret-token";

async function buildApp(redis: import("ioredis").Redis) {
  const app = Fastify();
  app.decorate("redis", redis);
  app.decorate("config", { env: "test" } as never);
  await app.register((scope, _opts, done) => { transfersRoutes(scope as never, {} as never); done(); }, { prefix: "/v1" });
  return app;
}
async function mk(store: TransferStore, txHash: string, outcome: string) {
  return store.create({
    route: "usdc-cctp-to-rome", direction: "to-rome", amountIn: "1", amountOut: "1",
    sender: { ethereum: "0xa" }, recipient: "0xa",
    steps: [{ n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted", txHashes: [txHash] }],
    outcome,
  } as never);
}

describe("GET /v1/transfers/pending — worker enumeration (token-gated)", () => {
  let redis: import("ioredis").Redis;
  beforeEach(async () => { redis = new RedisMock() as unknown as import("ioredis").Redis; await redis.flushall(); process.env.WORKER_INTERNAL_TOKEN = TOKEN; });
  afterEach(() => { delete process.env.WORKER_INTERNAL_TOKEN; });

  it("returns only pending ids with the worker token (static route wins over /:id)", async () => {
    const store = new TransferStore(redis);
    const p1 = await mk(store, "0x1", "pending");
    await mk(store, "0x2", "complete");
    const app = await buildApp(redis);
    const res = await app.inject({ method: "GET", url: "/v1/transfers/pending", headers: { "x-worker-token": TOKEN } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ids: string[] }).ids).toEqual([p1]); // 200 + ids proves /:id didn't shadow it
    await app.close();
  });

  it("404s without the worker token", async () => {
    const app = await buildApp(redis);
    const res = await app.inject({ method: "GET", url: "/v1/transfers/pending" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
