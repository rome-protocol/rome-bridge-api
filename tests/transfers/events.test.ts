import { describe, it, expect } from "vitest";
import RedisMock from "ioredis-mock";
import { TransferEventLog } from "../../src/transfers/events";
import { TransferStore } from "../../src/transfers/store";

const redis = () => new RedisMock() as unknown as import("ioredis").Redis;

describe("TransferEventLog — per-record ordered event log (SSE resume backing)", () => {
  it("appends monotonically sequenced events and replays after a given seq", async () => {
    const log = new TransferEventLog(redis());
    await log.append("t1", "created", { outcome: "pending" });
    await log.append("t1", "step", { n: 2, status: "ready" });
    await log.append("t1", "step", { n: 2, status: "confirmed" });
    const all = await log.readAfter("t1", 0);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    const resumed = await log.readAfter("t1", 2);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ seq: 3, type: "step", data: { n: 2, status: "confirmed" } });
  });

  it("logs are per-record", async () => {
    const log = new TransferEventLog(redis());
    await log.append("a", "created", {});
    await log.append("b", "created", {});
    expect(await log.readAfter("a", 0)).toHaveLength(1);
  });
});

describe("store emits events on mutations", () => {
  it("updateStep and setDegradation append to the record's event log", async () => {
    const r = redis();
    const store = new TransferStore(r);
    const id = await store.create({
      route: "usdc-cctp-to-rome", direction: "to-rome", amountIn: "1", amountOut: "1",
      sender: {}, recipient: "0xabc", outcome: "pending",
      steps: [{ n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted" }],
    });
    await store.updateStep(id, 1, { status: "confirmed" });
    await store.setDegradation(id, "settle-skipped", "why");
    const events = await new TransferEventLog(r).readAfter(id, 0);
    const types = events.map((e) => e.type);
    expect(types).toContain("created");
    expect(types).toContain("step");
    expect(types).toContain("degradation");
    const stepEvent = events.find((e) => e.type === "step")!;
    expect(stepEvent.data).toMatchObject({ n: 1, status: "confirmed" });
  });
});
