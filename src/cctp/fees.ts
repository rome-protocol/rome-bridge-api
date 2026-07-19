/**
 * Circle V2 fees/capability probe.
 *
 * Fast Transfer is a per-route SUBSET (Ethereum/Arbitrum/Base/OP/Solana today;
 * Monad, Avalanche, Polygon are standard-only) and Circle explicitly warns
 * against hardcoding fees — so quote-time availability AND the fee both come
 * from `GET {irisBase}/v2/burn/USDC/fees/{srcDomain}/{dstDomain}`, cached with
 * a short TTL. Every failure mode is fail-closed to "unavailable": the quote
 * degrades to standard, it never blocks. Failures are not cached so the next
 * quote retries. Response-shape assumptions are re-validated by the funded
 * fast-transfer E2E against the live sandbox.
 */
import { withTimeout } from "../lib/fetch-timeout.js";

export type FastQuote = { available: false } | { available: true; bps: number };

export interface CircleFeesProbeOpts {
  fetch?: typeof fetch;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
  /**
   * Reachability report per real network round-trip (cache hits stay silent):
   * true for any HTTP answer — a 500 or standard-only body still proves Iris
   * is up — false only when the fetch throws (network/timeout). Feeds the
   * shared attestation health so /v1/routes has a live upstream signal even
   * when no transfers are in flight and the attestation poller is idle.
   */
  onUpstreamResult?: (ok: boolean) => void;
}

interface FeeRow {
  finalityThreshold?: number;
  minimumFee?: number;
}

const FAST_THRESHOLD_MAX = 1000;

export class CircleFeesProbe {
  private fetchFn: typeof fetch;
  private ttlMs: number;
  private now: () => number;
  private cache = new Map<string, { value: FastQuote; expiresAt: number }>();

  private onUpstreamResult: ((ok: boolean) => void) | undefined;

  constructor(opts: CircleFeesProbeOpts = {}) {
    this.fetchFn = withTimeout(opts.fetch ?? globalThis.fetch, opts.timeoutMs ?? 10_000);
    this.ttlMs = opts.ttlMs ?? 600_000;
    this.now = opts.now ?? Date.now;
    this.onUpstreamResult = opts.onUpstreamResult;
  }

  async fastQuote(irisBase: string, srcDomain: number, dstDomain: number): Promise<FastQuote> {
    const key = `${irisBase}|${srcDomain}|${dstDomain}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    let value: FastQuote = { available: false };
    let validResponse = false;
    let answered = false;
    try {
      const res = await this.fetchFn(`${irisBase}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}`, {
        headers: { accept: "application/json" },
      });
      answered = true;
      if (res.ok) {
        const body = (await res.json()) as unknown;
        const rows: FeeRow[] | null = Array.isArray(body)
          ? (body as FeeRow[])
          : Array.isArray((body as { data?: FeeRow[] })?.data)
            ? (body as { data: FeeRow[] }).data
            : null;
        if (rows !== null) {
          validResponse = true; // a standard-only route (no fast row) is a VALID answer — cacheable
          const fast = rows.find(
            (r) => typeof r.finalityThreshold === "number" && r.finalityThreshold <= FAST_THRESHOLD_MAX && typeof r.minimumFee === "number",
          );
          if (fast) value = { available: true, bps: fast.minimumFee! };
        }
      }
    } catch {
      // fail closed
    }
    this.onUpstreamResult?.(answered);

    // Cache valid answers (fast or standard-only); never cache transport/parse failures.
    if (validResponse) this.cache.set(key, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }
}
