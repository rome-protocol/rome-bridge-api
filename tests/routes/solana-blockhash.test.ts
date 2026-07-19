import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server";

// A browser client that can't reach a Solana RPC directly fetches a fresh
// blockhash here, sets it on the deposit tx, and hands the tx to its wallet
// to sign and submit over the wallet's own connection. This endpoint is a
// pure read — no keys, no signing.

const dir = mkdtempSync(join(tmpdir(), "registry-"));
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
  // Tests inject the Solana connection the same way they inject ethereumReader
  // / chainInventory — buildApp only wires the real one when solanaRpcUrl is set.
  (app as unknown as { decorate: (k: string, v: unknown) => void }).decorate("solanaConnection", {
    getLatestBlockhash: async () => ({ blockhash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", lastValidBlockHeight: 285601234 }),
  });
});

afterAll(async () => { await app.close(); });

describe("GET /v1/solana/latest-blockhash", () => {
  it("returns a fresh blockhash + lastValidBlockHeight from the Solana connection", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/solana/latest-blockhash" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.blockhash).toBe("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
    expect(body.lastValidBlockHeight).toBe(285601234);
  });

  it("503s cleanly when the deployment has no Solana RPC configured", async () => {
    const bare = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
    const res = await bare.inject({ method: "GET", url: "/v1/solana/latest-blockhash" });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("rome.bridge.upstream-unavailable");
    await bare.close();
  });
});
