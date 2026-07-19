import { TransferStore } from "./store.js";
import { transferOutcomeTotal, pendingOldestAgeSeconds } from "../observability/metrics.js";
import type { TransferRecordT } from "./types.js";

export interface ReaperOpts {
  /** Max wall-clock a pending record may sit without user-actionable work before it expires. */
  maxPendingSeconds: number;
  warn?: ((msg: string) => void) | undefined;
}

/**
 * Any step the USER must act on (sign a claim, submit a tx). A record waiting
 * on one is user-paced — outbound claims may sit for days — and never expires.
 */
function hasUserActionableStep(record: TransferRecordT): boolean {
  return record.steps.some(
    (s) => s.userSigns === true && (s.status === "ready" || s.status === "submitted"),
  );
}

/**
 * Terminal-failure reaper (audit T1#2): before this, NOTHING ever wrote
 * outcome failed/expired — a permanently-stuck record retried every 5s
 * forever while reading "pending". A pending record whose sponsor-driven
 * progress stalled past maxPendingSeconds now flips to outcome "expired"
 * (+ SSE event + outcome metric) and drops out of the drive queue (the
 * pending list serves only outcome=pending).
 *
 * "expired" is a liveness verdict, not a funds verdict: the burn stays
 * claimable on-chain; recovery is re-registration/manual per the runbook.
 * Also refreshes the oldest-pending-age gauge (the "something is stalling"
 * alert signal) on every pass.
 */
export async function reapExpired(store: TransferStore, opts: ReaperOpts): Promise<string[]> {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const now = Date.now();
  const expired: string[] = [];
  let oldestPendingMs = 0;

  for (const id of await store.listPendingIds()) {
    const record = await store.get(id);
    if (!record || record.outcome !== "pending") continue;
    const ageMs = now - Date.parse(record.createdAt);
    if (hasUserActionableStep(record)) continue; // user-paced — never expire
    oldestPendingMs = Math.max(oldestPendingMs, ageMs);
    if (ageMs <= opts.maxPendingSeconds * 1000) continue;

    await store.expire(id, `sponsor progress stalled for ${Math.round(ageMs / 1000)}s (limit ${opts.maxPendingSeconds}s)`);
    transferOutcomeTotal.inc({ route: record.route, outcome: "expired" });
    warn(`[reaper] transfer ${id} expired after ${Math.round(ageMs / 1000)}s pending`);
    expired.push(id);
  }

  pendingOldestAgeSeconds.set(Math.round(oldestPendingMs / 1000));
  return expired;
}
