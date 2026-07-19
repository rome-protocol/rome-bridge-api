/**
 * Parse Wormhole `LogMessagePublished` events from an EVM tx receipt's logs.
 *
 * On inbound ETH-via-Wormhole transfers, the Sepolia / Ethereum-mainnet Token
 * Bridge contract calls Wormhole Core Bridge's `publishMessage`. The Core
 * Bridge emits `LogMessagePublished` with `sender` = the Token Bridge
 * (= the emitter). The bridge sponsor needs this event's `sequence` to fetch
 * the signed VAA from the Wormhole guardian network.
 *
 * Event signature:
 *   event LogMessagePublished(
 *     address indexed sender,
 *     uint64  sequence,
 *     uint32  nonce,
 *     bytes   payload,
 *     uint8   consistencyLevel
 *   );
 *
 * topic[0] = keccak256("LogMessagePublished(address,uint64,uint32,bytes,uint8)")
 * topic[1] = sender padded to 32B
 * data    = abi.encode(sequence, nonce, payload, consistencyLevel)
 */
import { decodeAbiParameters, parseAbiParameters, getAddress } from "viem";

export const WORMHOLE_LOG_MESSAGE_PUBLISHED_TOPIC =
  "0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2";

export interface LogLike {
  address: string;
  topics: readonly string[];
  data: string;
}

export interface LogMessagePublishedDecoded {
  emitter: string;     // 20B EVM address, checksummed
  sequence: bigint;
  nonce: number;
  payload: string;     // 0x-hex
  consistencyLevel: number;
}

export function parseLogMessagePublished(
  logs: readonly LogLike[],
  expectedEmitter: string,
): LogMessagePublishedDecoded | null {
  const want = expectedEmitter.toLowerCase();
  for (const log of logs) {
    if (log.topics.length < 2) continue;
    if (log.topics[0]?.toLowerCase() !== WORMHOLE_LOG_MESSAGE_PUBLISHED_TOPIC) continue;

    // topic[1] is the indexed `sender` left-padded to 32B; extract last 20B.
    const senderHex = "0x" + log.topics[1]!.slice(-40);
    if (senderHex.toLowerCase() !== want) continue;

    try {
      const [sequence, nonce, payload, consistencyLevel] = decodeAbiParameters(
        parseAbiParameters("uint64, uint32, bytes, uint8"),
        log.data as `0x${string}`,
      ) as [bigint, number, `0x${string}`, number];

      return {
        emitter: getAddress(senderHex),
        sequence,
        nonce,
        payload,
        consistencyLevel,
      };
    } catch {
      // Malformed data field — skip; in a real Wormhole emission this shouldn't happen.
      continue;
    }
  }
  return null;
}
