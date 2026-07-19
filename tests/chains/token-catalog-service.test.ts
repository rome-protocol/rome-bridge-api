import { describe, it, expect } from "vitest";
import { makeFactoryTokensFor } from "../../src/chains/token-catalog-service";
import type { ChainConfig } from "../../src/registry/types";

function fakeRedis(seed: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(seed));
  return { store: m, get: async (k: string) => m.get(k) ?? null, set: async (k: string, v: string) => { m.set(k, v); return "OK"; } };
}
function chain(over: Partial<ChainConfig> = {}): ChainConfig {
  return { chainId: "200010", name: "hadrian", status: "live", rpcUrl: "https://rome/rpc", ...over } as unknown as ChainConfig;
}

// factoryTokensFor now READS the set the background indexer populates in Redis
// (key `tokencat:factory:<chainId>`); it no longer scans getLogs on the request
// path (Rome caps eth_getLogs at 12k blocks — the indexer paginates off-path).
describe("makeFactoryTokensFor — reads the indexer-populated catalog", () => {
  const stored = [{ mint: "So11111111111111111111111111111111111111112", wrapper: "0xWsol", symbol: "wSOL" }];

  it("returns the stored factory set for the chain", async () => {
    const redis = fakeRedis({ "tokencat:factory:200010": JSON.stringify(stored) });
    const fn = makeFactoryTokensFor({ redis });
    expect(await fn(chain())).toEqual(stored);
  });

  it("returns [] when the indexer has not populated this chain yet", async () => {
    const fn = makeFactoryTokensFor({ redis: fakeRedis() });
    expect(await fn(chain())).toEqual([]);
  });

  it("returns [] when no redis is configured (registry-only)", async () => {
    const fn = makeFactoryTokensFor({});
    expect(await fn(chain())).toEqual([]);
  });
});
