/**
 * CCTP v1 message parser.
 *
 * Decodes the on-the-wire `MessageSent.message` payload Circle's
 * `MessageTransmitter` emits for a BurnMessage. The output is consumed by:
 *   - `buildReceiveMessageInstruction` (Task 4) — sourceDomain/nonce/burnToken
 *     drive PDA derivations on Solana, mintRecipient is the ATA owner.
 *   - `buildSettleInboundBridgeInstruction` (Task 5) — amount is bridged_amount,
 *     mintRecipient → user EVM address derivation.
 *
 * Wire format (v1):
 *   header (116B) = [version:u32 | sourceDomain:u32 | destDomain:u32 |
 *                    nonce:u64 | sender:32 | recipient:32 | destCaller:32]
 *   body   (132B) = [bodyVersion:u32 | burnToken:32 | mintRecipient:32 |
 *                    amount:u256 | messageSender:32]
 *
 * Multi-byte fields are big-endian.
 *
 * Reference: the Rome app/src/server/bridge/parse/message.ts (same format,
 * different output shape — Uint8Array vs hex strings here).
 */

const HEADER_LEN = 116;
const BODY_LEN   = 132;
const MIN_LEN    = HEADER_LEN + BODY_LEN;

export interface ParsedCctpMessage {
  version: number;
  sourceDomain: number;
  destDomain: number;
  nonce: bigint;
  /** 32-byte sender (left-padded EVM address on source domain = 0). */
  sender: Uint8Array;
  /** 32-byte recipient (the destination program — e.g. TokenMessengerMinter on Solana). */
  recipient: Uint8Array;
  /** 32-byte dest caller (zero = anyone can submit). */
  destCaller: Uint8Array;
  /** 32-byte burn-token id (left-padded EVM token address on source domain = 0). */
  burnToken: Uint8Array;
  /** Convenience: trailing 20 bytes of `burnToken` — the unpadded EVM address. */
  burnToken20: Uint8Array;
  /** 32-byte mint recipient (Solana pubkey on dest domain = 5). */
  mintRecipient: Uint8Array;
  /** uint256 amount, in burn-token base units. */
  amount: bigint;
  /** 32-byte message sender (left-padded EVM address of the burn caller). */
  messageSender: Uint8Array;
}

export function parseCctpMessage(msg: Uint8Array): ParsedCctpMessage {
  if (msg.length < MIN_LEN) {
    throw new Error(`CCTP message too short: ${msg.length} bytes (need >= ${MIN_LEN})`);
  }
  const buf = Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength);

  const version      = buf.readUInt32BE(0);
  const sourceDomain = buf.readUInt32BE(4);
  const destDomain   = buf.readUInt32BE(8);
  const nonce        = buf.readBigUInt64BE(12);
  const sender       = new Uint8Array(buf.subarray(20, 52));
  const recipient    = new Uint8Array(buf.subarray(52, 84));
  const destCaller   = new Uint8Array(buf.subarray(84, 116));

  const burnToken     = new Uint8Array(buf.subarray(120, 152));
  const mintRecipient = new Uint8Array(buf.subarray(152, 184));
  const amount        = BigInt("0x" + buf.subarray(184, 216).toString("hex"));
  const messageSender = new Uint8Array(buf.subarray(216, 248));

  return {
    version, sourceDomain, destDomain, nonce,
    sender, recipient, destCaller,
    burnToken, burnToken20: burnToken.subarray(12),
    mintRecipient, amount, messageSender,
  };
}
