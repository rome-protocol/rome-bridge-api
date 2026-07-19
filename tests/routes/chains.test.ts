import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server";

const dir = mkdtempSync(join(tmpdir(), "registry-"));
const chainDir = join(dir, "chains", "121301-marcus");
mkdirSync(chainDir, { recursive: true });
writeFileSync(join(chainDir, "chain.json"), JSON.stringify({
  chainId: "121301", slug: "marcus", network: "devnet", status: "live",
  bridge: { sourceEvm: { chainId: 11155111 }, gasMint: { address: "EPjFW...", symbol: "USDC", decimals: 6 } },
}));
process.env.REGISTRY_PATH = dir;

const app = await buildApp({
  port: 0, env: "test",
  redisUrl: "redis://localhost:6379", logLevel: "error",
  registryPath: dir,
});

afterAll(async () => { await app.close(); });

describe("GET /v1/chains", () => {
  it("lists chains with status: live", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/chains" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chains).toHaveLength(1);
    expect(body.chains[0].chainId).toBe("121301");
  });
});
