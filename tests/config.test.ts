import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig, resolvePrimaryNetworks } from "../src/config";

describe("loadConfig", () => {
  beforeEach(() => {
    delete process.env.PORT;
    delete process.env.REDIS_URL;
    delete process.env.NODE_ENV;
    delete process.env.REGISTRY_PATH;
    delete process.env.PRIMARY_NETWORKS;
  });

  it("loads required env vars with defaults", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.REGISTRY_PATH = "/some/registry";
    const cfg = loadConfig();
    expect(cfg.port).toBe(3000);
    expect(cfg.redisUrl).toBe("redis://localhost:6379");
    expect(cfg.env).toBe("development");
    expect(cfg.registryPath).toBe("/some/registry");
  });

  it("throws on missing REDIS_URL", () => {
    process.env.REGISTRY_PATH = "/some/registry";
    expect(() => loadConfig()).toThrow(/REDIS_URL/);
  });

  it("throws on missing REGISTRY_PATH", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    expect(() => loadConfig()).toThrow(/REGISTRY_PATH/);
  });

  it("surfaces primaryNetworks (defaults to testnet+mainnet; PRIMARY_NETWORKS overrides)", () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    process.env.REGISTRY_PATH = "/some/registry";
    expect(loadConfig().primaryNetworks).toEqual(["testnet", "mainnet"]);
    process.env.PRIMARY_NETWORKS = "devnet,testnet,mainnet";
    expect(loadConfig().primaryNetworks).toEqual(["devnet", "testnet", "mainnet"]);
  });
});

describe("resolvePrimaryNetworks", () => {
  it("defaults to testnet+mainnet when unset", () => {
    expect(resolvePrimaryNetworks({})).toEqual(["testnet", "mainnet"]);
  });

  it("parses a custom comma list, trimming + lowercasing", () => {
    expect(resolvePrimaryNetworks({ PRIMARY_NETWORKS: " Devnet, testnet ,MAINNET " }))
      .toEqual(["devnet", "testnet", "mainnet"]);
  });

  it("falls back to the default on an empty value (never an empty scope)", () => {
    expect(resolvePrimaryNetworks({ PRIMARY_NETWORKS: "" })).toEqual(["testnet", "mainnet"]);
    expect(resolvePrimaryNetworks({ PRIMARY_NETWORKS: " , " })).toEqual(["testnet", "mainnet"]);
  });
});
