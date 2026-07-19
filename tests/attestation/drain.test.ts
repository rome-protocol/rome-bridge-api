import { describe, it, expect, vi } from "vitest";
import RedisMock from "ioredis-mock";
import { encodeAbiParameters, keccak256, stringToBytes } from "viem";
import { AttestationPoller } from "../../src/attestation/poller";
import { TransferStore } from "../../src/transfers/store";
import { BridgeSponsor } from "../../src/sponsor/bridge-sponsor";
import type { RecordStampT } from "../../src/transfers/types";

/**
 * Drain guarantee: an in-flight V1 record
 * completes under V1 transport end-to-end AFTER the registry says V2 —
 * every stage branches on the record's stamp, never on live config.
 */
const V1_STAMP: RecordStampT = {
  sourceChainId: 11155111, cctpVersion: 1, cctpDomain: 0,
  irisBase: "https://iris-api-sandbox.circle.com/v1",
  cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
  cctpMessageTransmitter: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD",
};

const V1_PROGRAMS = {
  messageTransmitterProgram: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
  tokenMessengerMinterProgram: "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
  splTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

const V1_MESSAGE_HEX = ("0x" + "00".repeat(4) + "00".repeat(112) + "00".repeat(132)) as `0x${string}`; // 248B shape
const MESSAGE_SENT_TOPIC = keccak256(stringToBytes("MessageSent(bytes)"));
const MESSAGE_SENT_DATA = encodeAbiParameters([{ type: "bytes" }], [V1_MESSAGE_HEX]);

describe("drain: V1 record completes after the catalog flips to V2", () => {
  it("poller recovers the V1 message from source logs; sponsor receives with V1 programs; V2 client never touched", async () => {
    const redis = new RedisMock() as unknown as import("ioredis").Redis;
    const store = new TransferStore(redis);
    const id = await store.create({
      route: "usdc-cctp-to-rome", direction: "to-rome", amountIn: "1", amountOut: "1",
      sender: { ethereum: "0xabc" }, recipient: "0xabc",
      steps: [
        { n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted", txHashes: ["0xdrainv1"] },
        {
          n: 2, chain: "solana", kind: "cctp-receive-message", status: "blocked", blockedBy: "step-1",
          programs: V1_PROGRAMS,
          recipientAta: "AfRKkAdG72zaaSvoHmTna1dg9G2eb8UjMWevW3q5LFvD",
          recipientPdaOwner: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA",
        },
      ],
      outcome: "pending",
      stamp: V1_STAMP,
    });

    // Live config is V2-everything — represented by the V2 client being the
    // "current" path; the V1 record must never reach it.
    const v2 = { fetchByTxHash: vi.fn(), fetchByNonce: vi.fn() };
    const v1 = { fetch: vi.fn().mockResolvedValue({ status: "complete", attestation: "0xV1ATT" }) };
    const txLogReader = vi.fn().mockResolvedValue([
      { address: V1_STAMP.cctpMessageTransmitter!, topics: [MESSAGE_SENT_TOPIC], data: MESSAGE_SENT_DATA },
    ]);

    const poller = new AttestationPoller(store, v1 as never, undefined, txLogReader, undefined, v2 as never);
    await poller.tickOnce(id);

    const record = await store.get(id);
    expect(record!.steps[1]!.status).toBe("ready");
    expect(record!.steps[1]!.attestation).toBe("0xV1ATT");
    expect(record!.steps[1]!.message).toBe(V1_MESSAGE_HEX);
    expect(v2.fetchByTxHash).not.toHaveBeenCalled();

    // Sponsor leg: dispatches the V1 receive with the V1 program set.
    const buildAndSendReceiveMessage = vi.fn().mockResolvedValue("sigV1receive");
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/steps/")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify(record), { status: 200 });
    }) as unknown as typeof fetch;
    const sponsor = new BridgeSponsor({
      bridgeApiUrl: "https://api.example",
      sponsorKeypair: {} as never,
      fetch: fetchFn,
      buildAndSendReceiveMessage,
    } as never);
    const r = await sponsor.tickOnce(id);
    expect(r.acted).toBe(true);
    expect(buildAndSendReceiveMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: V1_MESSAGE_HEX,
      attestation: "0xV1ATT",
      programs: V1_PROGRAMS,
    }));
  });

  it("V1 attestation complete but logs not yet readable → stays blocked (retry, never ready-but-unactionable)", async () => {
    const redis = new RedisMock() as unknown as import("ioredis").Redis;
    const store = new TransferStore(redis);
    const id = await store.create({
      route: "usdc-cctp-to-rome", direction: "to-rome", amountIn: "1", amountOut: "1",
      sender: { ethereum: "0xabc" }, recipient: "0xabc",
      steps: [
        { n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted", txHashes: ["0xdrainv1b"] },
        { n: 2, chain: "solana", kind: "cctp-receive-message", status: "blocked", blockedBy: "step-1" },
      ],
      outcome: "pending",
      stamp: V1_STAMP,
    });
    const v1 = { fetch: vi.fn().mockResolvedValue({ status: "complete", attestation: "0xV1ATT" }) };
    const txLogReader = vi.fn().mockRejectedValue(new Error("rpc lag"));
    const poller = new AttestationPoller(store, v1 as never, undefined, txLogReader);
    await poller.tickOnce(id);
    expect((await store.get(id))!.steps[1]!.status).toBe("blocked");
  });
});
