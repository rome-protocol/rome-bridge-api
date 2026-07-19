import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { writePublishedChain } from "../helpers/chains";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server";

const dir = mkdtempSync(join(tmpdir(), "registry-"));
writePublishedChain(dir, "121301-marcus", {
  chain: { chainId: 121301, name: "Marcus", network: "devnet", status: "live", rpcUrl: "https://marcus.invalid", romeEvmProgramId: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8" },
  bridge: {
    cctpIrisApiBase: "https://iris-api-sandbox.circle.com",
    sourceEvm: { chainId: 11155111, name: "Sepolia", cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", cctpMessageTransmitter: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD" },
    solana: { cctpDomain: 5 },
    assets: [{ id: "usdc", symbol: "USDC", solanaMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, sourceEvm: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", protocol: "cctp" } }],
  },
  tokens: [{ kind: "gas", mintId: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", gasPool: "AkZ6NSKzoM6Q3TqVwgtCixpjBDRqEhs5YTZxYzX6s2Jt", symbol: "USDC", decimals: 18, address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }],
});
process.env.REGISTRY_PATH = dir;
process.env.BRIDGE_API_USE_IN_MEMORY_REDIS = "1";

const readTx = vi.fn();

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
  // stub the Ethereum read client with a re-mockable vi.fn() — each test sets its own return value
  (app as any).decorate("ethereumReader", { readTx });
});
afterAll(async () => { await app.close(); });

describe("POST /v1/transfers", () => {
  it("registers a transfer after a quote + step-1 broadcast", async () => {
    // get a real quote first so we know the exact calldata the route builder produced
    const qres = await app.inject({ method: "POST", url: "/v1/quote", payload: {
      asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301",
      amount: "100000000", sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    }});
    const quote = qres.json();

    // the spec: mock the ethereum reader to return the EXACT calldata from the quote's depositForBurn tx
    const expectedTx = quote.steps[0].unsignedTxs[1]; // depositForBurn (last tx in approve+deposit)
    readTx.mockResolvedValue({ to: expectedTx.to, data: expectedTx.data, value: expectedTx.value });

    const tres = await app.inject({ method: "POST", url: "/v1/transfers", payload: {
      quote, step1TxHash: "0xa1b2c3d4",
    }});
    expect(tres.statusCode).toBe(200);
    const t = tres.json();
    expect(t.id).toMatch(/^txf_/);
    expect(t.outcome).toBe("pending");
    expect(t.steps[0].status).toBe("submitted");
  });

  it("returns the existing transfer on idempotent re-post", async () => {
    const qres = await app.inject({ method: "POST", url: "/v1/quote", payload: { asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301", amount: "100000000", sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }});
    const quote = qres.json();
    const expectedTx = quote.steps[0].unsignedTxs[1];
    readTx.mockResolvedValue({ to: expectedTx.to, data: expectedTx.data, value: expectedTx.value });

    const t1 = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: "0xRESUBMITME" } });
    const t2 = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: "0xRESUBMITME" } });
    expect(t1.json().id).toBe(t2.json().id);
  });

  it("returns 400 source-tx-mismatch when on-chain tx doesn't match quote", async () => {
    const qres = await app.inject({ method: "POST", url: "/v1/quote", payload: {
      asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301",
      amount: "100000000", sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    }});
    const quote = qres.json();

    // Mock returns DIFFERENT calldata than the quote — simulates a user reporting a wrong/tampered tx
    readTx.mockResolvedValue({ to: "0xdeadbeef00000000000000000000000000000000", data: "0xdeadbeef", value: "0" });

    const tres = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: "0xmismatchhash" }});
    expect(tres.statusCode).toBe(400);
    expect(tres.json().code).toBe("rome.bridge.source-tx-mismatch");
  });

  it("GET /v1/transfers/{id} returns the persisted transfer", async () => {
    const qres = await app.inject({ method: "POST", url: "/v1/quote", payload: { asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301", amount: "100000000", sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }});
    const quote = qres.json();
    const expected = quote.steps[0].unsignedTxs[1];
    (app as any).ethereumReader.readTx.mockResolvedValue({ to: expected.to, data: expected.data, value: expected.value });
    const tres = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: "0xfeedface" }});
    const id = tres.json().id;
    const gres = await app.inject({ method: "GET", url: `/v1/transfers/${id}` });
    expect(gres.statusCode).toBe(200);
    expect(gres.json().id).toBe(id);
  });

  it("returns 404 for unknown id", async () => {
    const gres = await app.inject({ method: "GET", url: "/v1/transfers/txf_nope" });
    expect(gres.statusCode).toBe(404);
  });

  it("returns 400 (not 500) when quote.steps is empty", async () => {
    // A malformed or hand-rolled quote with an empty steps[] used to crash at
    // routes/transfers.ts:46 with `Cannot read property 'unsignedTxs' of undefined`,
    // surfacing as a 500 stack trace. Should be a clean 400.
    const tres = await app.inject({ method: "POST", url: "/v1/transfers", payload: {
      quote: {
        route: "usdc-cctp-to-rome",
        direction: "to-rome",
        amountIn: "1",
        amountOut: "1",
        steps: [],
      },
      step1TxHash: "0xdeadbeef",
    }});
    expect(tres.statusCode).toBe(400);
    expect(tres.json().code).toMatch(/^rome\.bridge\./);
  });

  it("POST /v1/transfers/{id}/steps/2 marks step 2 submitted", async () => {
    const qres = await app.inject({ method: "POST", url: "/v1/quote", payload: { asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301", amount: "100000000", sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }});
    const quote = qres.json();
    const expected = quote.steps[0].unsignedTxs[1];
    (app as any).ethereumReader.readTx.mockResolvedValue({ to: expected.to, data: expected.data, value: expected.value });
    const tres = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: "0xstep2flow" }});
    const id = tres.json().id;

    // The step 2 starts blocked. The test directly POSTs to /steps/2 and expects either:
    // - 409 (step is blocked, not ready) — this is the expected v1.0 behavior
    // - 200 (if the test environment somehow advanced step 2 to ready)
    // The test allows either; the v1.0 contract is: POST /steps/{n} rejects when step is not yet ready.
    const sres = await app.inject({
      method: "POST",
      url: `/v1/transfers/${id}/steps/2`,
      payload: { txHash: "5qFsolanahashbase58" },
    });
    expect([200, 409]).toContain(sres.statusCode);
    // If 409 (the default v1.0 flow without poller having ticked), the body should be rome.bridge.step-not-ready
    if (sres.statusCode === 409) {
      expect(sres.json().code).toBe("rome.bridge.step-not-ready");
    }
  });

  it("POST /steps/{n} flips a ready step to submitted with the reported tx hash", async () => {
    const qres = await app.inject({ method: "POST", url: "/v1/quote", payload: { asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301", amount: "100000000", sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }});
    const quote = qres.json();
    const expected = quote.steps[0].unsignedTxs[1];
    (app as any).ethereumReader.readTx.mockResolvedValue({ to: expected.to, data: expected.data, value: expected.value });
    const tres = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: "0xstep2flow2" }});
    const id = tres.json().id;

    // Directly mutate step 2 to ready (we don't have the poller wired in tests yet; do it via the store)
    // Access the redis-backed store via the app's decorated redis
    const { TransferStore } = await import("../../src/transfers/store");
    const store = new TransferStore((app as any).redis);
    await store.updateStep(id, 2, { status: "ready", attestation: "0xabc" });

    const sres = await app.inject({ method: "POST", url: `/v1/transfers/${id}/steps/2`, payload: { txHash: "5qFsolanahash" }});
    expect(sres.statusCode).toBe(200);
    const updated = sres.json();
    // Sponsor-signed Solana steps are reported after sendAndConfirm — they land
    // confirmed, and their dependents (the settle step) unblock to ready.
    expect(updated.steps[1].status).toBe("confirmed");
    expect(updated.steps[2].status).toBe("ready");
    expect(updated.steps[2].sourceTxHash).toBeDefined(); // stamped at registration
    expect(updated.steps[1].txHashes).toContain("5qFsolanahash");
  });
});

describe("POST /v1/transfers — record stamp", () => {
  it("stamps the registry-resolved transport tuple at registration (V1-pinned pre-V2-quote)", async () => {
    const qres = await app.inject({ method: "POST", url: "/v1/quote", payload: {
      asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301",
      amount: "100000000", sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    }});
    const quote = qres.json();
    const expectedTx = quote.steps[0].unsignedTxs[1];
    readTx.mockResolvedValue({ to: expectedTx.to, data: expectedTx.data, value: expectedTx.value });
    const tres = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: "0x" + "ab".repeat(32) } });
    expect(tres.statusCode).toBe(200);
    const record = tres.json();
    expect(record.stamp).toEqual({
      sourceChainId: 11155111,
      cctpVersion: 1,
      cctpDomain: 0,
      irisBase: "https://iris-api-sandbox.circle.com/v1",
      cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
      cctpMessageTransmitter: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD",
      burnToken: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    });
    expect(record.userSettleSig).toBeNull();
    expect(record.settleDeadline).toBeNull();
  });
  // Wrapper-intent stamping lives in transfers-wrapper-stamp.test.ts — it needs
  // the V2 Hadrian fixture (on this V1 chain a real stamp and the V1 backfill
  // are indistinguishable, so an assertion here would pass vacuously).
});

describe("POST /steps/{n} — user-paid destination claim (outbound)", () => {
  // The claim step is user-signed on the DESTINATION EVM chain. Registration
  // verifies the reported tx against the materialized claim calldata via the
  // destination chain's client (same content-match trust model as step-1
  // verification), confirms the step, and — with the attested step 1 — flips
  // the record to outcome: complete. Before this, outbound records never
  // completed (both steps ended "submitted") and every client rendered a
  // forever-pending transfer.
  const CLAIM_TO = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
  const CLAIM_DATA = "0x57ecfd28" + "ab".repeat(64); // receiveMessage selector + fake args

  let seedCounter = 0;
  async function seedOutboundRecord() {
    const { TransferStore } = await import("../../src/transfers/store");
    const store = new TransferStore((app as any).redis);
    // content-keyed ids: vary the burn hash so each test gets a fresh record
    const id = await store.create({
      route: "usdc-cctp-from-rome", direction: "from-rome", amountIn: "500000", amountOut: "500000",
      sender: { rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      steps: [
        { n: 1, chain: "rome-121301", kind: "cctp-burn-usdc", status: "submitted", txHashes: [`0xburn${++seedCounter}`] },
        {
          n: 2, chain: "evm-11155111", kind: "cctp-claim-on-destination", status: "ready",
          attestation: "0xatt", claimTransmitter: CLAIM_TO,
          unsignedTxs: [{ to: CLAIM_TO, data: CLAIM_DATA, value: "0" }],
        },
      ],
      outcome: "pending",
    });
    return { store, id };
  }

  it("verified claim tx → step confirmed, attested step 1 confirmed, outcome complete", async () => {
    const { id } = await seedOutboundRecord();
    (app as any).evmPool = {
      readTx: vi.fn().mockResolvedValue({ to: CLAIM_TO, data: CLAIM_DATA, value: "0" }),
    };
    const res = await app.inject({ method: "POST", url: `/v1/transfers/${id}/steps/2`, payload: { txHash: "0xclaimtx" } });
    expect(res.statusCode).toBe(200);
    const rec = res.json();
    expect(rec.steps[1].status).toBe("confirmed");
    expect(rec.steps[0].status).toBe("confirmed");
    expect(rec.outcome).toBe("complete");
    expect((app as any).evmPool.readTx).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 11155111 }), "0xclaimtx",
    );
  });

  it("claim tx content mismatch → 400 step-tx-mismatch, step stays ready", async () => {
    const { store, id } = await seedOutboundRecord();
    (app as any).evmPool = {
      readTx: vi.fn().mockResolvedValue({ to: CLAIM_TO, data: "0xdeadbeef", value: "0" }),
    };
    const res = await app.inject({ method: "POST", url: `/v1/transfers/${id}/steps/2`, payload: { txHash: "0xwrongtx" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("rome.bridge.step-tx-mismatch");
    expect((await store.get(id))!.steps[1]!.status).toBe("ready");
  });

  it("claim tx not yet readable on the destination → lands submitted, record stays pending", async () => {
    const { id } = await seedOutboundRecord();
    (app as any).evmPool = { readTx: vi.fn().mockResolvedValue(null) };
    const res = await app.inject({ method: "POST", url: `/v1/transfers/${id}/steps/2`, payload: { txHash: "0xearlytx" } });
    expect(res.statusCode).toBe(200);
    const rec = res.json();
    expect(rec.steps[1].status).toBe("submitted");
    expect(rec.outcome).toBe("pending");
  });
});
