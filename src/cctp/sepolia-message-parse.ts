/**
 * Sepolia CCTP `MessageSent` parser.
 *
 * Walks a Sepolia tx receipt, finds the `MessageSent(bytes)` event emitted by
 * the configured Circle `MessageTransmitter`, and returns the raw message bytes
 * plus `keccak256(message)` — the latter is the attestation key consumed by
 * Circle's IRIS API (`GET /attestations/{messageHash}`).
 *
 * The caller MUST pass the `messageTransmitter` address sourced from the
 * registry (`chain.bridge.sourceEvm.cctpMessageTransmitter`). The parser
 * itself holds no hardcoded contract addresses — that lets one process service
 * Sepolia (sandbox) and Ethereum mainnet receipts identically.
 */

import {
  decodeEventLog,
  hexToBytes,
  keccak256,
  parseAbi,
  type Hex,
  type TransactionReceipt,
} from "viem";

const MESSAGE_TRANSMITTER_ABI = parseAbi([
  "event MessageSent(bytes message)",
]);

export interface ParseSepoliaCctpMessageOpts {
  /** Sepolia (or mainnet) tx receipt. Status MUST be `"success"`. */
  receipt: Pick<TransactionReceipt, "status" | "logs">;
  /**
   * Circle `MessageTransmitter` address on the source EVM chain.
   * Sourced by callers from the registry: `chain.bridge.sourceEvm.cctpMessageTransmitter`.
   */
  messageTransmitter: `0x${string}`;
}

export interface ParsedSepoliaCctpMessage {
  /** Raw CCTP message bytes (the `bytes` payload of `MessageSent`). */
  message: Uint8Array;
  /** `keccak256(message)`. Used as the Circle IRIS attestation key. */
  messageHash: Hex;
}

export function parseSepoliaCctpMessage(opts: ParseSepoliaCctpMessageOpts): ParsedSepoliaCctpMessage {
  if (opts.receipt.status === "reverted") {
    throw new Error("Sepolia tx reverted; no CCTP message emitted");
  }

  const wantAddr = opts.messageTransmitter.toLowerCase();
  for (const log of opts.receipt.logs) {
    if (log.address.toLowerCase() !== wantAddr) continue;
    let decoded: { args: { message: Hex } };
    try {
      decoded = decodeEventLog({
        abi: MESSAGE_TRANSMITTER_ABI,
        data: log.data,
        topics: log.topics,
      }) as { args: { message: Hex } };
    } catch {
      // Some other event from the same contract — skip.
      continue;
    }
    const messageHex = decoded.args.message;
    return {
      message: hexToBytes(messageHex),
      messageHash: keccak256(messageHex),
    };
  }

  throw new Error(
    `no MessageSent(bytes) event found at ${opts.messageTransmitter} in receipt logs`,
  );
}
