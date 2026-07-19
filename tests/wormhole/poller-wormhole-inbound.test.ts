/**
 * Integration test for AttestationPoller's Wormhole inbound path.
 *
 * Covers the end-to-end "blocked → ready" advance for step 2
 * (wormhole-complete-transfer-wrapped) once:
 *   1. The source-side tx logs contain a `LogMessagePublished` event from
 *      the expected Token Bridge emitter.
 *   2. The Wormhole guardian network has signed the VAA (Wormholescan
 *      returns `status: complete`).
 *
 * Bridge-api previously stubbed handleWormholeInbound as a no-op — this
 * test demands real behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import RedisMock from "ioredis-mock";
import { encodeAbiParameters, parseAbiParameters, pad } from "viem";
import { AttestationPoller } from "../../src/attestation/poller.js";
import { TransferStore } from "../../src/transfers/store.js";
import { WORMHOLE_LOG_MESSAGE_PUBLISHED_TOPIC } from "../../src/wormhole/parse-log-message-published.js";

const SEPOLIA_TOKEN_BRIDGE = "0xDB5492265f6038831E89f495670FF909aDe94bd9";
const SEPOLIA_CORE_BRIDGE  = "0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78";
const SEPOLIA_WORMHOLE_CHAIN_ID = 10002;

function fakeTxLogs(emitter: string, sequence: bigint): any[] {
  return [
    {
      address: SEPOLIA_CORE_BRIDGE,
      topics: [
        WORMHOLE_LOG_MESSAGE_PUBLISHED_TOPIC,
        pad(emitter as `0x${string}`, { size: 32 }),
      ],
      data: encodeAbiParameters(
        parseAbiParameters("uint64, uint32, bytes, uint8"),
        [sequence, 0, "0x", 200],
      ),
    },
  ];
}

async function setupTransfer(store: TransferStore) {
  return store.create({
    route: "eth-wormhole-to-rome",
    direction: "to-rome",
    amountIn: "1000000000000000",
    amountOut: "100000",
    sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562", rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
    recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    steps: [
      { n: 1, chain: "ethereum", kind: "wormhole-wrap-and-transfer-eth", status: "submitted", txHashes: ["0xaabb"] },
      { n: 2, chain: "solana",   kind: "wormhole-complete-transfer-wrapped", status: "blocked", blockedBy: "step-1" },
      { n: 3, chain: "rome-200010", kind: "settle-inbound-bridge-sponsored", status: "blocked", blockedBy: "step-2" },
    ],
    outcome: "pending",
  });
}

describe("AttestationPoller — Wormhole inbound", () => {
  // ioredis-mock shares state across `new RedisMock()` instances by default;
  // flush before every test so transfer ids + step data start fresh.
  beforeEach(async () => {
    const r = new RedisMock() as unknown as import("ioredis").Redis;
    await r.flushall();
  });

  it("advances step 2 from blocked to ready when source-tx has LogMessagePublished + VAA is available", async () => {
    const redis = new RedisMock() as unknown as import("ioredis").Redis;
    const store = new TransferStore(redis);
    const id = await setupTransfer(store);

    const txLogReader = vi.fn().mockResolvedValue(fakeTxLogs(SEPOLIA_TOKEN_BRIDGE, 12345n));
    const circle = { fetch: vi.fn() };
    const wormhole = { fetch: vi.fn().mockResolvedValue({ status: "complete", vaa: "BASE64VAABYTES" }) };

    const poller = new AttestationPoller(
      store, circle as any, wormhole as any, txLogReader as any,
      { tokenBridgeEmitter: SEPOLIA_TOKEN_BRIDGE, wormholeChainId: SEPOLIA_WORMHOLE_CHAIN_ID },
    );
    await poller.tickOnce(id);

    expect(txLogReader).toHaveBeenCalledWith("0xaabb");
    expect(wormhole.fetch).toHaveBeenCalledWith(
      SEPOLIA_WORMHOLE_CHAIN_ID,
      expect.stringMatching(/^0xdb5492265f6038831e89f495670ff909ade94bd9$/i),
      12345n,
    );

    const updated = await store.get(id);
    expect(updated?.steps[1]?.status).toBe("ready");
    expect(updated?.steps[1]?.vaa).toBe("BASE64VAABYTES");
  });

  it("stays blocked when source-tx has no LogMessagePublished from the expected emitter", async () => {
    const redis = new RedisMock() as unknown as import("ioredis").Redis;
    const store = new TransferStore(redis);
    const id = await setupTransfer(store);

    const txLogReader = vi.fn().mockResolvedValue([]);   // no logs at all
    const circle = { fetch: vi.fn() };
    const wormhole = { fetch: vi.fn() };

    const poller = new AttestationPoller(
      store, circle as any, wormhole as any, txLogReader as any,
      { tokenBridgeEmitter: SEPOLIA_TOKEN_BRIDGE, wormholeChainId: SEPOLIA_WORMHOLE_CHAIN_ID },
    );
    await poller.tickOnce(id);

    expect(wormhole.fetch).not.toHaveBeenCalled();
    const updated = await store.get(id);
    expect(updated?.steps[1]?.status).toBe("blocked");
  });

  it("stays blocked when Wormholescan returns status: pending (guardians not done)", async () => {
    const redis = new RedisMock() as unknown as import("ioredis").Redis;
    const store = new TransferStore(redis);
    const id = await setupTransfer(store);

    const txLogReader = vi.fn().mockResolvedValue(fakeTxLogs(SEPOLIA_TOKEN_BRIDGE, 999n));
    const circle = { fetch: vi.fn() };
    const wormhole = { fetch: vi.fn().mockResolvedValue({ status: "pending" }) };

    const poller = new AttestationPoller(
      store, circle as any, wormhole as any, txLogReader as any,
      { tokenBridgeEmitter: SEPOLIA_TOKEN_BRIDGE, wormholeChainId: SEPOLIA_WORMHOLE_CHAIN_ID },
    );
    await poller.tickOnce(id);

    expect(wormhole.fetch).toHaveBeenCalledTimes(1);
    const updated = await store.get(id);
    expect(updated?.steps[1]?.status).toBe("blocked");
    expect(updated?.steps[1]?.vaa).toBeUndefined();
  });

  it("does nothing when no wormhole client is configured (degrades gracefully)", async () => {
    const redis = new RedisMock() as unknown as import("ioredis").Redis;
    const store = new TransferStore(redis);
    const id = await setupTransfer(store);

    const txLogReader = vi.fn();
    const circle = { fetch: vi.fn() };

    // wormhole client absent → 3rd ctor arg is undefined
    const poller = new AttestationPoller(
      store, circle as any, undefined, txLogReader as any,
      { tokenBridgeEmitter: SEPOLIA_TOKEN_BRIDGE, wormholeChainId: SEPOLIA_WORMHOLE_CHAIN_ID },
    );
    await poller.tickOnce(id);

    expect(txLogReader).not.toHaveBeenCalled();
    const updated = await store.get(id);
    expect(updated?.steps[1]?.status).toBe("blocked");
  });

  it("does nothing when no txLogReader is configured (degrades gracefully)", async () => {
    const redis = new RedisMock() as unknown as import("ioredis").Redis;
    const store = new TransferStore(redis);
    const id = await setupTransfer(store);

    const circle = { fetch: vi.fn() };
    const wormhole = { fetch: vi.fn() };

    // txLogReader + sourceChain config absent → can't parse, must be no-op
    const poller = new AttestationPoller(store, circle as any, wormhole as any);
    await poller.tickOnce(id);

    expect(wormhole.fetch).not.toHaveBeenCalled();
    const updated = await store.get(id);
    expect(updated?.steps[1]?.status).toBe("blocked");
  });
});
