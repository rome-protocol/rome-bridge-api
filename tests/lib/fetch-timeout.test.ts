import { describe, it, expect } from "vitest";
import { withTimeout } from "../../src/lib/fetch-timeout";
import { CircleAttestationClient } from "../../src/attestation/circle";

/** A fetch that hangs forever unless its AbortSignal fires. */
const hangingFetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as unknown as typeof fetch;

describe("withTimeout", () => {
  it("aborts a hung socket after the timeout instead of stalling forever", async () => {
    const fetchFn = withTimeout(hangingFetch, 50);
    await expect(fetchFn("https://iris.example/attestations/0xdead")).rejects.toThrow(/abort/i);
  });

  it("a caller-provided signal is preserved (caller abort wins)", async () => {
    const fetchFn = withTimeout(hangingFetch, 10_000);
    const controller = new AbortController();
    const p = fetchFn("https://x.example", { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });

  it("passes successful responses through untouched", async () => {
    const ok = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const res = await withTimeout(ok, 50)("https://x.example");
    expect(res.status).toBe(200);
  });
});

describe("attestation clients enforce timeouts (the hung-socket poller-stall class)", () => {
  it("CircleAttestationClient.fetch rejects on a hung upstream instead of hanging the poller tick", async () => {
    const client = new CircleAttestationClient({ baseUrl: "https://iris.example", fetch: hangingFetch, timeoutMs: 50 });
    await expect(client.fetch("0xdead")).rejects.toThrow(/abort/i);
  });
});
