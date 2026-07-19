import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryClient } from "../../src/registry/client";

let dir: string;

function writeProgramsIndex(body: object) {
  const dirPath = join(dir, "programs");
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(join(dirPath, "index.json"), JSON.stringify(body, null, 2));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "registry-programs-"));
});

describe("RegistryClient.getProgramsIndex", () => {
  it("returns parsed programs inventory with primary + programs map", async () => {
    writeProgramsIndex({
      schemaVersion: "1",
      primary: {
        devnet: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8",
        testnet: "RomeTaTNPJNBxtB3Wong9geVTtkEFJfUqgktQVq3iSX",
        mainnet: null,
        "real-testnet": "RPTAqWeyJk1RFV3E4eDe1eMK9thPVoav7NBcFmmh2JP",
      },
      programs: {
        romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8: {
          cluster: "devnet", network: "devnet", role: "primary", kind: "rome-evm",
          chainsHosted: ["121301-marcus"],
        },
        RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf: {
          cluster: "devnet", network: "testnet", role: "secondary", kind: "rome-evm",
          chainsHosted: ["200010-hadrian"],
        },
        RomeDbGQYbqomGVk13h9JkQHKoNWKB84Lw1ij9AtRXT: {
          cluster: "devnet", network: "devnet", role: "retired", kind: "rome-evm",
          chainsHosted: [],
        },
      },
    });
    const client = new RegistryClient({ source: { kind: "local", path: dir } });
    const idx = await client.getProgramsIndex();

    expect(idx.schemaVersion).toBe("1");
    expect(idx.primary.testnet).toBe("RomeTaTNPJNBxtB3Wong9geVTtkEFJfUqgktQVq3iSX");
    expect(idx.primary.mainnet).toBeNull();

    expect(Object.keys(idx.programs)).toHaveLength(3);
    expect(idx.programs["RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf"]?.role).toBe("secondary");
    expect(idx.programs["RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf"]?.chainsHosted).toEqual(["200010-hadrian"]);
  });

  it("listActivePrograms returns only primary + secondary roles (filters retired/closed)", async () => {
    writeProgramsIndex({
      schemaVersion: "1",
      primary: { devnet: null, testnet: null, mainnet: null, "real-testnet": null },
      programs: {
        AlivePrimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: { cluster: "devnet", network: "devnet", role: "primary", kind: "rome-evm", chainsHosted: [] },
        AliveSecondaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: { cluster: "devnet", network: "testnet", role: "secondary", kind: "rome-evm", chainsHosted: [] },
        Retiredxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: { cluster: "devnet", network: "devnet", role: "retired", kind: "rome-evm", chainsHosted: [] },
        Closedxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: { cluster: "devnet", network: "testnet", role: "closed", kind: "rome-evm", chainsHosted: [] },
      },
    });
    const client = new RegistryClient({ source: { kind: "local", path: dir } });
    const active = await client.listActivePrograms();
    expect(active.map((p) => p.id).sort()).toEqual(["AlivePrimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "AliveSecondaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]);
  });

  it("listActivePrograms supports a networks filter", async () => {
    writeProgramsIndex({
      schemaVersion: "1",
      primary: { devnet: null, testnet: null, mainnet: null, "real-testnet": null },
      programs: {
        Devnetxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: { cluster: "devnet", network: "devnet", role: "primary", kind: "rome-evm", chainsHosted: [] },
        Testnetxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: { cluster: "devnet", network: "testnet", role: "primary", kind: "rome-evm", chainsHosted: [] },
      },
    });
    const client = new RegistryClient({ source: { kind: "local", path: dir } });
    const testnetOnly = await client.listActivePrograms({ networks: ["testnet"] });
    expect(testnetOnly.map((p) => p.id)).toEqual(["Testnetxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]);
  });

  it("throws on malformed programs/index.json", async () => {
    writeProgramsIndex({ not: "valid" });
    const client = new RegistryClient({ source: { kind: "local", path: dir } });
    await expect(client.getProgramsIndex()).rejects.toThrow(/programs.*index|malformed/i);
  });

  describe("listExternalPrimaryPrograms", () => {
    it("returns [testnetPrimary, mainnetPrimary] in that order when both are set", async () => {
      writeProgramsIndex({
        schemaVersion: "1",
        primary: {
          devnet: "DevnetPrimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          testnet: "TestnetPrimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          mainnet: "MainnetPrimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          "real-testnet": "RealTestnetPrimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        },
        programs: {
          DevnetPrimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx:        { cluster: "devnet",       network: "devnet",       role: "primary", kind: "rome-evm", chainsHosted: [] },
          TestnetPrimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx:         { cluster: "devnet",       network: "testnet",      role: "primary", kind: "rome-evm", chainsHosted: [] },
          MainnetPrimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx:         { cluster: "mainnet-beta", network: "mainnet",      role: "primary", kind: "rome-evm", chainsHosted: [] },
          RealTestnetPrimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx:     { cluster: "testnet",      network: "real-testnet", role: "primary", kind: "rome-evm", chainsHosted: [] },
        },
      });
      const client = new RegistryClient({ source: { kind: "local", path: dir } });
      const programs = await client.listExternalPrimaryPrograms();
      expect(programs.map((p) => p.id)).toEqual([
        "TestnetPrimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        "MainnetPrimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      ]);
      // devnet + real-testnet primaries are intentionally excluded — they're not
      // part of the external API surface.
    });

    it("returns just [testnetPrimary] when mainnet is null (pre-mainnet-launch state)", async () => {
      writeProgramsIndex({
        schemaVersion: "1",
        primary: {
          devnet: null,
          testnet: "TestnetPrimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          mainnet: null,
          "real-testnet": null,
        },
        programs: {
          TestnetPrimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: { cluster: "devnet", network: "testnet", role: "primary", kind: "rome-evm", chainsHosted: [] },
        },
      });
      const client = new RegistryClient({ source: { kind: "local", path: dir } });
      const programs = await client.listExternalPrimaryPrograms();
      expect(programs.map((p) => p.id)).toEqual(["TestnetPrimaryxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]);
    });

    it("returns [] when neither external primary is set", async () => {
      writeProgramsIndex({
        schemaVersion: "1",
        primary: { devnet: null, testnet: null, mainnet: null, "real-testnet": null },
        programs: {},
      });
      const client = new RegistryClient({ source: { kind: "local", path: dir } });
      expect(await client.listExternalPrimaryPrograms()).toEqual([]);
    });
  });
});
