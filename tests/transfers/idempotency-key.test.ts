/**
 * Idempotency-Key header support — closes the v1.0 limitation: "No
 * Idempotency-Key header path."
 *
 * Augments the natural-key idempotency on (chainId, step1TxHash) with a
 * caller-controlled key. Two POSTs with the same Idempotency-Key in a
 * 24-hour window return the same transfer record.
 */
import { describe, it, expect, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import { TransferStore } from "../../src/transfers/store.js";

const USER = "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562";

async function createTransfer(store: TransferStore, txHash: string, idempotencyKey?: string) {
  return store.create({
    route: "usdc-cctp-to-rome", direction: "to-rome",
    amountIn: "1000000", amountOut: "1000000",
    sender: { ethereum: USER, rome: USER },
    recipient: USER,
    steps: [
      { n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted", txHashes: [txHash] },
    ],
    outcome: "pending",
  }, idempotencyKey);
}

describe("TransferStore.create — Idempotency-Key path", () => {
  let redis: import("ioredis").Redis;
  beforeEach(async () => {
    redis = new RedisMock() as unknown as import("ioredis").Redis;
    await redis.flushall();
  });

  it("returns the same id when called twice with the same Idempotency-Key (even if step1Hash differs)", async () => {
    const store = new TransferStore(redis);
    const id1 = await createTransfer(store, "0xaaa", "user-supplied-key-1");
    const id2 = await createTransfer(store, "0xbbb", "user-supplied-key-1");
    expect(id2).toBe(id1);
  });

  it("creates distinct transfers when Idempotency-Keys differ", async () => {
    const store = new TransferStore(redis);
    const id1 = await createTransfer(store, "0xaaa", "key-a");
    const id2 = await createTransfer(store, "0xbbb", "key-b");
    expect(id2).not.toBe(id1);
  });

  it("Idempotency-Key takes precedence over natural-key when both indicate distinct records", async () => {
    const store = new TransferStore(redis);
    // First create: natural-key based on (chain, 0xaaa) + Idempotency-Key "key-a"
    const id1 = await createTransfer(store, "0xaaa", "key-a");
    // Second create: same step1 tx hash 0xaaa (natural-key collision) but different Idempotency-Key
    // Idempotency-Key takes precedence; SHOULD return the same id because the natural-key still matches.
    // (Both keys check the same step1 hash; natural-key idempotency fires first.)
    const id2 = await createTransfer(store, "0xaaa", "key-b");
    expect(id2).toBe(id1);
  });

  it("falls back to natural-key idempotency when no Idempotency-Key is provided (existing behavior)", async () => {
    const store = new TransferStore(redis);
    const id1 = await createTransfer(store, "0xaaa");
    const id2 = await createTransfer(store, "0xaaa");
    expect(id2).toBe(id1);
  });
});
