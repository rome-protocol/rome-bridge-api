import { randomUUID } from "node:crypto";

/**
 * Records created before the per-record stamp existed drain as V1 Sepolia —
 * exactly the transport they were created under. Reserved trustless-settle fields default
 * to null. Explicit, tested defaults instead of scattered ?? fallbacks.
 */
export const LEGACY_IRIS_BASE = process.env.CIRCLE_IRIS_BASE_URL ?? "https://iris-api-sandbox.circle.com/v1";

export function backfillRecordDefaults(record: TransferRecordT, opts: { legacyIrisBase: string }): TransferRecordT {
  const out = { ...record };
  if (!out.stamp && out.route.startsWith("usdc-cctp")) {
    out.stamp = { sourceChainId: 11155111, cctpVersion: 1, cctpDomain: 0, irisBase: opts.legacyIrisBase };
  }
  if (out.userSettleSig === undefined) out.userSettleSig = null;
  if (out.settleDeadline === undefined) out.settleDeadline = null;
  return out;
}
import type { Redis } from "ioredis";
import { TransferRecord, TransferRecordT, CreateInput, TransferStepT } from "./types.js";
import { TransferEventLog } from "./events.js";
import { transferOutcomeTotal } from "../observability/metrics.js";

const RECORD_PREFIX    = "bridge:v1:transfer:";
const KEY_RECORD       = (id: string) => `${RECORD_PREFIX}${id}`;
const KEY_INDEX_STEP1  = (chain: string, txHash: string) => `bridge:v1:idx:step1:${chain}:${txHash.toLowerCase()}`;
const KEY_INDEX_ADDR   = (addr: string) => `bridge:v1:idx:addr:${addr.toLowerCase()}`;
const KEY_INDEX_IDEMP  = (key: string) => `bridge:v1:idx:idemp:${key}`;

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;   // 24h — matches spec window

function collectAddresses(record: Pick<TransferRecordT, "recipient" | "sender">): string[] {
  const addrs = new Set<string>();
  if (record.recipient)       addrs.add(record.recipient.toLowerCase());
  if (record.sender.ethereum) addrs.add(record.sender.ethereum.toLowerCase());
  if (record.sender.solana)   addrs.add(record.sender.solana.toLowerCase());
  if (record.sender.rome)     addrs.add(record.sender.rome.toLowerCase());
  return [...addrs];
}

export class TransferStore {
  readonly events: TransferEventLog;

  constructor(private redis: Redis) {
    this.events = new TransferEventLog(redis);
  }

  /**
   * Create a transfer with two idempotency guarantees:
   *   - Natural-key: existing record returned when (step.chain, step1TxHash)
   *     matches a prior create (checked first; cheap + always present).
   *   - Caller-supplied Idempotency-Key: existing record returned when the
   *     same key arrives within IDEMPOTENCY_TTL_SECONDS (24h).
   */
  async create(input: CreateInput, idempotencyKey?: string): Promise<string> {
    const step1 = input.steps[0];
    const step1Hash = step1?.txHashes?.[0];

    // 1. Natural-key check first — covers retries with the same source-tx hash.
    if (step1Hash) {
      const existing = await this.redis.get(KEY_INDEX_STEP1(step1.chain, step1Hash));
      if (existing) return existing;
    }
    // 2. Idempotency-Key check — covers retries where step1Hash isn't known yet
    //    or where the caller wants to deduplicate by their own request identifier.
    if (idempotencyKey) {
      const existing = await this.redis.get(KEY_INDEX_IDEMP(idempotencyKey));
      if (existing) return existing;
    }

    const id = `txf_${randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const record: TransferRecordT = { id, createdAt: now, updatedAt: now, completedAt: null, error: null, ...input };

    await this.redis.set(KEY_RECORD(id), JSON.stringify(record));
    await this.events.append(id, "created", { outcome: record.outcome });
    if (step1Hash) await this.redis.set(KEY_INDEX_STEP1(step1.chain, step1Hash), id);
    for (const addr of collectAddresses(record)) {
      await this.redis.sadd(KEY_INDEX_ADDR(addr), id);
    }
    if (idempotencyKey) {
      await this.redis.set(KEY_INDEX_IDEMP(idempotencyKey), id, "EX", IDEMPOTENCY_TTL_SECONDS);
    }
    return id;
  }

  /**
   * Return every transfer where the address appears as recipient OR as any of
   * the per-chain sender entries (ethereum / solana / rome). Backed by a Redis
   * SET written at create() time. O(n) on transfers per address, O(1) on
   * total transfers in the store.
   */
  async listByAddress(addr: string): Promise<TransferRecordT[]> {
    const ids = await this.redis.smembers(KEY_INDEX_ADDR(addr));
    const out: TransferRecordT[] = [];
    for (const id of ids) {
      const record = await this.get(id);
      if (record) out.push(record);
    }
    return out;
  }

  /**
   * All transfer ids with outcome "pending" — drives the sponsor worker's
   * tickOnce loop (the worker has no address, so listByAddress can't serve it).
   * v1 scans record keys + hydrates, the same cost the attestation poller already
   * pays (switch to a pending Redis SET if p99 crosses ~100ms at scale).
   */
  async listPendingIds(): Promise<string[]> {
    const keys = await this.redis.keys(KEY_RECORD("*"));
    const out: string[] = [];
    for (const key of keys) {
      const record = await this.get(key.slice(RECORD_PREFIX.length));
      if (record && record.outcome === "pending") out.push(record.id);
    }
    return out;
  }

  async get(id: string): Promise<TransferRecordT | null> {
    const raw = await this.redis.get(KEY_RECORD(id));
    if (!raw) return null;
    return backfillRecordDefaults(TransferRecord.parse(JSON.parse(raw)), { legacyIrisBase: LEGACY_IRIS_BASE });
  }

  async findByStep1TxHash(chain: string, txHash: string): Promise<TransferRecordT | null> {
    const id = await this.redis.get(KEY_INDEX_STEP1(chain, txHash.toLowerCase()));
    if (!id) return null;
    return this.get(id);
  }

  /** One-time purge of the stored settle authorization after settle submits. */
  async purgeSettleMaterial(id: string): Promise<TransferRecordT | null> {
    const record = await this.get(id);
    if (!record) return null;
    record.userSettleSig = null;
    record.updatedAt = new Date().toISOString();
    await this.redis.set(KEY_RECORD(id), JSON.stringify(record));
    return record;
  }

  async setDegradation(id: string, degradation: string, reason?: string): Promise<TransferRecordT | null> {
    const record = await this.get(id);
    if (!record) return null;
    record.degradation = degradation;
    record.degradationReason = reason ?? null;
    record.updatedAt = new Date().toISOString();
    await this.redis.set(KEY_RECORD(id), JSON.stringify(record));
    await this.events.append(id, "degradation", { degradation, ...(reason ? { reason } : {}) });
    return record;
  }

  async updateStep(id: string, n: number, patch: Partial<TransferStepT>): Promise<TransferRecordT | null> {
    const record = await this.get(id);
    if (!record) return null;
    const step = record.steps.find((s) => s.n === n);
    if (!step) return null;
    Object.assign(step, patch as TransferStepT);
    record.updatedAt = new Date().toISOString();
    const wasPending = record.outcome === "pending";
    if (record.steps.every((s) => s.status === "confirmed")) {
      record.outcome = "complete";
      record.completedAt = record.updatedAt;
    }
    await this.redis.set(KEY_RECORD(id), JSON.stringify(record));
    if (patch.status) await this.events.append(id, "step", { n, status: patch.status, kind: step.kind });
    if (wasPending && record.outcome === "complete") {
      await this.events.append(id, "outcome", { outcome: "complete" });
      transferOutcomeTotal.inc({ route: record.route, outcome: "complete" });
    }
    return record;
  }

  /**
   * Terminal liveness verdict (reaper-only): pending → expired + SSE event.
   * NOT a funds verdict — the source burn stays claimable; recovery is
   * re-registration/manual. No-op unless the record is still pending.
   */
  async expire(id: string, reason: string): Promise<TransferRecordT | null> {
    const record = await this.get(id);
    if (!record || record.outcome !== "pending") return record;
    record.outcome = "expired";
    record.error = reason;
    record.updatedAt = new Date().toISOString();
    await this.redis.set(KEY_RECORD(id), JSON.stringify(record));
    await this.events.append(id, "outcome", { outcome: "expired", reason });
    return record;
  }
}
