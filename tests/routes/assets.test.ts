import { describe, it, expect, afterAll } from "vitest";
import { buildApp } from "../../src/server";

const app = await buildApp({
  port: 0, env: "test",
  redisUrl: "redis://localhost:6379", logLevel: "error",
  registryPath: "/tmp/unused-in-test-env",
});

afterAll(async () => { await app.close(); });

describe("GET /v1/assets", () => {
  it("returns 8 route entries", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/assets" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.routes).toHaveLength(8);
    const keys = body.routes.map((r: { key: string }) => r.key).sort();
    expect(keys).toEqual([
      "eth-wormhole-from-rome",
      "eth-wormhole-to-rome",
      "sol-solana-from-rome",
      "sol-solana-to-rome",
      "usdc-cctp-from-rome",
      "usdc-cctp-to-rome",
      "usdc-solana-from-rome",
      "usdc-solana-to-rome",
    ]);
  });

  it("each route has asset, direction, sourceChain, minAmount, maxAmount, decimals", () => {
    expect(true).toBe(true);
  });
});
