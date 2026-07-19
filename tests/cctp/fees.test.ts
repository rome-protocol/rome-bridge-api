import { describe, it, expect, vi } from "vitest";
import { CircleFeesProbe } from "../../src/cctp/fees";

const IRIS = "https://iris-api-sandbox.circle.com";

function stub(responder: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return responder(String(url));
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

// Documented shape: rows per finality threshold, minimumFee in bps.
const ETH_TO_SOLANA_FEES = [
  { finalityThreshold: 1000, minimumFee: 1 },
  { finalityThreshold: 2000, minimumFee: 0 },
];
const STANDARD_ONLY_FEES = [{ finalityThreshold: 2000, minimumFee: 0 }];

describe("CircleFeesProbe — live fast availability, fail-closed, cached", () => {
  it("hits the documented path and reports fast availability + bps", async () => {
    const { calls, fetchFn } = stub(() => new Response(JSON.stringify(ETH_TO_SOLANA_FEES), { status: 200 }));
    const probe = new CircleFeesProbe({ fetch: fetchFn });
    const q = await probe.fastQuote(IRIS, 0, 5);
    expect(calls[0]).toBe(`${IRIS}/v2/burn/USDC/fees/0/5`);
    expect(q).toEqual({ available: true, bps: 1 });
  });

  it("a route without a fast row (Monad/Avalanche/Polygon class) → unavailable, and the valid answer IS cached", async () => {
    const { calls, fetchFn } = stub(() => new Response(JSON.stringify(STANDARD_ONLY_FEES), { status: 200 }));
    const probe = new CircleFeesProbe({ fetch: fetchFn });
    expect(await probe.fastQuote(IRIS, 15, 5)).toEqual({ available: false });
    expect(await probe.fastQuote(IRIS, 15, 5)).toEqual({ available: false });
    expect(calls).toHaveLength(1); // standard-only is a valid, cacheable answer — no endpoint hammering
  });

  it("endpoint errors fail closed to unavailable (quote degrades to standard, never blocks)", async () => {
    const q500 = await new CircleFeesProbe({ fetch: stub(() => new Response("boom", { status: 500 })).fetchFn }).fastQuote(IRIS, 0, 5);
    expect(q500).toEqual({ available: false });
    const qThrow = await new CircleFeesProbe({
      fetch: stub(() => { throw new Error("network down"); }).fetchFn,
    }).fastQuote(IRIS, 0, 5);
    expect(qThrow).toEqual({ available: false });
    const qMalformed = await new CircleFeesProbe({ fetch: stub(() => new Response('{"weird": true}', { status: 200 })).fetchFn }).fastQuote(IRIS, 0, 5);
    expect(qMalformed).toEqual({ available: false });
  });

  it("caches per (base, src, dst) within the TTL; refetches after expiry", async () => {
    let now = 1_000_000;
    const { calls, fetchFn } = stub(() => new Response(JSON.stringify(ETH_TO_SOLANA_FEES), { status: 200 }));
    const probe = new CircleFeesProbe({ fetch: fetchFn, ttlMs: 600_000, now: () => now });
    await probe.fastQuote(IRIS, 0, 5);
    await probe.fastQuote(IRIS, 0, 5);
    expect(calls).toHaveLength(1);
    await probe.fastQuote(IRIS, 3, 5); // different route → own entry
    expect(calls).toHaveLength(2);
    now += 600_001;
    await probe.fastQuote(IRIS, 0, 5);
    expect(calls).toHaveLength(3);
  });

  it("reports upstream reachability via onUpstreamResult — HTTP answered (any status) = reachable, thrown fetch = not; cache hits stay silent", async () => {
    const seen: boolean[] = [];
    const onUpstreamResult = (ok: boolean) => seen.push(ok);
    // any HTTP response proves Iris is up — a 500 or a standard-only 404-class
    // answer is a reachable upstream, not an outage
    await new CircleFeesProbe({ fetch: stub(() => new Response("boom", { status: 500 })).fetchFn, onUpstreamResult }).fastQuote(IRIS, 0, 5);
    expect(seen).toEqual([true]);
    // network/timeout throw = unreachable
    await new CircleFeesProbe({ fetch: stub(() => { throw new Error("network down"); }).fetchFn, onUpstreamResult }).fastQuote(IRIS, 0, 5);
    expect(seen).toEqual([true, false]);
    // cache hits do a zero network round-trip — no reachability claim
    const probe = new CircleFeesProbe({ fetch: stub(() => new Response(JSON.stringify(ETH_TO_SOLANA_FEES), { status: 200 })).fetchFn, onUpstreamResult });
    await probe.fastQuote(IRIS, 0, 5);
    await probe.fastQuote(IRIS, 0, 5);
    expect(seen).toEqual([true, false, true]);
  });

  it("failures are NOT cached (next tick retries the endpoint)", async () => {
    let fail = true;
    const { calls, fetchFn } = stub(() => (fail ? new Response("boom", { status: 500 }) : new Response(JSON.stringify(ETH_TO_SOLANA_FEES), { status: 200 })));
    const probe = new CircleFeesProbe({ fetch: fetchFn });
    expect(await probe.fastQuote(IRIS, 0, 5)).toEqual({ available: false });
    fail = false;
    expect(await probe.fastQuote(IRIS, 0, 5)).toEqual({ available: true, bps: 1 });
    expect(calls).toHaveLength(2);
  });
});
