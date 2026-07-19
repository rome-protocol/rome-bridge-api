/**
 * TransferStore.listPendingIds — enumerates every transfer with outcome
 * "pending", regardless of address, so the sponsor worker can drive tickOnce on
 * all of them (the address-scoped listByAddress can't, since the worker has no
 * address to query). v1 scans record keys (same cost the attestation poller pays).
 */
import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import { TransferStore } from "../../src/transfers/store.js";

async function mk(store: TransferStore, txHash: string, outcome: string) {
  return store.create({
    route: "usdc-cctp-to-rome", direction: "to-rome", amountIn: "1", amountOut: "1",
    sender: { ethereum: "0xa" }, recipient: "0xa",
    steps: [{ n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted", txHashes: [txHash] }],
    outcome,
  } as never);
}

describe("TransferStore.listPendingIds", () => {
  let redis: import("ioredis").Redis;
  beforeEach(async () => { redis = new RedisMock() as unknown as import("ioredis").Redis; await redis.flushall(); });

  it("returns only pending transfer ids", async () => {
    const store = new TransferStore(redis);
    const p1 = await mk(store, "0x1", "pending");
    const p2 = await mk(store, "0x2", "pending");
    const done = await mk(store, "0x3", "complete");
    const ids = (await store.listPendingIds()).sort();
    expect(ids).toEqual([p1, p2].sort());
    expect(ids).not.toContain(done);
  });

  it("returns [] when there are no transfers", async () => {
    expect(await new TransferStore(redis).listPendingIds()).toEqual([]);
  });
});
