/**
 * Terminal-failure state (audit T1#2) — the structural root: nothing ever
 * wrote outcome failed/expired, so any permanently-stuck record retried every
 * 5s FOREVER while reading "pending" (the deployed-server incident's silent mode).
 *
 * reapExpired: a pending record whose sponsor-driven progress stalled past
 * maxPendingSeconds flips to outcome "expired" + an SSE event. Records with a
 * USER-actionable step in flight are exempt — outbound claims are user-paced
 * (users may redeem days later); expiry only judges sponsor stalling.
 */
import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import { TransferStore } from "../../src/transfers/store.js";
import { reapExpired } from "../../src/transfers/reaper.js";

const HOUR = 3600;

function baseRecord(over: Record<string, unknown> = {}) {
  return {
    route: "usdc-cctp-to-rome" as never,
    direction: "to-rome" as const,
    amountIn: "1000000", amountOut: "1000000",
    sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
    recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    steps: [
      { n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted", txHashes: ["0xab"] },
      { n: 2, chain: "solana", kind: "cctp-receive-message", status: "blocked", userSigns: false },
    ],
    outcome: "pending" as const,
    ...over,
  };
}

async function ageRecord(store: TransferStore, redis: import("ioredis").Redis, id: string, ageSeconds: number) {
  const raw = JSON.parse((await redis.get(`bridge:v1:transfer:${id}`))!);
  raw.createdAt = new Date(Date.now() - ageSeconds * 1000).toISOString();
  await redis.set(`bridge:v1:transfer:${id}`, JSON.stringify(raw));
}

describe("reapExpired", () => {
  let redis: import("ioredis").Redis;
  let store: TransferStore;
  beforeEach(async () => {
    redis = new RedisMock() as unknown as import("ioredis").Redis;
    await redis.flushall();
    store = new TransferStore(redis);
  });

  it("expires a sponsor-stalled pending record past the TTL, with an event", async () => {
    const id = await store.create(baseRecord() as never);
    await ageRecord(store, redis, id, 49 * HOUR);

    const reaped = await reapExpired(store, { maxPendingSeconds: 48 * HOUR });

    expect(reaped).toEqual([id]);
    const record = (await store.get(id))!;
    expect(record.outcome).toBe("expired");
    const events = await store.events.readAfter(id, 0);
    expect(events.some((e) => e.type === "outcome" && (e.data as { outcome?: string }).outcome === "expired")).toBe(true);
  });

  it("leaves young pending records alone", async () => {
    const id = await store.create(baseRecord() as never);
    await ageRecord(store, redis, id, 1 * HOUR);
    expect(await reapExpired(store, { maxPendingSeconds: 48 * HOUR })).toEqual([]);
    expect((await store.get(id))!.outcome).toBe("pending");
  });

  it("never expires a record whose next action is the USER's (outbound claim ready)", async () => {
    const id = await store.create(baseRecord({
      route: "usdc-cctp-from-rome",
      direction: "from-rome",
      steps: [
        { n: 1, chain: "rome-200010", kind: "cctp-burn-usdc", status: "confirmed", userSigns: true },
        { n: 2, chain: "evm-11155111", kind: "cctp-claim-on-destination", status: "ready", userSigns: true },
      ],
    }) as never);
    await ageRecord(store, redis, id, 200 * HOUR);
    expect(await reapExpired(store, { maxPendingSeconds: 48 * HOUR })).toEqual([]);
    expect((await store.get(id))!.outcome).toBe("pending");
  });

  it("leaves terminal records alone (complete stays complete)", async () => {
    const id = await store.create(baseRecord({
      steps: [{ n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "confirmed" }],
      outcome: "complete",
    }) as never);
    await ageRecord(store, redis, id, 200 * HOUR);
    expect(await reapExpired(store, { maxPendingSeconds: 48 * HOUR })).toEqual([]);
    expect((await store.get(id))!.outcome).toBe("complete");
  });

  it("an expired record stops appearing in the worker's pending list", async () => {
    const id = await store.create(baseRecord() as never);
    await ageRecord(store, redis, id, 49 * HOUR);
    await reapExpired(store, { maxPendingSeconds: 48 * HOUR });
    expect(await store.listPendingIds()).toEqual([]);
  });
});
