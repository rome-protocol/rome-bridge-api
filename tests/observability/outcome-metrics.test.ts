/**
 * transferOutcomeTotal was defined but NEVER incremented (audit T2#5) — the
 * outcome counter every alert would hang off read zero forever. Terminal
 * transitions (complete via updateStep; expired via the reaper) must count.
 * pendingOldestAgeSeconds gives ops the "something is stalling" gauge.
 */
import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import { TransferStore } from "../../src/transfers/store.js";
import { reapExpired } from "../../src/transfers/reaper.js";
import { transferOutcomeTotal, pendingOldestAgeSeconds, registry } from "../../src/observability/metrics.js";

function pendingRecord() {
  return {
    route: "usdc-cctp-to-rome" as never,
    direction: "to-rome" as const,
    amountIn: "1", amountOut: "1",
    sender: {}, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    steps: [{ n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted" }],
    outcome: "pending" as const,
  };
}

async function metricValue(name: string, labels: Record<string, string>): Promise<number> {
  const m = (await registry.getMetricsAsJSON()).find((x) => x.name === name);
  const hit = (m?.values ?? []).find((v) =>
    Object.entries(labels).every(([k, val]) => (v.labels as Record<string, unknown>)[k] === val));
  return (hit?.value as number) ?? 0;
}

describe("terminal-outcome metrics", () => {
  let redis: import("ioredis").Redis;
  let store: TransferStore;
  beforeEach(async () => {
    redis = new RedisMock() as unknown as import("ioredis").Redis;
    await redis.flushall();
    store = new TransferStore(redis);
    transferOutcomeTotal.reset();
    pendingOldestAgeSeconds.set(0);
  });

  it("increments {route, outcome: complete} when the last step confirms", async () => {
    const before = await metricValue("rome_bridge_api_transfer_outcome_total", { route: "usdc-cctp-to-rome", outcome: "complete" });
    const id = await store.create(pendingRecord() as never);
    await store.updateStep(id, 1, { status: "confirmed" });
    const after = await metricValue("rome_bridge_api_transfer_outcome_total", { route: "usdc-cctp-to-rome", outcome: "complete" });
    expect(after).toBe(before + 1);
  });

  it("increments {route, outcome: expired} when the reaper expires", async () => {
    const id = await store.create(pendingRecord() as never);
    const raw = JSON.parse((await redis.get(`bridge:v1:transfer:${id}`))!);
    raw.createdAt = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    await redis.set(`bridge:v1:transfer:${id}`, JSON.stringify(raw));

    await reapExpired(store, { maxPendingSeconds: 48 * 3600 });
    const v = await metricValue("rome_bridge_api_transfer_outcome_total", { route: "usdc-cctp-to-rome", outcome: "expired" });
    expect(v).toBe(1);
  });

  it("reapExpired refreshes the oldest-pending-age gauge", async () => {
    const id = await store.create(pendingRecord() as never);
    const raw = JSON.parse((await redis.get(`bridge:v1:transfer:${id}`))!);
    raw.createdAt = new Date(Date.now() - 600 * 1000).toISOString();
    await redis.set(`bridge:v1:transfer:${id}`, JSON.stringify(raw));

    await reapExpired(store, { maxPendingSeconds: 48 * 3600 });
    const g = await metricValue("rome_bridge_api_pending_oldest_age_seconds", {});
    expect(g).toBeGreaterThanOrEqual(595);
    expect(g).toBeLessThanOrEqual(660);
  });
});
