/**
 * Wormhole LogMessagePublished event parser — TDD spec.
 *
 * Event signature (canonical):
 *   event LogMessagePublished(
 *     address indexed sender,
 *     uint64  sequence,
 *     uint32  nonce,
 *     bytes   payload,
 *     uint8   consistencyLevel
 *   );
 *
 * topic0 = keccak256("LogMessagePublished(address,uint64,uint32,bytes,uint8)")
 *        = 0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2
 *
 * On Sepolia inbound Wormhole transfers, the Token Bridge contract calls
 * Wormhole Core Bridge's publishMessage. The event is emitted by the Core
 * Bridge with `sender` = Token Bridge (= the emitter).
 */
import { describe, it, expect } from "vitest";
import { encodeAbiParameters, parseAbiParameters, pad, toHex } from "viem";
import {
  parseLogMessagePublished,
  WORMHOLE_LOG_MESSAGE_PUBLISHED_TOPIC,
} from "../../src/wormhole/parse-log-message-published.js";

const SEPOLIA_TOKEN_BRIDGE = "0xDB5492265f6038831E89f495670FF909aDe94bd9";
const MAINNET_TOKEN_BRIDGE = "0x3ee18B2214AFF97000D974cf647E54bfb53b8d51";

function logMsgPublishedData(sequence: bigint, nonce: number, payload: `0x${string}`, consistency: number): `0x${string}` {
  return encodeAbiParameters(
    parseAbiParameters("uint64, uint32, bytes, uint8"),
    [sequence, nonce, payload, consistency],
  );
}

function makeLog(emitter: string, sequence: bigint): { address: `0x${string}`; topics: `0x${string}`[]; data: `0x${string}` } {
  return {
    address: "0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78", // Wormhole Sepolia Core Bridge — but parser doesn't enforce address
    topics: [
      WORMHOLE_LOG_MESSAGE_PUBLISHED_TOPIC as `0x${string}`,
      pad(emitter as `0x${string}`, { size: 32 }),
    ],
    data: logMsgPublishedData(sequence, 0, "0xdeadbeef", 200),
  };
}

describe("parseLogMessagePublished", () => {
  it("returns sequence when exactly one matching event is found from the expected emitter", () => {
    const logs = [
      makeLog(SEPOLIA_TOKEN_BRIDGE, 12345n),
    ];
    const out = parseLogMessagePublished(logs, SEPOLIA_TOKEN_BRIDGE);
    expect(out).not.toBeNull();
    expect(out!.sequence).toBe(12345n);
    expect(out!.emitter.toLowerCase()).toBe(SEPOLIA_TOKEN_BRIDGE.toLowerCase());
  });

  it("returns null when no log has the LogMessagePublished topic", () => {
    const logs = [
      {
        address: "0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78" as `0x${string}`,
        topics: ["0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as `0x${string}`,
                 pad(SEPOLIA_TOKEN_BRIDGE as `0x${string}`, { size: 32 })],
        data: "0x" as `0x${string}`,
      },
    ];
    const out = parseLogMessagePublished(logs, SEPOLIA_TOKEN_BRIDGE);
    expect(out).toBeNull();
  });

  it("returns null when topic matches but emitter is a different address (case-insensitive compare)", () => {
    const logs = [
      makeLog("0xCccccccccccccccccccccccccccccccccccCcCcc", 99n),
    ];
    const out = parseLogMessagePublished(logs, SEPOLIA_TOKEN_BRIDGE);
    expect(out).toBeNull();
  });

  it("filters to the expected emitter when multiple LogMessagePublished events are in the same tx", () => {
    // A tx might contain unrelated Wormhole emissions (e.g. from another integration). Pick ours.
    const logs = [
      makeLog("0xaaAAAAaaaaAAAAaaaaaaAAAAaaAAaaAaaAAaAAaa", 1n),  // not us
      makeLog(SEPOLIA_TOKEN_BRIDGE, 42n),                          // us
      makeLog("0xbBbbBBbBbBBbbbBbbBBBbbBBbBBbBBBbbbbBBBBb", 2n),  // also not us
    ];
    const out = parseLogMessagePublished(logs, SEPOLIA_TOKEN_BRIDGE);
    expect(out!.sequence).toBe(42n);
  });

  it("works case-insensitively on the emitter address comparison", () => {
    const logs = [
      makeLog(SEPOLIA_TOKEN_BRIDGE.toUpperCase().replace("0X", "0x"), 7n),
    ];
    const out = parseLogMessagePublished(logs, SEPOLIA_TOKEN_BRIDGE.toLowerCase());
    expect(out!.sequence).toBe(7n);
  });

  it("supports mainnet token bridge emitter just as well as Sepolia (caller picks)", () => {
    const logs = [
      makeLog(MAINNET_TOKEN_BRIDGE, 100n),
    ];
    const out = parseLogMessagePublished(logs, MAINNET_TOKEN_BRIDGE);
    expect(out!.sequence).toBe(100n);
  });
});
