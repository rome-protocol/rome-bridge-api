/**
 * Per-record ordered event log — the backing store for SSE `Last-Event-ID`
 * resume. One Redis list per transfer; seq is the
 * 1-based list index, so replay-after-seq is an LRANGE and ids are stable
 * across reconnects. TTL'd: events are a delivery aid, not the record of
 * truth (GET /transfers/{id} is).
 */
import type { Redis } from "ioredis";

const KEY = (id: string) => `bridge:v1:events:${id}`;
const EVENT_TTL_SECONDS = 7 * 24 * 3600;

export interface TransferEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  at: string;
}

export class TransferEventLog {
  constructor(private redis: Redis) {}

  async append(id: string, type: string, data: Record<string, unknown>): Promise<void> {
    const entry = JSON.stringify({ type, data, at: new Date().toISOString() });
    await this.redis.rpush(KEY(id), entry);
    await this.redis.expire(KEY(id), EVENT_TTL_SECONDS);
  }

  /** Events with seq > afterSeq, in order. */
  async readAfter(id: string, afterSeq: number): Promise<TransferEvent[]> {
    const raw = await this.redis.lrange(KEY(id), afterSeq, -1);
    return raw.map((entry, i) => ({ seq: afterSeq + i + 1, ...(JSON.parse(entry) as Omit<TransferEvent, "seq">) }));
  }
}
