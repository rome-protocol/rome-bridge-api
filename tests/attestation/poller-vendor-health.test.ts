/**
 * Vendor health must reflect UPSTREAM REACHABILITY, not attestation outcomes:
 * - any completed round-trip (complete OR pending) is a success — a transfer
 *   that sits pending for 20 min with Iris answering politely is a healthy
 *   upstream, not a stale one;
 * - a thrown fetch (network/timeout/5xx) marks a failure, so /v1/routes can
 *   degrade on real outages even though the tick's error is swallowed by the
 *   caller's catch.
 */
import { describe, it, expect } from "vitest";
import { AttestationPoller } from "../../src/attestation/poller";
import type { AttestationHealth } from "../../src/routes/routes-matrix";

const record = () => ({
  outcome: "pending",
  steps: [
    { n: 1, kind: "evm-burn", status: "confirmed", txHashes: ["0xabc"] },
    { n: 2, kind: "cctp-receive-message", status: "blocked" },
  ],
});

const freshHealth = (): AttestationHealth => ({
  circle: { lastSuccessAt: null, lastFailureAt: null },
  wormhole: { lastSuccessAt: null, lastFailureAt: null },
});

const storeStub = () =>
  ({ get: async () => record(), updateStep: async () => {} }) as never;

describe("poller vendor health marking", () => {
  it("marks a circle failure when the upstream fetch throws at the transport level", async () => {
    const health = freshHealth();
    const circle = { fetch: async () => { throw new Error("fetch failed: connect timeout"); } } as never;
    const poller = new AttestationPoller(storeStub(), circle, undefined, undefined, undefined, undefined, health);
    await expect(poller.tickOnce("t1")).rejects.toThrow("connect timeout");
    expect(health.circle.lastFailureAt).not.toBeNull();
    expect(health.circle.lastSuccessAt).toBeNull();
  });

  it("an HTTP error the upstream ANSWERED (Iris 404/5xx) is reachability success, not failure — one stuck record must not degrade every route", async () => {
    // The live regression this pins: a pending transfer whose V1 hash Iris
    // answers 404 threw on every 5s tick, out-stamping the fees probe's
    // successes and flipping all 20 routes degraded on the deployed server.
    const health = freshHealth();
    const err = Object.assign(new Error("Iris 404"), { upstreamAnswered: true });
    const circle = { fetch: async () => { throw err; } } as never;
    const poller = new AttestationPoller(storeStub(), circle, undefined, undefined, undefined, undefined, health);
    await expect(poller.tickOnce("t1")).rejects.toThrow("Iris 404");
    expect(health.circle.lastSuccessAt).not.toBeNull();
    expect(health.circle.lastFailureAt).toBeNull();
  });

  it("the shipped clients stamp upstreamAnswered on HTTP-status throws", async () => {
    const { CircleAttestationClient } = await import("../../src/attestation/circle");
    const fetch404 = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const client = new CircleAttestationClient({ baseUrl: "https://iris.invalid", fetch: fetch404 });
    await client.fetch("0xdead").then(
      () => { throw new Error("expected throw"); },
      (e) => { expect((e as { upstreamAnswered?: boolean }).upstreamAnswered).toBe(true); },
    );
  });

  it("marks a circle success on a pending answer — reachability, not outcome", async () => {
    const health = freshHealth();
    const circle = { fetch: async () => ({ status: "pending" as const }) } as never;
    const poller = new AttestationPoller(storeStub(), circle, undefined, undefined, undefined, undefined, health);
    await poller.tickOnce("t1");
    expect(health.circle.lastSuccessAt).not.toBeNull();
    expect(health.circle.lastFailureAt).toBeNull();
  });
});
