import { describe, it, expect, vi } from "vitest";
import RedisMock from "ioredis-mock";
import { AttestationPoller } from "../../src/attestation/poller";
import { TransferStore } from "../../src/transfers/store";
import type { RecordStampT } from "../../src/transfers/types";

let txHashCounter = 100;
async function makeRecord(stamp: RecordStampT | undefined) {
  const redis = new RedisMock() as unknown as import("ioredis").Redis;
  const store = new TransferStore(redis);
  const step1Hash = `0xv2poll${(++txHashCounter).toString(16)}`;
  const id = await store.create({
    route: "usdc-cctp-to-rome", direction: "to-rome", amountIn: "1", amountOut: "1",
    sender: { ethereum: "0xabc" }, recipient: "0xabc",
    steps: [
      { n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted", txHashes: [step1Hash] },
      { n: 2, chain: "solana", kind: "cctp-receive-message", status: "blocked", blockedBy: "step-1" },
    ],
    outcome: "pending",
    ...(stamp ? { stamp } : {}),
  });
  return { store, id, step1Hash };
}

const V2_STAMP: RecordStampT = {
  sourceChainId: 10143, cctpVersion: 2, cctpDomain: 15,
  irisBase: "https://iris-api-sandbox.circle.com",
};

describe("AttestationPoller — record-keyed V1/V2 dispatch (drain guarantee)", () => {
  it("a V2-stamped record polls iris v2 with the record's base+domain and stores message+attestation", async () => {
    const { store, id, step1Hash } = await makeRecord(V2_STAMP);
    const v1 = { fetch: vi.fn() };
    const v2 = { fetchByTxHash: vi.fn().mockResolvedValue({ status: "complete", message: "0xM", attestation: "0xA" }), fetchByNonce: vi.fn() };
    const poller = new AttestationPoller(store, v1 as never, undefined, undefined, undefined, v2 as never);
    await poller.tickOnce(id);
    expect(v2.fetchByTxHash).toHaveBeenCalledWith("https://iris-api-sandbox.circle.com", 15, step1Hash);
    expect(v1.fetch).not.toHaveBeenCalled();
    const record = await store.get(id);
    expect(record!.steps[1]!.status).toBe("ready");
    expect(record!.steps[1]!.attestation).toBe("0xA");
    expect(record!.steps[1]!.message).toBe("0xM");
  });

  it("a V2 record still pending stays blocked", async () => {
    const { store, id } = await makeRecord(V2_STAMP);
    const v2 = { fetchByTxHash: vi.fn().mockResolvedValue({ status: "pending" }), fetchByNonce: vi.fn() };
    const poller = new AttestationPoller(store, { fetch: vi.fn() } as never, undefined, undefined, undefined, v2 as never);
    await poller.tickOnce(id);
    expect((await store.get(id))!.steps[1]!.status).toBe("blocked");
  });

  it("an unstamped legacy record drains via the V1 client (backfill defaults, never the V2 path)", async () => {
    const { store, id } = await makeRecord(undefined);
    const v1 = { fetch: vi.fn().mockResolvedValue({ status: "complete", attestation: "0xLEGACY" }) };
    const v2 = { fetchByTxHash: vi.fn(), fetchByNonce: vi.fn() };
    const poller = new AttestationPoller(store, v1 as never, undefined, undefined, undefined, v2 as never);
    await poller.tickOnce(id);
    expect(v1.fetch).toHaveBeenCalled();
    expect(v2.fetchByTxHash).not.toHaveBeenCalled();
    expect((await store.get(id))!.steps[1]!.attestation).toBe("0xLEGACY");
  });
});
