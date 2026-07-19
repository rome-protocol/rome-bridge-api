import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import { TransferStore } from "../../src/transfers/store";

let store: TransferStore;

beforeEach(() => {
  store = new TransferStore(new RedisMock() as unknown as import("ioredis").Redis);
});

describe("TransferStore", () => {
  it("creates a transfer, gets it back by id, and lists by sourceTxHash", async () => {
    const id = await store.create({
      route: "usdc-cctp-to-rome",
      direction: "to-rome",
      amountIn: "100000000",
      amountOut: "100000000",
      sender: { ethereum: "0xabc", rome: "0xabc" },
      recipient: "0xabc",
      steps: [{ n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted", txHashes: ["0xa1b2"] },
              { n: 2, chain: "solana", kind: "cctp-receive-message", status: "blocked", blockedBy: "step-1" },
              { n: 3, chain: "rome-121301", kind: "claim-as-gas", status: "blocked", blockedBy: "step-2" }],
      outcome: "pending",
    });
    const got = await store.get(id);
    expect(got?.steps).toHaveLength(3);

    const byHash = await store.findByStep1TxHash("ethereum", "0xa1b2");
    expect(byHash?.id).toBe(id);
  });

  it("upserts idempotently on the same (sourceChain, step1TxHash) — returns the existing id", async () => {
    const id1 = await store.create({
      route: "usdc-cctp-to-rome", direction: "to-rome", amountIn: "100000000", amountOut: "100000000",
      sender: { ethereum: "0xabc", rome: "0xabc" }, recipient: "0xabc",
      steps: [{ n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted", txHashes: ["0xa1b2"] }],
      outcome: "pending",
    });
    const id2 = await store.create({
      route: "usdc-cctp-to-rome", direction: "to-rome", amountIn: "100000000", amountOut: "100000000",
      sender: { ethereum: "0xabc", rome: "0xabc" }, recipient: "0xabc",
      steps: [{ n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted", txHashes: ["0xa1b2"] }],
      outcome: "pending",
    });
    expect(id2).toBe(id1);
  });
});
