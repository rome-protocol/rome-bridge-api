import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { buildApp } from "../../src/server";
import { InvalidProgramIdError } from "../../src/chains/inventory";

let app: Awaited<ReturnType<typeof buildApp>>;

const HADRIAN_PROGRAM    = "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf"; // testnet secondary
const TESTNET_PRIMARY    = "RomeTaTNPJNBxtB3Wong9geVTtkEFJfUqgktQVq3iSX";
const MAINNET_PRIMARY    = "RoMaiNxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; // synthetic
const USDC_DEVNET_MINT   = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const WSOL_MINT          = "So11111111111111111111111111111111111111112";

function detail(programId: string, network: string, chainId: string, extras?: Partial<any>) {
  return {
    chainId, programId, network,
    name: `Rome ${chainId}`,
    rpcUrl: `https://${chainId}.${network}.romeprotocol.xyz/`,
    gasMint: { solanaMint: USDC_DEVNET_MINT, symbol: "USDC" },
    supportedAssets: [],
    singleState: false,
    hasRegistryEntry: true,
    ...extras,
  };
}

// Test scenarios: the mocked inventory returns different shapes depending on
// (scope.programId, chainId). The route is the unit under test.
let inventoryScenario: "default-testnet-only" | "default-collision" | "programid-override" = "default-testnet-only";

const TESTNET_HADRIAN_DETAIL = detail(HADRIAN_PROGRAM, "testnet", "200010");
const TESTNET_PRIMARY_DETAIL = detail(TESTNET_PRIMARY, "testnet", "200012");
const MAINNET_COLLIDING      = detail(MAINNET_PRIMARY, "mainnet", "200012",
  { gasMint: { solanaMint: WSOL_MINT, symbol: "wSOL" }, name: "Rome Mainnet 200012" });

beforeAll(async () => {
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: "/tmp/unused-in-test-env" });
  (app as any).decorate("chainInventory", {
    listChains: vi.fn().mockImplementation(async (scope?: { programId?: string }) => {
      if (scope?.programId === HADRIAN_PROGRAM) return [TESTNET_HADRIAN_DETAIL];
      if (scope?.programId === "UNKNOWN") throw new InvalidProgramIdError("UNKNOWN");
      // default scope
      if (inventoryScenario === "default-testnet-only") return [TESTNET_PRIMARY_DETAIL];
      if (inventoryScenario === "default-collision")    return [TESTNET_PRIMARY_DETAIL, MAINNET_COLLIDING];
      return [TESTNET_PRIMARY_DETAIL];
    }),
    getChainsByChainId: vi.fn().mockImplementation(async (chainId: bigint, scope?: { programId?: string }) => {
      if (scope?.programId === HADRIAN_PROGRAM) {
        return chainId === 200010n ? [TESTNET_HADRIAN_DETAIL] : [];
      }
      if (scope?.programId === "UNKNOWN") throw new InvalidProgramIdError("UNKNOWN");
      // default scope
      if (inventoryScenario === "default-collision" && chainId === 200012n) {
        return [TESTNET_PRIMARY_DETAIL, MAINNET_COLLIDING];
      }
      if (inventoryScenario === "default-testnet-only" && chainId === 200012n) {
        return [TESTNET_PRIMARY_DETAIL];
      }
      return [];
    }),
  });
});
afterAll(async () => { if (app) await app.close(); });

describe("GET /v1/chains/{chainId} — default scope (testnet + mainnet primaries)", () => {
  beforeAll(() => { inventoryScenario = "default-testnet-only"; });

  it("returns 200 with the matching primary chain", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/chains/200012" });
    expect(res.statusCode).toBe(200);
    expect(res.json().chainId).toBe("200012");
    expect(res.json().programId).toBe(TESTNET_PRIMARY);
  });

  it("returns 404 for a chainId hosted only by a secondary program (out of default scope)", async () => {
    // Hadrian (200010) is on the testnet secondary RPTW... — not in default scope.
    const res = await app.inject({ method: "GET", url: "/v1/chains/200010" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 request-invalid on non-numeric chainId", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/chains/not-a-number" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("rome.bridge.request-invalid");
  });
});

describe("GET /v1/chains/{chainId} — collision across testnet AND mainnet primaries", () => {
  beforeAll(() => { inventoryScenario = "default-collision"; });
  afterAll(() => { inventoryScenario = "default-testnet-only"; });

  it("returns 409 rome.bridge.chain-id-ambiguous and points at ?programId= as the disambiguator", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/chains/200012" });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe("rome.bridge.chain-id-ambiguous");
    expect(body.detail).toMatch(/programId/);
    expect(body.meta?.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ programId: TESTNET_PRIMARY, network: "testnet" }),
      expect.objectContaining({ programId: MAINNET_PRIMARY, network: "mainnet" }),
    ]));
  });
});

describe("GET /v1/chains/{chainId}?programId= — explicit program override", () => {
  it("returns the chain when the program hosts that chainId", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/chains/200010?programId=${HADRIAN_PROGRAM}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().programId).toBe(HADRIAN_PROGRAM);
    expect(res.json().chainId).toBe("200010");
  });

  it("returns 404 when the program doesn't host the requested chainId", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/chains/9999?programId=${HADRIAN_PROGRAM}` });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when the programId is not in the registry", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/chains/200010?programId=UNKNOWN" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("rome.bridge.program-id-unknown");
  });
});

describe("GET /v1/chains — default scope returns only external-primary chains", () => {
  beforeAll(() => { inventoryScenario = "default-testnet-only"; });

  it("returns the testnet + mainnet primary chains (here just testnet primary is set)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/chains" });
    expect(res.statusCode).toBe(200);
    expect(res.json().chains.map((c: any) => c.programId)).toEqual([TESTNET_PRIMARY]);
  });

  it("?programId=<secondary> narrows to that program's chains", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/chains?programId=${HADRIAN_PROGRAM}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().chains).toEqual([TESTNET_HADRIAN_DETAIL]);
  });

  it("?programId= unknown → 400", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/chains?programId=UNKNOWN" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("rome.bridge.program-id-unknown");
  });
});
