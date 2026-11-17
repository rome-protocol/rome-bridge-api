import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server";
import { writePublishedChain } from "../helpers/chains";

const dir = mkdtempSync(join(tmpdir(), "reg-tokens-"));
writePublishedChain(dir, "200010-hadrian", {
  chain: { chainId: 200010, name: "hadrian", network: "devnet", status: "live", rpcUrl: "https://hadrian.invalid" },
  tokens: [
    { kind: "spl_wrapper", symbol: "wETH", decimals: 8, mintId: "MINT_ETH", address: "0xweth" },
    { kind: "gas", symbol: "USDC", decimals: 18, mintId: "MINT_USDC", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
    // the legacy SOL wrapper comes before the current one in the file, as in Hadrian's H14 tokens.json
    { kind: "spl_wrapper", symbol: "SOL", decimals: 9, mintId: "MINT_SOL", address: "0xlegacysol", legacy: { replacedBy: "0xcurrentsol", note: "SOL (legacy)" } },
    { kind: "spl_wrapper", symbol: "SOL", decimals: 9, mintId: "MINT_SOL", address: "0xcurrentsol" },
    { kind: "spl_wrapper", symbol: "wSOL", decimals: 9, mintId: "MINT_SOL", address: "0xoldsol", legacy: { replacedBy: "0xlegacysol", note: "Rome SOL (legacy)" } },
  ],
});

const app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
// buildApp skips factoryTokensFor in test env → inject a mock (the on-chain long-tail).
app.decorate("factoryTokensFor", async () => [{ mint: "MINT_BSOL", wrapper: "0xbsol", symbol: "bSOL" }]);
afterAll(async () => { await app.close(); });

describe("GET /v1/tokens", () => {
  it("merges registry (verified) + factory (long-tail), mint-keyed; excludes gas", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/tokens?chainId=200010" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chainId).toBe("200010");
    const byMint: Record<string, { verified: boolean; symbol?: string; wrappers: string[] }> =
      Object.fromEntries(body.tokens.map((t: { mint: string }) => [t.mint, t]));
    expect(byMint.MINT_ETH).toMatchObject({ verified: true, symbol: "wETH", wrappers: ["0xweth"] });
    expect(byMint.MINT_BSOL).toMatchObject({ verified: false, symbol: "bSOL", wrappers: ["0xbsol"] });
    expect(byMint.MINT_USDC).toBeUndefined(); // gas kind is native, not a catalog wrapper
    // verified entries sort first, the factory long-tail last
    expect(body.tokens.map((t: { verified: boolean }) => t.verified)).toEqual([true, true, false]);
    expect(body.tokens[2].mint).toBe("MINT_BSOL");
  });

  it("lists the current SOL wrapper first and under its own symbol, the legacy ones after it", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/tokens?chainId=200010" });
    const sol = res.json().tokens.find((t: { mint: string }) => t.mint === "MINT_SOL");
    expect(sol).toMatchObject({ verified: true, symbol: "SOL", wrappers: ["0xcurrentsol", "0xlegacysol", "0xoldsol"] });
  });

  it("400s without chainId and for an unknown chain", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/tokens" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/tokens?chainId=999999" })).statusCode).toBe(400);
  });
});
