import { describe, it, expect, vi, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import { AttestationPoller } from "../../src/attestation/poller";
import { TransferStore } from "../../src/transfers/store";
import { attestationPollerLagSeconds } from "../../src/observability/metrics";

// ioredis-mock shares state across instances within a process, so each test
// MUST use a distinct step1 tx hash — otherwise the natural-key idempotency
// check in TransferStore.create returns a prior test's id and the second test
// sees an already-advanced record.
let txHashCounter = 0;
async function makeStore(): Promise<{ redis: import("ioredis").Redis; store: TransferStore; id: string }> {
  const redis = new RedisMock() as unknown as import("ioredis").Redis;
  await redis.flushall();
  const store = new TransferStore(redis);
  const step1Hash = `0xa1b2${(++txHashCounter).toString(16).padStart(4, "0")}`;
  const id = await store.create({
    route: "usdc-cctp-to-rome", direction: "to-rome", amountIn: "100000000", amountOut: "100000000",
    sender: { ethereum: "0xabc", rome: "0xabc" }, recipient: "0xabc",
    steps: [
      { n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted", txHashes: [step1Hash] },
      { n: 2, chain: "solana",   kind: "cctp-receive-message",     status: "blocked",   blockedBy: "step-1" },
      { n: 3, chain: "rome-121301", kind: "claim-as-gas",          status: "blocked",   blockedBy: "step-2" },
    ],
    outcome: "pending",
  });
  return { redis, store, id };
}

describe("AttestationPoller", () => {
  beforeEach(() => {
    // Reset the gauge between tests so we observe THIS test's writes only.
    attestationPollerLagSeconds.reset();
  });

  it("advances step 2 from blocked to ready when Circle returns complete", async () => {
    const { store, id } = await makeStore();
    const circleStub = { fetch: vi.fn().mockResolvedValue({ status: "complete", attestation: "0xattestation" }) };
    const poller = new AttestationPoller(store, circleStub as any);
    await poller.tickOnce(id);

    const updated = await store.get(id);
    expect(updated?.steps[1]?.status).toBe("ready");
    expect(updated?.steps[1]?.attestation).toBe("0xattestation");
  });

  it("updates the per-vendor lag gauge on successful Circle attestation fetch", async () => {
    const { store, id } = await makeStore();
    const circleStub = { fetch: vi.fn().mockResolvedValue({ status: "complete", attestation: "0xok" }) };
    const poller = new AttestationPoller(store, circleStub as any);
    await poller.tickOnce(id);

    const sample = await attestationPollerLagSeconds.get();
    const circleSample = sample.values.find((v) => v.labels.vendor === "circle");
    expect(circleSample).toBeDefined();
    // On a fresh successful fetch the lag should be effectively zero.
    expect(circleSample!.value).toBeLessThan(1);
  });

  it("updates the gauge when Circle returns pending — a polite answer is a healthy upstream (reachability, not outcome)", async () => {
    // The old only-on-complete rule fed the idle-looks-degraded false positive:
    // a transfer legitimately pending for 20 min read as a stale upstream.
    const { store, id } = await makeStore();
    const circleStub = { fetch: vi.fn().mockResolvedValue({ status: "pending" }) };
    const poller = new AttestationPoller(store, circleStub as any);
    await poller.tickOnce(id);

    const sample = await attestationPollerLagSeconds.get();
    const circleSample = sample.values.find((v) => v.labels.vendor === "circle");
    expect(circleSample).toBeDefined();
    expect(circleSample!.value).toBeLessThan(1);
  });
});
