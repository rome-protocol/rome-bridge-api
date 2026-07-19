import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryClient } from "../../src/registry/client";
import { writePublishedChain } from "../helpers/chains";

let dir: string;

function writeChain(chainId: string, body: object) {
  const chainDir = join(dir, "chains", `${chainId}-test`);
  mkdirSync(chainDir, { recursive: true });
  writeFileSync(join(chainDir, "chain.json"), JSON.stringify(body, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "registry-"));
});

describe("RegistryClient.listChains — published per-chain triad", () => {
  it("filters to live chains and merges bridge.json + tokens.json into the config", async () => {
    writePublishedChain(dir, "121301-test", {
      chain: { chainId: 121301, name: "Marcus", status: "live", romeEvmProgramId: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8" },
      bridge: { sourceEvm: { chainId: 11155111, name: "Sepolia", cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5" }, solana: { cctpDomain: 5 }, assets: [] },
      tokens: [{ kind: "gas", mintId: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", gasPool: "AkZ6NSKzoM6Q3TqVwgtCixpjBDRqEhs5YTZxYzX6s2Jt" }],
    });
    writePublishedChain(dir, "999-test", { chain: { chainId: 999, name: "Old", status: "retired" } });
    const client = new RegistryClient({ source: { kind: "local", path: dir } });
    const chains = await client.listChains();
    expect(chains).toHaveLength(1);
    expect(chains[0]?.chainId).toBe("121301");
    expect(chains[0]?.slug).toBe("121301-test");
    expect(chains[0]?.romeEvmProgramId).toBe("romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8");
    expect(chains[0]?.bridge?.sourceEvm?.cctpTokenMessenger).toBe("0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5");
    expect(chains[0]?.gasToken?.mintId).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  });

  it("a chain missing bridge.json/tokens.json still lists (fields stay undefined)", async () => {
    writePublishedChain(dir, "121302-test", { chain: { chainId: 121302, name: "Bare", status: "live" } });
    const chains = await new RegistryClient({ source: { kind: "local", path: dir } }).listChains();
    expect(chains).toHaveLength(1);
    expect(chains[0]?.bridge).toBeUndefined();
    expect(chains[0]?.gasToken).toBeUndefined();
  });

  it("skips malformed or future-shaped chains with a warning instead of throwing the endpoint down", async () => {
    writeChain("121301", { not: "valid" });
    writePublishedChain(dir, "121303-test", { chain: { chainId: 121303, name: "Good", status: "live" } });
    const warnings: string[] = [];
    const client = new RegistryClient({ source: { kind: "local", path: dir }, warn: (m) => warnings.push(m) });
    const chains = await client.listChains();
    expect(chains).toHaveLength(1);
    expect(chains[0]?.chainId).toBe("121303");
    expect(warnings.some((w) => w.includes("121301-test"))).toBe(true);
  });

  it("skips unknown status values silently (future registry statuses must not break listing)", async () => {
    writeChain("777", { chainId: 777, name: "Prep", status: "preparing" });
    const chains = await new RegistryClient({ source: { kind: "local", path: dir } }).listChains();
    expect(chains).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// github source — closes the v1.0 "throw 'github source not implemented'"
// stubs at src/registry/client.ts:17, 26, 85, 100. Lets self-hosting
// operators consume the registry directly from raw.githubusercontent.com
// (works for private repos with an auth token, public repos without).
// ─────────────────────────────────────────────────────────────────────

describe("RegistryClient.listChains — github source", () => {
  it("returns chains by listing chains/ via GitHub API and fetching each chain.json via raw.githubusercontent.com", async () => {
    const fetchMock = (url: string, init?: { headers?: Record<string, string> }) => {
      const u = String(url);
      if (u === "https://api.github.com/repos/rome-protocol/rome-registry/contents/chains?ref=v0.12.0") {
        expect(init?.headers?.Authorization).toBe("Bearer ghs_FAKETOKEN");
        return Promise.resolve(new Response(JSON.stringify([
          { name: "121301-marcus",  type: "dir" },
          { name: "200010-hadrian", type: "dir" },
          { name: "README.md",      type: "file" },
        ]), { status: 200, headers: { "content-type": "application/json" } }));
      }
      if (u === "https://raw.githubusercontent.com/rome-protocol/rome-registry/v0.12.0/chains/121301-marcus/chain.json") {
        expect(init?.headers?.Authorization).toBe("Bearer ghs_FAKETOKEN");
        return Promise.resolve(new Response(JSON.stringify({
          chainId: "121301", slug: "marcus", network: "devnet", status: "live",
          bridge: { sourceEvm: { chainId: 11155111 }, gasMint: { address: "EPjFW...", symbol: "USDC", decimals: 6 } },
        }), { status: 200 }));
      }
      if (u === "https://raw.githubusercontent.com/rome-protocol/rome-registry/v0.12.0/chains/200010-hadrian/chain.json") {
        return Promise.resolve(new Response(JSON.stringify({
          chainId: "200010", slug: "hadrian", network: "testnet", status: "retired",
          bridge: { sourceEvm: { chainId: 11155111 }, gasMint: { address: "...", symbol: "X", decimals: 6 } },
        }), { status: 200 }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    };
    const client = new RegistryClient({
      source: { kind: "github", ref: "v0.12.0", authToken: "ghs_FAKETOKEN" },
      fetch: fetchMock as any,
    });
    const chains = await client.listChains();
    expect(chains).toHaveLength(1);
    expect(chains[0]?.chainId).toBe("121301");
  });
});

describe("RegistryClient.getProgramsIndex — github source", () => {
  it("fetches programs/index.json via raw.githubusercontent.com with Authorization header", async () => {
    const fetchMock = (url: string, init?: { headers?: Record<string, string> }) => {
      expect(String(url)).toBe(
        "https://raw.githubusercontent.com/rome-protocol/rome-registry/main/programs/index.json",
      );
      expect(init?.headers?.Authorization).toBe("Bearer ghs_PROGTOKEN");
      return Promise.resolve(new Response(JSON.stringify({
        schemaVersion: "1",
        programs: {
          "RomeTaTNPJNBxtB3Wong9geVTtkEFJfUqgktQVq3iSX": {
            cluster: "devnet", network: "testnet", role: "primary", kind: "rome-evm", chainsHosted: [],
          },
        },
        primary: { testnet: "RomeTaTNPJNBxtB3Wong9geVTtkEFJfUqgktQVq3iSX", mainnet: null, devnet: null, "real-testnet": null },
      }), { status: 200 }));
    };
    const client = new RegistryClient({
      source: { kind: "github", ref: "main", authToken: "ghs_PROGTOKEN" },
      fetch: fetchMock as any,
    });
    const idx = await client.getProgramsIndex();
    expect(idx.primary.testnet).toBe("RomeTaTNPJNBxtB3Wong9geVTtkEFJfUqgktQVq3iSX");
  });

  it("returns null from getChainJson when raw.githubusercontent.com returns 404", async () => {
    const fetchMock = () => Promise.resolve(new Response("", { status: 404 }));
    const client = new RegistryClient({
      source: { kind: "github", ref: "main" },
      fetch: fetchMock as any,
    });
    expect(await client.getChainJson("9999999-nonexistent")).toBeNull();
  });

  it("works without an authToken (public-repo fallback shape)", async () => {
    const fetchMock = (url: string, init?: { headers?: Record<string, string> }) => {
      expect(init?.headers?.Authorization).toBeUndefined();
      return Promise.resolve(new Response(JSON.stringify({
        schemaVersion: "1",
        programs: {}, primary: { testnet: null, mainnet: null, devnet: null, "real-testnet": null },
      }), { status: 200 }));
    };
    const client = new RegistryClient({
      source: { kind: "github", ref: "main" },
      fetch: fetchMock as any,
    });
    const idx = await client.getProgramsIndex();
    expect(idx.programs).toEqual({});
  });
});

describe("RegistryClient.listExternalPrimaryPrograms — configurable network scope", () => {
  const DEV = "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf";
  const TEST = "RomeTaTNPJNBxtB3Wong9geVTtkEFJfUqgktQVq3iSX";
  const idxJson = {
    schemaVersion: "1",
    programs: {
      [DEV]:  { cluster: "devnet", network: "devnet",  role: "primary", kind: "rome-evm", chainsHosted: [] },
      [TEST]: { cluster: "devnet", network: "testnet", role: "primary", kind: "rome-evm", chainsHosted: [] },
    },
    primary: { testnet: TEST, mainnet: null, devnet: DEV, "real-testnet": null },
  };
  const fetchMock = (url: string) =>
    String(url).endsWith("/programs/index.json")
      ? Promise.resolve(new Response(JSON.stringify(idxJson), { status: 200 }))
      : Promise.resolve(new Response("", { status: 404 }));

  beforeEach(() => { delete process.env.PRIMARY_NETWORKS; });

  it("defaults to testnet+mainnet, excluding the devnet primary", async () => {
    const client = new RegistryClient({ source: { kind: "github", ref: "main" }, fetch: fetchMock as any });
    const progs = await client.listExternalPrimaryPrograms();
    expect(progs.map((p) => p.id)).toEqual([TEST]); // mainnet null → skipped; devnet excluded by default
  });

  it("includes the devnet primary when primaryNetworks opts in", async () => {
    const client = new RegistryClient({
      source: { kind: "github", ref: "main" },
      fetch: fetchMock as any,
      primaryNetworks: ["devnet", "testnet"],
    });
    const progs = await client.listExternalPrimaryPrograms();
    expect(progs.map((p) => p.id)).toEqual([DEV, TEST]);
  });
});
