/**
 * In-process fixed-window rate limiter (fixed-window budgets) with the IETF
 * httpapi draft headers on every response. Self-hosted deployments get real
 * enforcement; edge-fronted deployments get honest headers that mirror the
 * documented budgets. Per-key limits replace per-IP when API keys land (v1.2).
 */
export interface RateClass {
  name: "quote" | "transfer-write" | "read";
  limitPerMin: number;
}

export function classify(method: string, url: string): RateClass {
  const quoteLimit = Number(process.env.BRIDGE_RATE_LIMIT_QUOTE_PER_MIN ?? 60);
  const writeLimit = Number(process.env.BRIDGE_RATE_LIMIT_WRITE_PER_MIN ?? 30);
  const readLimit = Number(process.env.BRIDGE_RATE_LIMIT_READ_PER_MIN ?? 600);
  if (method === "POST" && url.startsWith("/v1/quote")) return { name: "quote", limitPerMin: quoteLimit };
  if (method !== "GET" && url.startsWith("/v1/transfers")) return { name: "transfer-write", limitPerMin: writeLimit };
  return { name: "read", limitPerMin: readLimit };
}

interface Window {
  windowStart: number;
  count: number;
}

export class FixedWindowLimiter {
  private windows = new Map<string, Window>();
  constructor(private now: () => number = Date.now) {}

  /** Returns the state AFTER counting this request. */
  hit(ip: string, cls: RateClass): { allowed: boolean; limit: number; remaining: number; resetSeconds: number } {
    const nowMs = this.now();
    const windowStart = Math.floor(nowMs / 60_000) * 60_000;
    const key = `${ip}|${cls.name}`;
    let w = this.windows.get(key);
    if (!w || w.windowStart !== windowStart) {
      w = { windowStart, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 50_000) this.gc(windowStart);
    }
    w.count++;
    const resetSeconds = Math.max(1, Math.ceil((windowStart + 60_000 - nowMs) / 1000));
    return {
      allowed: w.count <= cls.limitPerMin,
      limit: cls.limitPerMin,
      remaining: Math.max(0, cls.limitPerMin - w.count),
      resetSeconds,
    };
  }

  private gc(currentWindow: number) {
    for (const [key, w] of this.windows) {
      if (w.windowStart !== currentWindow) this.windows.delete(key);
    }
  }
}
