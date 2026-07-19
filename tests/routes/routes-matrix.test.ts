import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server";
import { writePublishedChain } from "../helpers/chains";

let app: Awaited<ReturnType<typeof buildApp>>;
const fastQuote = vi.fn();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  writePublishedChain(dir, "121301-routestest", {
    chain: { chainId: 121301, name: "Marcus", network: "devnet", status: "live", rpcUrl: "https://marcus.invalid", romeEvmProgramId: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8", solana: { cluster: "devnet" } },
    bridge: {
      cctpIrisApiBase: "https://iris-api-sandbox.circle.com",
      sourceEvm: { chainId: 11155111, name: "Sepolia", cctpVersion: 2, cctpDomain: 0, cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", cctpTokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", wormholeTokenBridge: "0xDB5492265f6038831E89f495670FF909aDe94bd9" },
      sourceEvms: [{ chainId: 10143, name: "Monad Testnet", cctpVersion: 2, cctpDomain: 15, cctpTokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", cctpTokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" }],
      solana: { cctpDomain: 5 },
      assets: [
        { id: "usdc", symbol: "USDC", solanaMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", sourceEvm: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", protocol: "cctp" } },
        { id: "usdc-monad", symbol: "USDC", solanaMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", sourceEvm: { chainId: 10143, address: "0x534b2f3A21130d7a60830c2Df862319e593943A3", protocol: "cctp", cctpVersion: 2 } },
      ],
    },
    tokens: [{ kind: "gas", mintId: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", gasPool: "AkZ6NSKzoM6Q3TqVwgtCixpjBDRqEhs5YTZxYzX6s2Jt", symbol: "USDC" }],
  });
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
  (app as never as { decorate: (k: string, v: unknown) => void }).decorate("feesProbe", { fastQuote });
});
afterAll(async () => { await app.close(); });

describe("GET /v1/routes — capability matrix with live status", () => {
  it("lists an inbound route per catalog source with speeds from the live probe", async () => {
    fastQuote.mockImplementation(async (_base: string, src: number) => (src === 0 ? { available: true, bps: 1 } : { available: false }));
    const res = await app.inject({ method: "GET", url: "/v1/routes" });
    expect(res.statusCode).toBe(200);
    const { routes } = res.json();
    const inbound = routes.filter((r: { direction: string; asset: string }) => r.direction === "to-rome" && r.asset === "USDC");
    const sepolia = inbound.find((r: { sourceChainId: string }) => r.sourceChainId === "eip155:11155111");
    const monad = inbound.find((r: { sourceChainId: string }) => r.sourceChainId === "eip155:10143");
    expect(sepolia).toMatchObject({
      romeChainId: "121301",
      speeds: ["standard", "fast"],      // probe says fast available on domain 0
      status: "active",
      limits: { min: expect.any(String), max: expect.any(String) },
    });
    expect(monad).toMatchObject({ speeds: ["standard"], status: "active" }); // fast unavailable → standard only
    expect(sepolia.eta).toMatchObject({ standard: expect.any(Number), fast: expect.any(Number) });
    expect(sepolia.cctpVersion).toBe(2); // transport version is explicit per row — /v1 is the API namespace, not the CCTP version
    expect(monad.chainName).toBe("Monad Testnet");
  });

  it("inbound ETAs are additive (source finality + Solana settlement) — no cross-chain route beats a Solana-native deposit", async () => {
    // Rome EVM runs inside a Solana program: every inbound transfer terminates
    // in a Solana settle tx, so a foreign chain can NEVER land on Rome faster
    // than a native Solana deposit. Its ETA = its own finality + the Solana leg.
    fastQuote.mockImplementation(async (_b: string, src: number) => (src === 0 ? { available: true, bps: 1 } : { available: false }));
    const res = await app.inject({ method: "GET", url: "/v1/routes" });
    const toRome = res.json().routes.filter((r: { direction: string }) => r.direction === "to-rome");
    const solNative = toRome.find((r: { rail: string; asset: string }) => r.rail === "solana" && r.asset === "SOL");
    expect(solNative).toBeTruthy();
    const floor = solNative.eta.standard; // the Solana settlement leg — the hard floor
    // Nothing inbound is faster than the Solana floor, on either speed.
    for (const r of toRome) {
      expect(r.eta.standard).toBeGreaterThanOrEqual(floor);
      if (r.eta.fast !== undefined) expect(r.eta.fast).toBeGreaterThanOrEqual(floor);
    }
    // And the cross-chain number is exactly source-finality + the floor.
    const sepolia = toRome.find((r: { sourceChainId: string; asset: string }) => r.sourceChainId === "eip155:11155111" && r.asset === "USDC");
    expect(sepolia.eta.standard).toBe(1140 + floor); // Sepolia hard finality + Solana settle
    expect(sepolia.eta.fast).toBe(20 + floor);       // Circle fast soft-finality + Solana settle
    const monad = toRome.find((r: { sourceChainId: string; asset: string }) => r.sourceChainId === "eip155:10143" && r.asset === "USDC");
    expect(monad.eta.standard).toBe(30 + floor);
    const eth = toRome.find((r: { asset: string }) => r.asset === "ETH");
    expect(eth.eta.standard).toBe(900 + floor);      // Wormhole guardian finality + Solana settle
  });

  // Degradation = the upstream is FAILING, never merely quiet. The live
  // false-positive this pins: an idle service (no in-flight transfers, so no
  // attestation fetches) aged circleLastSuccessAt past the threshold and
  // /v1/routes reported every route degraded for ~21h while Circle was fine.
  const health = () => (app as never as { attestationHealth: { circle: { lastSuccessAt: number | null; lastFailureAt: number | null }; wormhole: { lastSuccessAt: number | null; lastFailureAt: number | null } } }).attestationHealth;

  it("stays active when the upstream is merely idle (stale success, no failures)", async () => {
    fastQuote.mockResolvedValue({ available: false });
    health().circle = { lastSuccessAt: Date.now() - 21 * 3_600_000, lastFailureAt: null };
    const res = await app.inject({ method: "GET", url: "/v1/routes" });
    const cctpRoute = res.json().routes.find((r: { asset: string; direction: string }) => r.asset === "USDC" && r.direction === "to-rome");
    expect(cctpRoute.status).toBe("active");
    expect(cctpRoute.statusDetail).toBeUndefined();
    health().circle = { lastSuccessAt: null, lastFailureAt: null };
  });

  it("flips to degraded with detail when the upstream is failing without recent success (fault injection)", async () => {
    fastQuote.mockResolvedValue({ available: false });
    health().circle = { lastSuccessAt: Date.now() - 15 * 60_000, lastFailureAt: Date.now() - 60_000 };
    const res = await app.inject({ method: "GET", url: "/v1/routes" });
    const cctpRoute = res.json().routes.find((r: { asset: string; direction: string }) => r.asset === "USDC" && r.direction === "to-rome");
    expect(cctpRoute.status).toBe("degraded");
    expect(cctpRoute.statusDetail).toMatch(/attestation/i);
    health().circle = { lastSuccessAt: null, lastFailureAt: null };
  });

  it("recovers as soon as a fresh success lands, even with intermittent failures", async () => {
    fastQuote.mockResolvedValue({ available: false });
    health().circle = { lastSuccessAt: Date.now() - 30_000, lastFailureAt: Date.now() - 60_000 };
    const res = await app.inject({ method: "GET", url: "/v1/routes" });
    const cctpRoute = res.json().routes.find((r: { asset: string; direction: string }) => r.asset === "USDC" && r.direction === "to-rome");
    expect(cctpRoute.status).toBe("active");
    health().circle = { lastSuccessAt: null, lastFailureAt: null };
  });

  it("advertises outbound per destination when the chain has a live RomeBridgeWithdraw", async () => {
    fastQuote.mockResolvedValue({ available: false });
    const res = await app.inject({ method: "GET", url: "/v1/routes" });
    const { routes } = res.json();
    // The routes-test chain publishes no contracts.json → no outbound rows (fail closed).
    expect(routes.filter((r: { direction: string }) => r.direction === "from-rome")).toHaveLength(0);
  });

  it("advertises non-USDC rails per asset: an ETH/Wormhole row where the source entry configures wormholeTokenBridge", async () => {
    fastQuote.mockResolvedValue({ available: false });
    const res = await app.inject({ method: "GET", url: "/v1/routes" });
    const { routes } = res.json();
    const eth = routes.find((r: { asset: string; direction: string }) => r.asset === "ETH" && r.direction === "to-rome");
    expect(eth).toMatchObject({
      sourceChainId: "eip155:11155111",
      rail: "wormhole",
      decimals: 18,
      speeds: ["standard"],
      status: "active",
      limits: { min: expect.any(String), max: expect.any(String) },
    });
    expect(eth.cctpVersion).toBeUndefined(); // wormhole rows carry no CCTP fields
    // Monad has no wormholeTokenBridge in the fixture → no ETH row for it
    expect(routes.filter((r: { asset: string; sourceChainId: string }) => r.asset === "ETH" && r.sourceChainId === "eip155:10143")).toHaveLength(0);
  });

  it("every row names its rail and decimals (a client formats per asset)", async () => {
    fastQuote.mockResolvedValue({ available: false });
    const res = await app.inject({ method: "GET", url: "/v1/routes" });
    for (const r of res.json().routes) {
      expect(["cctp", "wormhole", "solana"]).toContain(r.rail);
      expect(typeof r.decimals).toBe("number");
    }
  });

  it("wormhole vendor health degrades ONLY wormhole rows — vendor separation", async () => {
    fastQuote.mockResolvedValue({ available: false });
    health().wormhole = { lastSuccessAt: Date.now() - 15 * 60_000, lastFailureAt: Date.now() - 30_000 };
    const res = await app.inject({ method: "GET", url: "/v1/routes" });
    const { routes } = res.json();
    expect(routes.find((r: { asset: string }) => r.asset === "ETH").status).toBe("degraded");
    expect(routes.find((r: { asset: string; direction: string }) => r.asset === "USDC" && r.direction === "to-rome").status).toBe("active");
    health().wormhole = { lastSuccessAt: null, lastFailureAt: null };
  });

  it("/assets stays alive as the legacy alias", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/assets" });
    expect(res.statusCode).toBe(200);
    expect(res.json().routes).toBeDefined();
  });
});
