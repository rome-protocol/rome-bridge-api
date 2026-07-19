import { describe, it, expect, afterAll } from "vitest";
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

const app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
afterAll(async () => { await app.close(); });

describe("GET /metrics", () => {
  it("exposes prom-formatted metrics including http request counters", async () => {
    // Make a request to populate metrics
    await app.inject({ method: "GET", url: "/v1/health" });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toContain("rome_bridge_api_http_requests_total");
  });

  it("increments bridge error counter on rome.bridge.* code response", async () => {
    // Make a quote request that should fail with rome.bridge.sender-incomplete
    await app.inject({ method: "POST", url: "/v1/quote", payload: { asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301", amount: "100000000", sender: {}, recipient: "0xabc" }});
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain('rome.bridge.sender-incomplete');
  });
});
