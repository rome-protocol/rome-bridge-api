import { describe, it, expect } from "vitest";
import { encodeAbiParameters, keccak256, toEventSelector, type Hex } from "viem";
import { parseSepoliaCctpMessage } from "../../src/cctp/sepolia-message-parse.js";

const MESSAGE_TRANSMITTER = "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD" as const;
const OTHER_CONTRACT     = "0x0000000000000000000000000000000000000001" as const;
const MESSAGE_SENT_TOPIC = toEventSelector("MessageSent(bytes)");
const SOMETHING_ELSE_TOPIC = toEventSelector("Transfer(address,address,uint256)");

interface SyntheticLog {
  address: `0x${string}`;
  topics: readonly Hex[];
  data: Hex;
}

function makeLog(addr: `0x${string}`, topic: Hex, messageBytes: Hex): SyntheticLog {
  const data = encodeAbiParameters([{ type: "bytes" }], [messageBytes]);
  return { address: addr, topics: [topic] as const, data };
}

function makeReceipt(opts: {
  status?: "success" | "reverted";
  logs?: SyntheticLog[];
}) {
  // Cast to `any` — viem's TransactionReceipt has many more fields, but the
  // parser only consults `status` and `logs`. Tests construct minimal fixtures.
  return { status: opts.status ?? "success", logs: opts.logs ?? [] } as any;
}

describe("parseSepoliaCctpMessage", () => {
  it("extracts message bytes and computes keccak256(message) for the matching log", () => {
    const messageBytes = "0xabcdef0123456789" as const;
    const receipt = makeReceipt({
      logs: [makeLog(MESSAGE_TRANSMITTER, MESSAGE_SENT_TOPIC, messageBytes)],
    });

    const parsed = parseSepoliaCctpMessage({ receipt, messageTransmitter: MESSAGE_TRANSMITTER });

    expect(parsed.message).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(parsed.message).toString("hex")).toBe("abcdef0123456789");
    expect(parsed.messageHash).toBe(keccak256(messageBytes));
  });

  it("ignores logs from other contracts even with the MessageSent topic", () => {
    const receipt = makeReceipt({
      logs: [
        makeLog(OTHER_CONTRACT,       MESSAGE_SENT_TOPIC, "0xdeadbeef"),
        makeLog(MESSAGE_TRANSMITTER,  MESSAGE_SENT_TOPIC, "0xbeefcafe"),
      ],
    });

    const parsed = parseSepoliaCctpMessage({ receipt, messageTransmitter: MESSAGE_TRANSMITTER });
    expect(Buffer.from(parsed.message).toString("hex")).toBe("beefcafe");
  });

  it("ignores logs from messageTransmitter with non-MessageSent topics", () => {
    const receipt = makeReceipt({
      logs: [
        makeLog(MESSAGE_TRANSMITTER,  SOMETHING_ELSE_TOPIC, "0xdeadbeef"),
        makeLog(MESSAGE_TRANSMITTER,  MESSAGE_SENT_TOPIC,   "0xbeefcafe"),
      ],
    });

    const parsed = parseSepoliaCctpMessage({ receipt, messageTransmitter: MESSAGE_TRANSMITTER });
    expect(Buffer.from(parsed.message).toString("hex")).toBe("beefcafe");
  });

  it("throws when receipt status is reverted", () => {
    const receipt = makeReceipt({
      status: "reverted",
      logs: [makeLog(MESSAGE_TRANSMITTER, MESSAGE_SENT_TOPIC, "0xbeefcafe")],
    });
    expect(() => parseSepoliaCctpMessage({ receipt, messageTransmitter: MESSAGE_TRANSMITTER }))
      .toThrow(/reverted/i);
  });

  it("throws when no matching MessageSent log is found", () => {
    const receipt = makeReceipt({
      logs: [makeLog(OTHER_CONTRACT, MESSAGE_SENT_TOPIC, "0xdeadbeef")],
    });
    expect(() => parseSepoliaCctpMessage({ receipt, messageTransmitter: MESSAGE_TRANSMITTER }))
      .toThrow(/MessageSent/);
  });

  it("matches messageTransmitter address case-insensitively", () => {
    // Real-world receipt logs sometimes lowercase addresses while the registry
    // ships them checksummed; we shouldn't miss a match purely on case.
    const checksummedAddr = MESSAGE_TRANSMITTER;
    const lowercased     = MESSAGE_TRANSMITTER.toLowerCase() as `0x${string}`;
    const receipt = makeReceipt({
      logs: [makeLog(lowercased, MESSAGE_SENT_TOPIC, "0xfeed")],
    });

    const parsed = parseSepoliaCctpMessage({ receipt, messageTransmitter: checksummedAddr });
    expect(Buffer.from(parsed.message).toString("hex")).toBe("feed");
  });

  it("returns the first MessageSent log when more than one is present", () => {
    // CCTP v1 emits exactly one MessageSent per burn, but we don't want
    // first-of-many to silently swap to the wrong message on future protocol
    // changes — assert deterministic ordering.
    const receipt = makeReceipt({
      logs: [
        makeLog(MESSAGE_TRANSMITTER, MESSAGE_SENT_TOPIC, "0x1111"),
        makeLog(MESSAGE_TRANSMITTER, MESSAGE_SENT_TOPIC, "0x2222"),
      ],
    });

    const parsed = parseSepoliaCctpMessage({ receipt, messageTransmitter: MESSAGE_TRANSMITTER });
    expect(Buffer.from(parsed.message).toString("hex")).toBe("1111");
  });
});
