/**
 * GET /v1/transfers?address=… — list endpoint (closes the v1.0 limitation
 * documented in README, replaces the sponsor worker's polling-by-keys-scan).
 *
 * Indexing model: TransferStore.create adds the transfer id to a Redis SET
 * keyed by each address that appears in the record (recipient + sender.*).
 * listByAddress queries the SET, hydrates each id, returns the records.
 */
import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import Fastify from "fastify";
import { TransferStore } from "../../src/transfers/store.js";
import { transfersRoutes } from "../../src/routes/transfers.js";

const USER_A = "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562";
const USER_B = "0x4567cdE12345678901234567890abcdef9012345";

async function buildApp(redis: import("ioredis").Redis) {
  const app = Fastify();
  app.decorate("redis", redis);
  app.decorate("config", { env: "test" } as any);
  await app.register((scope, _opts, done) => { transfersRoutes(scope as any, {} as any); done(); }, { prefix: "/v1" });
  return app;
}

async function createTransfer(store: TransferStore, recipient: string, txHash: string) {
  return store.create({
    route: "usdc-cctp-to-rome", direction: "to-rome",
    amountIn: "1000000", amountOut: "1000000",
    sender: { ethereum: recipient, rome: recipient },
    recipient,
    steps: [
      { n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted", txHashes: [txHash] },
    ],
    outcome: "pending",
  });
}

describe("TransferStore.listByAddress", () => {
  let redis: import("ioredis").Redis;
  beforeEach(async () => {
    redis = new RedisMock() as unknown as import("ioredis").Redis;
    await redis.flushall();
  });

  it("returns all transfers where the address appears as recipient or sender", async () => {
    const store = new TransferStore(redis);
    const id1 = await createTransfer(store, USER_A, "0xtx1");
    const id2 = await createTransfer(store, USER_A, "0xtx2");
    await createTransfer(store, USER_B, "0xtx3");  // different user, should be excluded

    const out = await store.listByAddress(USER_A);
    const ids = out.map((r) => r.id).sort();
    expect(ids).toEqual([id1, id2].sort());
  });

  it("is case-insensitive on address comparison", async () => {
    const store = new TransferStore(redis);
    await createTransfer(store, USER_A.toLowerCase(), "0xtx-low");
    await createTransfer(store, USER_A.toUpperCase(), "0xtx-up");

    const out = await store.listByAddress(USER_A);
    expect(out).toHaveLength(2);
  });

  it("returns empty when no transfers match", async () => {
    const store = new TransferStore(redis);
    await createTransfer(store, USER_A, "0xtx1");

    const out = await store.listByAddress(USER_B);
    expect(out).toEqual([]);
  });
});

describe("GET /v1/transfers?address=…", () => {
  let redis: import("ioredis").Redis;
  beforeEach(async () => {
    redis = new RedisMock() as unknown as import("ioredis").Redis;
    await redis.flushall();
  });

  it("returns the user's transfers when address is provided", async () => {
    const store = new TransferStore(redis);
    const id1 = await createTransfer(store, USER_A, "0xab");
    const id2 = await createTransfer(store, USER_A, "0xcd");
    const app = await buildApp(redis);

    const res = await app.inject({ method: "GET", url: `/v1/transfers?address=${USER_A}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { transfers: Array<{ id: string }> };
    const ids = body.transfers.map((t) => t.id).sort();
    expect(ids).toEqual([id1, id2].sort());
    await app.close();
  });

  it("returns 400 when address is missing", async () => {
    const app = await buildApp(redis);
    const res = await app.inject({ method: "GET", url: "/v1/transfers" });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string };
    expect(body.code).toBe("rome.bridge.request-invalid"); // missing query param = malformed request, not a bad recipient
    await app.close();
  });

  it("never exposes the settle authorization (even encrypted) — same contract as GET /:id", async () => {
    const store = new TransferStore(redis);
    const id = await store.create({
      route: "usdc-cctp-to-rome", direction: "to-rome",
      amountIn: "1000000", amountOut: "1000000",
      sender: { ethereum: USER_A }, recipient: USER_A,
      steps: [{ n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted", txHashes: ["0xab"] }],
      outcome: "pending",
      userSettleSig: "encrypted-blob-never-expose",
      settleDeadline: 1783383616,
    } as never);
    const app = await buildApp(redis);

    const res = await app.inject({ method: "GET", url: `/v1/transfers?address=${USER_A}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { transfers: Array<Record<string, unknown>> };
    const item = body.transfers.find((t) => t.id === id)!;
    expect(item).toBeDefined();
    expect("userSettleSig" in item).toBe(false);
    expect(item.settleAuthorized).toBe(true);
    await app.close();
  });
});
