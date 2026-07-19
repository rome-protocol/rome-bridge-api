/**
 * GET /v1/routes — the capability matrix with LIVE status
 *. Supersedes /assets (kept as alias).
 *
 * Per route: limits, speeds (fast comes from Circle's fees probe — a live
 * per-route subset, never a config flag), honest per-source ETA hints, and
 * status driven by the attestation poller's upstream health so integrators
 * can gray a route out before users strand funds mid-flow.
 */
import { FastifyInstance } from "fastify";
import { Config } from "../config.js";
import { RegistryClient } from "../registry/client.js";
import { CachedRegistry } from "../registry/cache.js";
import { ROUTE_SPECS, effectiveMinAmount } from "../route-builders/route-keys.js";
import { cctpDomainFor, mergedCatalog, assetFor } from "../registry/catalog.js";
import { caip2ForEvm, caip2ForSolanaCluster } from "../lib/caip2.js";
import { liveContractAddress } from "../registry/contracts.js";
import { resolveCctpAddresses } from "../registry/catalog.js";
import { CircleFeesProbe } from "../cctp/fees.js";

/** A failure this recent (with no success after it) marks the upstream degraded. */
const FAILURE_WINDOW_MS = 10 * 60_000;

/**
 * Reachability, not recency: an idle service performs no attestation fetches,
 * so "last success is old" alone means QUIET, not DOWN (the shipped
 * silence-threshold version reported every route degraded after 10 idle
 * minutes). Degraded now requires an observed recent failure that no success
 * has answered.
 */
export interface VendorHealth {
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}
export interface AttestationHealth {
  circle: VendorHealth;
  wormhole: VendorHealth;
}

export const freshAttestationHealth = (): AttestationHealth => ({
  circle: { lastSuccessAt: null, lastFailureAt: null },
  wormhole: { lastSuccessAt: null, lastFailureAt: null },
});

export function vendorDegraded(v: VendorHealth, now: number): boolean {
  if (v.lastFailureAt === null || now - v.lastFailureAt > FAILURE_WINDOW_MS) return false;
  return v.lastSuccessAt === null || v.lastSuccessAt < v.lastFailureAt;
}

interface FeesProbeLike {
  fastQuote(irisBase: string, srcDomain: number, dstDomain: number): Promise<{ available: boolean; bps?: number }>;
}

declare module "fastify" {
  interface FastifyInstance {
    attestationHealth: AttestationHealth;
    feesProbe?: FeesProbeLike;
  }
}

export async function routesMatrixRoutes(app: FastifyInstance, cfg: Config) {
  const registry = new CachedRegistry(new RegistryClient({ source: { kind: "local", path: cfg.registryPath } }), 60_000);

  // One probe for the route's lifetime: keeps the TTL cache effective across
  // requests, and its reachability reports feed the shared health object so an
  // otherwise-idle service still has a live Iris signal (test-injected
  // app.feesProbe takes precedence and reports nothing).
  const ownProbe = new CircleFeesProbe({
    onUpstreamResult: (ok) => {
      const circle = app.attestationHealth.circle;
      if (ok) circle.lastSuccessAt = Date.now();
      else circle.lastFailureAt = Date.now();
    },
  });

  app.get("/routes", async () => {
    const probe: FeesProbeLike = app.feesProbe ?? ownProbe;
    const chains = await registry.listChains();
    const spec = ROUTE_SPECS["usdc-cctp-to-rome"];

    const circle = app.attestationHealth.circle;
    const circleDegraded = vendorDegraded(circle, Date.now());
    const wh = app.attestationHealth.wormhole;
    const wormholeDegraded = vendorDegraded(wh, Date.now());
    const wormholeStatus = wormholeDegraded ? ("degraded" as const) : ("active" as const);
    const wormholeDetail = wormholeDegraded
      ? `wormhole attestation upstream failing (no success for ${wh.lastSuccessAt === null ? "over 10" : Math.round((Date.now() - wh.lastSuccessAt) / 60_000)} min)`
      : undefined;
    const cctpStatus = circleDegraded ? ("degraded" as const) : ("active" as const);
    const cctpDetail = circleDegraded
      ? `circle attestation upstream failing (no success for ${circle.lastSuccessAt === null ? "over 10" : Math.round((Date.now() - circle.lastSuccessAt) / 60_000)} min)`
      : undefined;

    // Real CCTP finality per source domain, from Circle's docs
    // (developers.circle.com/cctp/required-block-confirmations, fetched 2026-07-12).
    // Fast = soft-finality attestation (~seconds; near-uniform because it's
    // Circle's service latency, not chain finality). Standard = hard finality
    // (chain-specific). fast:null = Fast Transfer not offered on that chain.
    // Monad (domain 15, testnet) isn't in Circle's mainnet table — it's a
    // fast-finality chain, so we use the standard v2 fast/soft-finality figure.
    const CCTP_FINALITY: Record<number, { fast: number | null; standard: number }> = {
      0:  { fast: 20,   standard: 1140 }, // Ethereum / Sepolia
      1:  { fast: null, standard: 8 },    // Avalanche / Fuji (fast finality)
      2:  { fast: 8,    standard: 1140 }, // Optimism
      3:  { fast: 8,    standard: 1140 }, // Arbitrum
      6:  { fast: 8,    standard: 1140 }, // Base
      7:  { fast: null, standard: 8 },    // Polygon PoS / Amoy
      5:  { fast: 8,    standard: 25 },   // Solana (CCTP)
      15: { fast: 8,    standard: 30 },   // Monad (testnet, fast-finality; not in Circle's mainnet table)
    };
    // Rome EVM runs inside a Solana program, so EVERY inbound transfer settles
    // via a Solana tx once the source is attested. Time to land on Rome =
    // source finality/attestation + this Solana settlement leg. It is the hard
    // floor: no cross-chain route can beat a native Solana deposit (the numbers
    // above are the SOURCE component only — always add the Solana leg for an
    // inbound ETA). Kept equal to the Solana-native lane's ETA below.
    const SOLANA_SETTLEMENT_SECONDS = 13;
    const cctpEta = (domain: number | undefined, fastAvailable: boolean) => {
      const fin = (domain !== undefined && CCTP_FINALITY[domain]) || { fast: 8, standard: 1140 };
      return {
        standard: fin.standard + SOLANA_SETTLEMENT_SECONDS,
        ...(fastAvailable && fin.fast != null ? { fast: fin.fast + SOLANA_SETTLEMENT_SECONDS } : {}),
      };
    };
    const routes = [];
    for (const chain of chains) {
      const bridge = chain.bridge;
      if (!bridge) continue;
      const dstDomain = bridge.solana?.cctpDomain;
      const irisRoot = bridge.cctpIrisApiBase;
      for (const entry of mergedCatalog(bridge)) {
        const usdcRow = assetFor(bridge, { symbol: "USDC", sourceChainId: entry.chainId });
        if (!usdcRow || usdcRow.sourceEvm?.protocol !== "cctp") continue;
        const srcDomain = cctpDomainFor(bridge, entry);
        let fastAvailable = false;
        if (irisRoot && srcDomain !== undefined && dstDomain !== undefined) {
          fastAvailable = (await probe.fastQuote(irisRoot, srcDomain, dstDomain)).available;
        }
        routes.push({
          asset: "USDC",
          rail: "cctp" as const,
          decimals: spec.decimals,
          sourceChainId: caip2ForEvm(entry.chainId),
          chainName: entry.name ?? `evm-${entry.chainId}`,
          direction: "to-rome" as const,
          romeChainId: chain.chainId,
          limits: { min: effectiveMinAmount(spec, chain), max: spec.maxAmount },
          speeds: fastAvailable ? ["standard", "fast"] : ["standard"],
          fees: fastAvailable ? [{ type: "circle-fast-transfer", asset: "USDC", paidTo: "circle" }] : [],
          eta: cctpEta(srcDomain, fastAvailable),
          status: cctpStatus,
          cctpVersion: 2,
          ...(cctpDetail ? { statusDetail: cctpDetail } : {}),
        });
      }
      // Outbound: advertised per destination when the chain has a LIVE
      // RomeBridgeWithdraw and the destination carries a V2 transmitter for
      // the user's claim step.
      const withdraw = liveContractAddress(chain, "RomeBridgeWithdraw");
      if (withdraw) {
        for (const entry of mergedCatalog(bridge)) {
          const usdcRow = assetFor(bridge, { symbol: "USDC", sourceChainId: entry.chainId });
          if (!usdcRow || usdcRow.sourceEvm?.protocol !== "cctp") continue;
          if (!resolveCctpAddresses(entry, 2).messageTransmitter) continue;
          routes.push({
            asset: "USDC",
            rail: "cctp" as const,
            decimals: spec.decimals,
            sourceChainId: caip2ForEvm(entry.chainId), // the DESTINATION chain for from-rome rows
            chainName: entry.name ?? `evm-${entry.chainId}`,
            direction: "from-rome" as const,
            romeChainId: chain.chainId,
            limits: { min: effectiveMinAmount(spec, chain), max: spec.maxAmount },
            speeds: ["standard"],
            fees: [],
            // Rome burns via the Solana-domain CCTP path → claim available after
            // Solana hard finality (~25s), then the user submits the claim.
            eta: { standard: 25 },
            status: cctpStatus,
            cctpVersion: 2,
            ...(cctpDetail ? { statusDetail: cctpDetail } : {}),
          });
        }
      }
      // ETH via Wormhole — advertised on exactly the predicate the quote
      // gates on: the source entry configures a wormholeTokenBridge. Status
      // follows the WORMHOLE vendor's health, independent of Circle's.
      const ethSpec = ROUTE_SPECS["eth-wormhole-to-rome"];
      const ethSpecOut = ROUTE_SPECS["eth-wormhole-from-rome"];
      for (const entry of mergedCatalog(bridge)) {
        if (!entry.wormholeTokenBridge) continue;
        const base = {
          asset: "ETH",
          rail: "wormhole" as const,
          decimals: ethSpec.decimals,
          sourceChainId: caip2ForEvm(entry.chainId),
          chainName: entry.name ?? `evm-${entry.chainId}`,
          romeChainId: chain.chainId,
          speeds: ["standard"],
          fees: [],
          status: wormholeStatus,
          ...(wormholeDetail ? { statusDetail: wormholeDetail } : {}),
        };
        routes.push({
          ...base,
          direction: "to-rome" as const,
          limits: { min: ethSpec.minAmount, max: ethSpec.maxAmount },
          // Wormhole guardian finality (rough source estimate) + Solana settle.
          eta: { standard: 900 + SOLANA_SETTLEMENT_SECONDS },
        });
        if (withdraw) {
          routes.push({
            ...base,
            direction: "from-rome" as const,
            limits: { min: ethSpecOut.minAmount, max: ethSpecOut.maxAmount },
            eta: { standard: 300 },
          });
        }
      }

      // Solana ↔ Rome lanes. Rome EVM runs inside a Solana program, so these are
      // direct on-chain deposit/withdrawal (no attestation vendor → always
      // active). The asset set is CATALOG-DRIVEN, not hardcoded: SOL (native)
      // plus every registry-catalogued asset that carries a solanaMint and has a
      // Solana-rail builder. USDC is self-resolving (its builder reads the mint
      // from the catalog); SOL is the native-wrap path. Generic SPL/LST need the
      // client to pass splAsset.mint — surfaced once that page path lands.
      const solCluster = (chain as { solana?: { cluster?: string } }).solana?.cluster;
      const solSource = solCluster ? caip2ForSolanaCluster(solCluster) : undefined;
      if (solSource) {
        const solAssets: Array<{ symbol: string; key: "sol-solana" | "usdc-solana"; decimals: number }> = [
          { symbol: "SOL", key: "sol-solana", decimals: 9 },
        ];
        const seenSym: Record<string, boolean> = { SOL: true };
        for (const a of ((bridge.assets ?? []) as Array<{ symbol?: string; solanaMint?: string; decimals?: number }>)) {
          if (!a.solanaMint || !a.symbol || seenSym[a.symbol]) continue;
          if (a.symbol === "USDC") { solAssets.push({ symbol: "USDC", key: "usdc-solana", decimals: a.decimals ?? 6 }); seenSym.USDC = true; }
          // other SPL/LST: needs the generic splAsset client path (follow-up)
        }
        for (const sa of solAssets) {
          const inSpec = ROUTE_SPECS[`${sa.key}-to-rome`];
          routes.push({
            asset: sa.symbol, rail: "solana" as const, decimals: sa.decimals,
            sourceChainId: solSource, chainName: "Solana", direction: "to-rome" as const,
            romeChainId: chain.chainId, limits: { min: inSpec.minAmount, max: inSpec.maxAmount },
            speeds: ["standard"], fees: [], eta: { standard: SOLANA_SETTLEMENT_SECONDS }, status: "active" as const,
          });
          if (withdraw) {
            const outSpec = ROUTE_SPECS[`${sa.key}-from-rome`];
            routes.push({
              asset: sa.symbol, rail: "solana" as const, decimals: sa.decimals,
              sourceChainId: solSource, chainName: "Solana", direction: "from-rome" as const,
              romeChainId: chain.chainId, limits: { min: outSpec.minAmount, max: outSpec.maxAmount },
              speeds: ["standard"], fees: [], eta: { standard: SOLANA_SETTLEMENT_SECONDS }, status: "active" as const,
            });
          }
        }
      }
    }
    return { routes };
  });
}
