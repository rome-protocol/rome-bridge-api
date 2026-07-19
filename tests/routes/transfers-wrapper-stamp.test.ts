/**
 * WRAPPER-intent registrations must stamp — V2 fixture edition.
 *
 * resolveStamp pulls the Rome chain from outputs[].chainId or a rome-<id>
 * step.chain. Wrapper quotes have no settle step (no rome-<id> chain), so
 * outputs[].chainId is the ONLY anchor. Without it the record registers
 * UNSTAMPED → backfillRecordDefaults reads it back as CCTP V1 Sepolia → the
 * poller queries the V1 IRIS path for a V2 burn → 404 forever → the transfer
 * never delivers. (Live-diagnosed on the deployed server: gas-intent transfers
 * green, every wrapper-intent transfer stuck at step 1.)
 *
 * The V1-era fixture in transfers.test.ts can't catch this — there a real V1
 * stamp and the V1 backfill are byte-identical. The published Hadrian fixture
 * is V2, so a REAL stamp (cctpVersion 2, V2 messenger) is distinguishable
 * from the backfill.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { FIXTURES_DIR } from "../helpers/chains";
import { buildApp } from "../../src/server";

process.env.BRIDGE_API_USE_IN_MEMORY_REDIS = "1";

const readTx = vi.fn();

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: FIXTURES_DIR });
  (app as never as { decorate: (k: string, v: unknown) => void }).decorate("ethereumReader", { readTx });
});
afterAll(async () => { await app.close(); });

describe("POST /v1/transfers — wrapper-intent stamping (V2 chain)", () => {
  it("a wrapper-intent V2 registration stamps V2 (never falls to the V1 backfill)", async () => {
    const qres = await app.inject({ method: "POST", url: "/v1/quote", payload: {
      asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "200010",
      intent: "wrapper",
      amount: "1000000",
      sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    }});
    expect(qres.statusCode).toBe(200);
    const quote = qres.json();
    expect(quote.cctpVersion).toBe(2);
    expect(quote.outputs?.[0]?.kind).toBe("wrapper");
    // The anchor itself: wrapper outputs carry the Rome chain id.
    expect(quote.outputs?.[0]?.chainId).toBe("200010");

    const expectedTx = quote.steps[0].unsignedTxs.at(-1);
    readTx.mockResolvedValue({ to: expectedTx.to, data: expectedTx.data, value: expectedTx.value });
    const tres = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: "0x" + "ef".repeat(32) } });
    expect(tres.statusCode).toBe(200);
    const record = tres.json();
    // A REAL stamp, not the V1 backfill: version 2 + the V2 messenger.
    expect(record.stamp?.cctpVersion).toBe(2);
    expect(record.stamp?.cctpTokenMessenger).toBe("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA");
  });

  it("REJECTS a V2 registration when stamping cannot resolve — never degrades to the V1 backfill (audit item 10)", async () => {
    // Stamp failure on a V2 quote used to register UNSTAMPED → V1 backfill →
    // the poller 404s the V1 IRIS path forever (Bug-B's disease, robustness
    // flavor). Fail registration loudly instead: the client retries with a
    // fresh quote; nothing lands in a permanently-undeliverable state.
    const qres = await app.inject({ method: "POST", url: "/v1/quote", payload: {
      asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "200010",
      intent: "wrapper",
      amount: "1000000",
      sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    }});
    const quote = qres.json();
    // Break the stamp anchor: an unknown Rome chain id (caller-tampered or
    // registry drift) → resolveStamp finds no chain.
    quote.outputs[0].chainId = "999999";
    quote.steps = quote.steps.filter((s: { chain?: string }) => !/^rome-/.test(s.chain ?? ""));

    const expectedTx = quote.steps[0].unsignedTxs.at(-1);
    readTx.mockResolvedValue({ to: expectedTx.to, data: expectedTx.data, value: expectedTx.value });
    const tres = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: "0x" + "aa".repeat(32) } });
    expect(tres.statusCode).toBe(400);
    expect(tres.json().code).toBe("rome.bridge.asset-not-supported");
  });
});
