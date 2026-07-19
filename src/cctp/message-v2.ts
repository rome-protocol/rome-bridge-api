/**
 * CCTP V2 message parser.
 *
 * Wire format (V2 — Circle "Message format" technical guide):
 *   header (148B) = [version:u32 | sourceDomain:u32 | destDomain:u32 |
 *                    nonce:bytes32 | sender:32 | recipient:32 | destCaller:32 |
 *                    minFinalityThreshold:u32 | finalityThresholdExecuted:u32]
 *   burn body (≥228B) = [bodyVersion:u32 | burnToken:32 | mintRecipient:32 |
 *                    amount:u256 | messageSender:32 | maxFee:u256 |
 *                    feeExecuted:u256 | expirationBlock:u256 | hookData:*]
 *
 * Multi-byte fields are big-endian. The V2 nonce is a 32-byte value assigned
 * off-chain by iris — NOT the V1 sequential u64 — which is why the Solana
 * used_nonce PDA model changed to one PDA per nonce.
 *
 * Reference implementation parity: the Rome app src/server/bridge/parse/messageV2.ts
 * (field-proven on live Sepolia + Monad transfers).
 */

const HEADER_LEN = 148;
const BODY_LEN = 228;
const MIN_LEN = HEADER_LEN + BODY_LEN;

export interface ParsedCctpMessageV2 {
  version: number;
  sourceDomain: number;
  destDomain: number;
  /** 32-byte iris-assigned nonce. */
  nonce: Uint8Array;
  sender: Uint8Array;
  recipient: Uint8Array;
  destCaller: Uint8Array;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  bodyVersion: number;
  burnToken: Uint8Array;
  /** Trailing 20 bytes of burnToken — the unpadded EVM address. */
  burnToken20: Uint8Array;
  mintRecipient: Uint8Array;
  amount: bigint;
  messageSender: Uint8Array;
  maxFee: bigint;
  feeExecuted: bigint;
  expirationBlock: bigint;
  hookData: Uint8Array;
}

export function parseCctpMessageV2(msg: Uint8Array): ParsedCctpMessageV2 {
  if (msg.length < MIN_LEN) {
    throw new Error(`CCTP V2 message too short: ${msg.length} bytes (need >= ${MIN_LEN})`);
  }
  const buf = Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength);
  const u256 = (off: number) => BigInt("0x" + buf.subarray(off, off + 32).toString("hex"));

  const burnToken = new Uint8Array(buf.subarray(HEADER_LEN + 4, HEADER_LEN + 36));
  return {
    version: buf.readUInt32BE(0),
    sourceDomain: buf.readUInt32BE(4),
    destDomain: buf.readUInt32BE(8),
    nonce: new Uint8Array(buf.subarray(12, 44)),
    sender: new Uint8Array(buf.subarray(44, 76)),
    recipient: new Uint8Array(buf.subarray(76, 108)),
    destCaller: new Uint8Array(buf.subarray(108, 140)),
    minFinalityThreshold: buf.readUInt32BE(140),
    finalityThresholdExecuted: buf.readUInt32BE(144),
    bodyVersion: buf.readUInt32BE(HEADER_LEN),
    burnToken,
    burnToken20: burnToken.subarray(12),
    mintRecipient: new Uint8Array(buf.subarray(HEADER_LEN + 36, HEADER_LEN + 68)),
    amount: u256(HEADER_LEN + 68),
    messageSender: new Uint8Array(buf.subarray(HEADER_LEN + 100, HEADER_LEN + 132)),
    maxFee: u256(HEADER_LEN + 132),
    feeExecuted: u256(HEADER_LEN + 164),
    expirationBlock: u256(HEADER_LEN + 196),
    hookData: new Uint8Array(buf.subarray(HEADER_LEN + BODY_LEN)),
  };
}
