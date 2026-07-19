import { describe, it, expect, vi } from "vitest";
import { CircleV2AttestationClient } from "../../src/attestation/circle-v2";

const IRIS = "https://iris-api-sandbox.circle.com";

function stub(status: number, body?: unknown) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe("CircleV2AttestationClient", () => {
  it("constructs the exact documented path: /v2/messages/{srcDomain}?transactionHash=", async () => {
    const { calls, fetchFn } = stub(200, { messages: [] });
    const client = new CircleV2AttestationClient({ fetch: fetchFn });
    await client.fetchByTxHash(IRIS, 15, "0xa19614dc");
    expect(calls[0]).toBe(`${IRIS}/v2/messages/15?transactionHash=0xa19614dc`);
  });

  it("status complete + attestation gates readiness (message + attestation together)", async () => {
    const { fetchFn } = stub(200, {
      messages: [{ status: "complete", message: "0x0000000100000005…", attestation: "0xe156…", eventNonce: "0x8fc1…", cctpVersion: 2 }],
    });
    const r = await new CircleV2AttestationClient({ fetch: fetchFn }).fetchByTxHash(IRIS, 15, "0xabc");
    expect(r.status).toBe("complete");
    expect(r.message).toBe("0x0000000100000005…");
    expect(r.attestation).toBe("0xe156…");
  });

  it("pending_confirmations → pending (attestation may be literal 'PENDING')", async () => {
    const { fetchFn } = stub(200, { messages: [{ status: "pending_confirmations", attestation: "PENDING" }] });
    const r = await new CircleV2AttestationClient({ fetch: fetchFn }).fetchByTxHash(IRIS, 0, "0xabc");
    expect(r.status).toBe("pending");
  });

  it("404 → not-found (retryable; iris hasn't indexed the burn yet)", async () => {
    const { fetchFn } = stub(404);
    const r = await new CircleV2AttestationClient({ fetch: fetchFn }).fetchByTxHash(IRIS, 0, "0xabc");
    expect(r.status).toBe("not-found");
  });

  it("empty messages array → not-found; malformed body → failed", async () => {
    const empty = await new CircleV2AttestationClient({ fetch: stub(200, { messages: [] }).fetchFn }).fetchByTxHash(IRIS, 0, "0xabc");
    expect(empty.status).toBe("not-found");
    const bad = await new CircleV2AttestationClient({ fetch: stub(200, { nope: true }).fetchFn }).fetchByTxHash(IRIS, 0, "0xabc");
    expect(bad.status).toBe("failed");
  });

  it("fetchByNonce uses the nonce query param (outbound leg)", async () => {
    const { calls, fetchFn } = stub(200, { messages: [] });
    await new CircleV2AttestationClient({ fetch: fetchFn }).fetchByNonce(IRIS, 5, "0x8fc1fd73");
    expect(calls[0]).toBe(`${IRIS}/v2/messages/5?nonce=0x8fc1fd73`);
  });
});
