import { describe, it, expect, vi } from "vitest";
import { makeFactoryIndexer } from "../../src/chains/token-factory-indexer";
import type { ChainConfig } from "../../src/registry/types";

const SOL_B32 = "0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001";
const ETH_B32 = "0x4de5b3fa1e6c00708f7ff480e2186357da3bc7110c576e9364da84c4c77ad904";
const SOL58 = "So11111111111111111111111111111111111111112";
const ETH58 = "6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs";

function fakeRedis() {
  const m = new Map<string, string>();
  return {
    store: m,
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => { m.set(k, v); return "OK"; },
  };
}

function hadrian(over: Partial<ChainConfig> = {}): ChainConfig {
  return {
    chainId: "200010", name: "hadrian", status: "live", rpcUrl: "https://rome/rpc",
    contracts: [{ name: "ERC20SPLFactory", versions: [{ address: "0xFactory", status: "live" }] }],
    ...over,
  } as unknown as ChainConfig;
}

// Fake Rome chain source: blocks exist at/above `anchor`; `latest` is the tip;
// getLogs returns the TokenCreated events whose block falls in the query window.
function source(opts: {
  anchor: bigint; latest: bigint;
  events?: Array<{ blk: bigint; mint: string; wrapper: string }>;
  onGetLogs?: (from: bigint, to: bigint) => void;
}) {
  const events = opts.events ?? [];
  return {
    getBlockNumber: async () => opts.latest,
    blockExists: async (n: bigint) => n >= opts.anchor,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      opts.onGetLogs?.(fromBlock, toBlock);
      return events.filter((e) => e.blk >= fromBlock && e.blk <= toBlock).map((e) => ({ args: { mint: e.mint, wrapper: e.wrapper } }));
    },
  };
}

describe("makeFactoryIndexer — incremental TokenCreated indexer", () => {
  it("cold backfill: scans anchor→latest, stores tokens, sets cursor + anchor", async () => {
    const redis = fakeRedis();
    const src = source({ anchor: 100n, latest: 150n, events: [{ blk: 120n, mint: SOL_B32, wrapper: "0xWsol" }] });
    const idx = makeFactoryIndexer({ redis, listChains: async () => [hadrian()], sourceFor: () => src, windowSize: 1000n });
    await idx.runOnce();
    expect(JSON.parse(redis.store.get("tokencat:factory:200010")!)).toEqual([{ mint: SOL58, wrapper: "0xWsol" }]);
    expect(redis.store.get("tokencat:factory:200010:cursor")).toBe("150");
    expect(redis.store.get("tokencat:factory:200010:anchor")).toBe("100");
  });

  it("incremental: scans only cursor+1→latest, merges new, dedups existing by wrapper", async () => {
    const redis = fakeRedis();
    redis.store.set("tokencat:factory:200010", JSON.stringify([{ mint: SOL58, wrapper: "0xWsol" }]));
    redis.store.set("tokencat:factory:200010:cursor", "150");
    redis.store.set("tokencat:factory:200010:anchor", "100");
    let firstFrom: bigint | undefined;
    const src = source({
      anchor: 100n, latest: 170n,
      events: [{ blk: 160n, mint: ETH_B32, wrapper: "0xWeth" }, { blk: 161n, mint: SOL_B32, wrapper: "0xWsol" }],
      onGetLogs: (f) => { if (firstFrom === undefined) firstFrom = f; },
    });
    const idx = makeFactoryIndexer({ redis, listChains: async () => [hadrian()], sourceFor: () => src, windowSize: 1000n });
    await idx.runOnce();
    expect(firstFrom).toBe(151n); // resumed from cursor+1, not the anchor
    const set = JSON.parse(redis.store.get("tokencat:factory:200010")!) as Array<{ wrapper: string }>;
    expect(set.map((t) => t.wrapper).sort()).toEqual(["0xWeth", "0xWsol"]); // wSOL deduped, wETH added
    expect(redis.store.get("tokencat:factory:200010:cursor")).toBe("170");
  });

  it("caches the anchor — the binary search runs once, not every tick", async () => {
    let probes = 0;
    const src = {
      getBlockNumber: async () => 150n,
      blockExists: async (n: bigint) => { probes++; return n >= 100n; },
      getLogs: async () => [],
    };
    const redis = fakeRedis();
    const idx = makeFactoryIndexer({ redis, listChains: async () => [hadrian()], sourceFor: () => src });
    await idx.runOnce();
    const after = probes;
    await idx.runOnce();
    expect(after).toBeGreaterThan(0);
    expect(probes).toBe(after); // second run reused the cached anchor
  });

  it("isolates per-chain failures — one chain's RPC error doesn't abort the others", async () => {
    const redis = fakeRedis();
    const warn = vi.fn();
    const idx = makeFactoryIndexer({
      redis, warn,
      listChains: async () => [hadrian({ chainId: "999", rpcUrl: "bad" }), hadrian()],
      sourceFor: (rpc: string) => rpc === "bad"
        ? { getBlockNumber: async () => { throw new Error("rpc down"); }, blockExists: async () => false, getLogs: async () => [] }
        : source({ anchor: 100n, latest: 150n, events: [{ blk: 120n, mint: SOL_B32, wrapper: "0xWsol" }] }),
    });
    await idx.runOnce();
    expect(warn).toHaveBeenCalled();
    expect(redis.store.has("tokencat:factory:200010")).toBe(true);  // good chain indexed
    expect(redis.store.has("tokencat:factory:999")).toBe(false);    // bad chain wrote nothing
  });

  it("skips a chain with no factory or no rpc (registry-only), no crash", async () => {
    const redis = fakeRedis();
    const idx = makeFactoryIndexer({
      redis,
      listChains: async () => [hadrian({ contracts: [] }), hadrian({ chainId: "2", rpcUrl: undefined })],
      sourceFor: () => source({ anchor: 100n, latest: 150n }),
    });
    await idx.runOnce();
    expect(redis.store.size).toBe(0);
  });

  it("getTokens reads the stored set; [] when absent", async () => {
    const redis = fakeRedis();
    redis.store.set("tokencat:factory:200010", JSON.stringify([{ mint: SOL58, wrapper: "0xWsol" }]));
    const idx = makeFactoryIndexer({ redis, listChains: async () => [], sourceFor: () => source({ anchor: 100n, latest: 150n }) });
    expect(await idx.getTokens("200010")).toEqual([{ mint: SOL58, wrapper: "0xWsol" }]);
    expect(await idx.getTokens("404")).toEqual([]);
  });
});
