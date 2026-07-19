import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { ChainInventory, InvalidProgramIdError } from "../../src/chains/inventory";
import { RegistryClient } from "../../src/registry/client";
import { OwnerInfoClient } from "../../src/chains/owner-info-reader";

const HADRIAN_PROGRAM    = "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf"; // testnet secondary
const TESTNET_PRIMARY    = "RomeTaTNPJNBxtB3Wong9geVTtkEFJfUqgktQVq3iSX";
const MAINNET_PRIMARY    = "RoMaiNxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; // synthetic for testing
const USDC_DEVNET_MINT   = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

let dir: string;

function seedRegistry(opts?: { mainnetPrimary?: string | null }) {
  dir = mkdtempSync(join(tmpdir(), "registry-inventory-"));

  const mainnetPrimary = opts?.mainnetPrimary ?? null;

  // programs/index.json
  mkdirSync(join(dir, "programs"), { recursive: true });
  const programs: Record<string, any> = {
    [TESTNET_PRIMARY]: { cluster: "devnet", network: "testnet",   role: "primary",   kind: "rome-evm", chainsHosted: ["200012-capitoline"] },
    [HADRIAN_PROGRAM]: { cluster: "devnet", network: "testnet",   role: "secondary", kind: "rome-evm", chainsHosted: ["200010-hadrian"] },
  };
  if (mainnetPrimary) {
    programs[mainnetPrimary] = { cluster: "mainnet-beta", network: "mainnet", role: "primary", kind: "rome-evm", chainsHosted: ["1-rome-mainnet"] };
  }
  writeFileSync(join(dir, "programs", "index.json"), JSON.stringify({
    schemaVersion: "1",
    primary: { devnet: null, testnet: TESTNET_PRIMARY, mainnet: mainnetPrimary, "real-testnet": null },
    programs,
  }));

  // chains/200010-hadrian/{chain,bridge}.json — Hadrian (testnet secondary)
  const hadrianDir = join(dir, "chains", "200010-hadrian");
  mkdirSync(hadrianDir, { recursive: true });
  writeFileSync(join(hadrianDir, "chain.json"), JSON.stringify({
    chainId: 200010, name: "Rome Hadrian", network: "testnet", status: "live",
    romeEvmProgramId: HADRIAN_PROGRAM,
    rpcUrl: "https://hadrian.testnet.romeprotocol.xyz/",
    nativeCurrency: { name: "Rome Hadrian", symbol: "USDC", decimals: 18 },
    solana: { cluster: "devnet" },
  }));
  writeFileSync(join(hadrianDir, "bridge.json"), JSON.stringify({
    sourceEvm: { chainId: 11155111, name: "Sepolia" },
    cctpIrisApiBase: "https://iris-api-sandbox.circle.com",
    assets: [
      { id: "usdc", symbol: "USDC", solanaMint: USDC_DEVNET_MINT, decimals: 6 },
    ],
  }));

  // chains/200012-capitoline/chain.json — Capitoline (testnet primary)
  const capitolineDir = join(dir, "chains", "200012-capitoline");
  mkdirSync(capitolineDir, { recursive: true });
  writeFileSync(join(capitolineDir, "chain.json"), JSON.stringify({
    chainId: 200012, name: "Rome Capitoline", network: "testnet", status: "live",
    romeEvmProgramId: TESTNET_PRIMARY,
    rpcUrl: "https://capitoline.testnet.romeprotocol.xyz/",
    nativeCurrency: { name: "Rome Capitoline", symbol: "USDC", decimals: 18 },
  }));
}

beforeEach(() => seedRegistry());

function mockOwnerInfo(entriesByProgram: Record<string, Array<{ chain: bigint; mint: string | null }>>) {
  const ownerInfo = {
    listEntries: vi.fn(async (programId: PublicKey) => {
      const entries = entriesByProgram[programId.toBase58()];
      if (!entries) return [];
      return entries.map((e) => ({
        chain: e.chain,
        mint: e.mint ? new PublicKey(e.mint) : null,
        slot: 0n,
        singleState: false,
      }));
    }),
    getMintForChain: vi.fn(),
  };
  return ownerInfo as unknown as OwnerInfoClient;
}

describe("ChainInventory — default scope = testnet + mainnet primaries", () => {
  it("listChains() with both primaries set walks both primary programs", async () => {
    seedRegistry({ mainnetPrimary: MAINNET_PRIMARY });
    const registry = new RegistryClient({ source: { kind: "local", path: dir } });
    const ownerInfo = mockOwnerInfo({
      [TESTNET_PRIMARY]: [{ chain: 200012n, mint: USDC_DEVNET_MINT }],
      [MAINNET_PRIMARY]: [{ chain: 1n,      mint: USDC_DEVNET_MINT }],
      [HADRIAN_PROGRAM]: [{ chain: 200010n, mint: USDC_DEVNET_MINT }],  // NOT in default scope (secondary)
    });
    const inv = new ChainInventory({ registry, ownerInfo });

    const chains = await inv.listChains();
    const ids = chains.map((c) => c.chainId).sort();
    expect(ids).toEqual(["1", "200012"]);  // Hadrian (200010) is excluded
  });

  it("listChains() returns only the testnet primary's chains when mainnet primary is null", async () => {
    const registry = new RegistryClient({ source: { kind: "local", path: dir } });
    const ownerInfo = mockOwnerInfo({
      [TESTNET_PRIMARY]: [{ chain: 200012n, mint: USDC_DEVNET_MINT }],
      [HADRIAN_PROGRAM]: [{ chain: 200010n, mint: USDC_DEVNET_MINT }],
    });
    const inv = new ChainInventory({ registry, ownerInfo });

    const chains = await inv.listChains();
    expect(chains.map((c) => c.chainId)).toEqual(["200012"]);
  });

  it("listChains() returns [] when neither testnet nor mainnet primary is set", async () => {
    // Synthesize a registry with neither primary
    dir = mkdtempSync(join(tmpdir(), "registry-empty-"));
    mkdirSync(join(dir, "programs"), { recursive: true });
    writeFileSync(join(dir, "programs", "index.json"), JSON.stringify({
      schemaVersion: "1",
      primary: { devnet: null, testnet: null, mainnet: null, "real-testnet": null },
      programs: {},
    }));
    const registry = new RegistryClient({ source: { kind: "local", path: dir } });
    const ownerInfo = mockOwnerInfo({});
    const inv = new ChainInventory({ registry, ownerInfo });

    expect(await inv.listChains()).toEqual([]);
  });

  it("getChainsByChainId() — found on testnet primary returns single match", async () => {
    const registry = new RegistryClient({ source: { kind: "local", path: dir } });
    const ownerInfo = mockOwnerInfo({
      [TESTNET_PRIMARY]: [{ chain: 200012n, mint: USDC_DEVNET_MINT }],
      [HADRIAN_PROGRAM]: [{ chain: 200010n, mint: USDC_DEVNET_MINT }],
    });
    const inv = new ChainInventory({ registry, ownerInfo });

    const matches = await inv.getChainsByChainId(200012n);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.programId).toBe(TESTNET_PRIMARY);
    expect(matches[0]!.network).toBe("testnet");
  });

  it("getChainsByChainId() — chain on a secondary program is NOT visible in default scope", async () => {
    const registry = new RegistryClient({ source: { kind: "local", path: dir } });
    const ownerInfo = mockOwnerInfo({
      [TESTNET_PRIMARY]: [],
      [HADRIAN_PROGRAM]: [{ chain: 200010n, mint: USDC_DEVNET_MINT }],
    });
    const inv = new ChainInventory({ registry, ownerInfo });

    // Hadrian (testnet secondary) hosts 200010 — but secondaries aren't in default scope.
    expect(await inv.getChainsByChainId(200010n)).toEqual([]);
  });

  it("getChainsByChainId() — same chainId on both testnet AND mainnet primary returns 2 matches (collision)", async () => {
    seedRegistry({ mainnetPrimary: MAINNET_PRIMARY });
    const registry = new RegistryClient({ source: { kind: "local", path: dir } });
    const ownerInfo = mockOwnerInfo({
      [TESTNET_PRIMARY]: [{ chain: 100n, mint: USDC_DEVNET_MINT }],
      [MAINNET_PRIMARY]: [{ chain: 100n, mint: USDC_DEVNET_MINT }],
    });
    const inv = new ChainInventory({ registry, ownerInfo });

    const matches = await inv.getChainsByChainId(100n);
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.network).sort()).toEqual(["mainnet", "testnet"]);
  });
});

describe("ChainInventory — { programId } override", () => {
  it("getChainsByChainId({ programId: <secondary> }) reaches programs outside the default scope", async () => {
    const registry = new RegistryClient({ source: { kind: "local", path: dir } });
    const ownerInfo = mockOwnerInfo({
      [TESTNET_PRIMARY]: [],
      [HADRIAN_PROGRAM]: [{ chain: 200010n, mint: USDC_DEVNET_MINT }],
    });
    const inv = new ChainInventory({ registry, ownerInfo });

    const matches = await inv.getChainsByChainId(200010n, { programId: HADRIAN_PROGRAM });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.programId).toBe(HADRIAN_PROGRAM);
    expect(matches[0]!.name).toBe("Rome Hadrian");
  });

  it("getChainsByChainId({ programId: <unknown> }) throws InvalidProgramIdError", async () => {
    const registry = new RegistryClient({ source: { kind: "local", path: dir } });
    const ownerInfo = mockOwnerInfo({});
    const inv = new ChainInventory({ registry, ownerInfo });

    await expect(inv.getChainsByChainId(200010n, { programId: "FAKE_NOT_IN_REGISTRY" }))
      .rejects.toThrow(InvalidProgramIdError);
  });

  it("getChainsByChainId({ programId: <known> }) returns [] when the program doesn't host the chainId", async () => {
    const registry = new RegistryClient({ source: { kind: "local", path: dir } });
    const ownerInfo = mockOwnerInfo({
      [HADRIAN_PROGRAM]: [{ chain: 200010n, mint: USDC_DEVNET_MINT }],
    });
    const inv = new ChainInventory({ registry, ownerInfo });

    expect(await inv.getChainsByChainId(999n, { programId: HADRIAN_PROGRAM })).toEqual([]);
  });

  it("listChains({ programId: <secondary> }) walks just that program", async () => {
    const registry = new RegistryClient({ source: { kind: "local", path: dir } });
    const ownerInfo = mockOwnerInfo({
      [TESTNET_PRIMARY]: [{ chain: 200012n, mint: USDC_DEVNET_MINT }],
      [HADRIAN_PROGRAM]: [{ chain: 200010n, mint: USDC_DEVNET_MINT }],
    });
    const inv = new ChainInventory({ registry, ownerInfo });

    const chains = await inv.listChains({ programId: HADRIAN_PROGRAM });
    expect(chains.map((c) => c.chainId)).toEqual(["200010"]);
  });

  it("listChains({ programId: <unknown> }) throws InvalidProgramIdError", async () => {
    const registry = new RegistryClient({ source: { kind: "local", path: dir } });
    const ownerInfo = mockOwnerInfo({});
    const inv = new ChainInventory({ registry, ownerInfo });

    await expect(inv.listChains({ programId: "NOT_IN_REGISTRY" }))
      .rejects.toThrow(InvalidProgramIdError);
  });
});

describe("ChainInventory — registry enrichment", () => {
  it("merges on-chain OwnerInfo with registry chain.json + bridge.json for primary-hosted chains", async () => {
    const registry = new RegistryClient({ source: { kind: "local", path: dir } });
    const ownerInfo = mockOwnerInfo({
      [TESTNET_PRIMARY]: [{ chain: 200012n, mint: USDC_DEVNET_MINT }],
    });
    const inv = new ChainInventory({ registry, ownerInfo });

    const matches = await inv.getChainsByChainId(200012n);
    expect(matches).toHaveLength(1);
    const detail = matches[0]!;
    expect(detail.name).toBe("Rome Capitoline");
    expect(detail.rpcUrl).toBe("https://capitoline.testnet.romeprotocol.xyz/");
    expect(detail.network).toBe("testnet");
    expect(detail.hasRegistryEntry).toBe(true);
  });

  it("returns on-chain-only minimal view if registry chain.json is missing (drift case)", async () => {
    const registry = new RegistryClient({ source: { kind: "local", path: dir } });
    const ownerInfo = mockOwnerInfo({
      [TESTNET_PRIMARY]: [{ chain: 555555n, mint: USDC_DEVNET_MINT }],
    });
    const inv = new ChainInventory({ registry, ownerInfo });

    const matches = await inv.getChainsByChainId(555555n);
    expect(matches).toHaveLength(1);
    const detail = matches[0]!;
    expect(detail.chainId).toBe("555555");
    expect(detail.programId).toBe(TESTNET_PRIMARY);
    expect(detail.hasRegistryEntry).toBe(false);
    expect(detail.name).toBeNull();
  });
});
