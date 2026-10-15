import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { TransferRecord, TransferRecordT, CreateInput, TransferStepT } from "./types.js";
import { TransferEventLog } from "./events.js";
import { transferOutcomeTotal } from "../observability/metrics.js";

const RECORD_PREFIX    = "bridge:v1:transfer:";
const KEY_RECORD       = (id: string) => `${RECORD_PREFIX}${id}`;
const KEY_INDEX_STEP1  = (chain: string, txHash: string) => `bridge:v1:idx:step1:${chain}:${txHash.toLowerCase()}`;
const KEY_INDEX_ADDR   = (addr: string) => `bridge:v1:idx:addr:${addr.toLowerCase()}`;
const KEY_INDEX_IDEMP  = (key: string) => `bridge:v1:idx:idemp:${key}`;

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

/** Atomic create: single Redis eval performs the natural-key probe, the
 *  step-index reservation, the idempotency-key claim, the record persist and
 *  the address-index writes with no interleaving, so two concurrent POST
 *  /transfers sharing the same (step.chain, source-tx hash) can never both
 *  persist (TOCTOU on the pre-checks). Status: "exists" (id), "created" or
 *  "failed" (reason).
 *
 *  Redis/Lua reply-shape notes this script relies on:
 *    - GET on an absent key returns Lua false, never nil — test truthiness.
 *    - SET NX returns false on failure and +OK (Lua true) on success — never
 *      the number 1 — so compare against false, not 1. */
const ATOMIC_CREATE_LUA = `
local stepKey = KEYS[1]
local idemKey = KEYS[2]
local recordKey = KEYS[3]
local idemTTL = tonumber(ARGV[1])
local idemKeyVal = ARGV[2]
local recordJson = ARGV[3]
local recordId = ARGV[4]
local addrJson = ARGV[5]

-- 1. Natural-key probe: (step.chain, source-tx hash) -> existing record.
--    GET returns false (not nil) for an absent key, so test truthiness.
local existing = redis.call("GET", stepKey)
if existing then return { "exists", existing } end

-- 2. Reserve the record slot first (NX on the step index). SET NX returns
--    false on failure and +OK (Lua true) on success — never the number 1.
if redis.call("SET", stepKey, recordId, "NX") == false then
  return { "exists", redis.call("GET", stepKey) }
end

-- 3. Idempotency-key probe + claim (SET NX is the atomic claim), TTL 24h.
--    Claimed after the natural-key reservation so a losing race releases the
--    slot reserved above instead of leaking a pointer to a phantom record.
if idemKeyVal ~= "" then
  local e = redis.call("GET", idemKey)
  if e then
    redis.call("DEL", stepKey)
    return { "exists", e }
  end
  redis.call("SET", idemKey, recordId, "NX", "EX", idemTTL)
end

-- 4. Persist the record. Check the SET reply (false on failure) directly —
--    a follow-up GET can never observe an absent key as nil, so the old
--    "GET == nil" guard was dead code that reported silent failures as created.
if redis.call("SET", recordKey, recordJson, "NX") == false then
  return { "failed", "record-write-failed" }
end

-- 5. Address index: SADD every recipient/sender address into its index set
--    so GET /v1/transfers?address=... can find this record. Addresses arrive
--    as a comma-joined string (they never contain commas) and are split with
--    pure Lua so the script also runs under ioredis-mock's fengari VM, which
--    does not embed cjson.
for addr in string.gmatch(addrJson, "[^,]+") do
  redis.call("SADD", "bridge:v1:idx:addr:" .. addr, recordId)
end

return { "created" }
`;

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;   // 24h — matches spec window

function collectAddresses(record: Pick<TransferRecordT, "recipient" | "sender">): string[] {
  const addrs = new Set<string>();
  if (record.recipient)        addrs.add(record.recipient.toLowerCase());
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
   *    - Natural-key: existing record returned when (step.chain, step1TxHash)
   *      matches a prior create (checked first; cheap + always present).
   *    - Caller-supplied Idempotency-Key: existing record returned when the
   *      same key arrives within IDEMPOTENCY_TTL_SECONDS (24h).
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

    // 3. Atomic check-and-set through one Redis eval (ATOMIC_CREATE_LUA)
    const naturalKey = step1Hash
      ? KEY_INDEX_STEP1(step1.chain, step1Hash)
      : `bridge:v1:idx:nohash:${id}`;
    const result = (await this.redis.eval(
      ATOMIC_CREATE_LUA,
      3,
      naturalKey,
      KEY_INDEX_IDEMP(idempotencyKey ?? ""),
      KEY_RECORD(id),
      IDEMPOTENCY_TTL_SECONDS,
      idempotencyKey ?? "",
      JSON.stringify(record),
      id,
      collectAddresses(record).join(","),
    )) as [string, string?];
    if (result[0] === "exists") return result[1] as string;
    if (result[0] !== "created") {
      throw new Error(`transfer create aborted (${result[0]}): ${JSON.stringify(result)}`);
    }

    await this.events.append(id, "created", { outcome: record.outcome });
    return id;
  }

  async listByAddress(addr: string): Promise<TransferRecordT[]> {
    const ids = await this.redis.smembers(KEY_INDEX_ADDR(addr));
    const out: TransferRecordT[] = [];
    for (const id of ids) {
      const record = await this.get(id);
      if (record) out.push(record);
    }
    return out;
  }

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