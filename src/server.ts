import Fastify, { FastifyBaseLogger } from "fastify";
import fastifyCors from "@fastify/cors";
import { Config } from "./config.js";
import { makeLogger } from "./observability/logger.js";
import { httpRequestsTotal, httpRequestDurationSeconds, bridgeErrorsTotal, pollerKeysScanDurationSeconds, registry } from "./observability/metrics.js";
import { registerRoutes } from "./routes/index.js";
import { FixedWindowLimiter, classify } from "./lib/rate-limit.js";
import { bridgeError } from "./errors.js";
import { randomUUID } from "node:crypto";
import { TransferStore } from "./transfers/store.js";
import { CircleAttestationClient } from "./attestation/circle.js";
import { WormholeAttestationClient } from "./attestation/wormhole.js";
import { AttestationPoller } from "./attestation/poller.js";
import { reapExpired } from "./transfers/reaper.js";
import { makeFactoryTokensFor } from "./chains/token-catalog-service.js";
import { makeFactoryIndexer, type FactoryChainSource } from "./chains/token-factory-indexer.js";
import { createPublicClient, http } from "viem";
import { EthereumReader } from "./chains/ethereum.js";
import { EvmClientPool, parseRpcOverrides } from "./chains/evm-pool.js";
import { solanaTxForEvmTx } from "./chains/rome-rpc.js";
import { OwnerInfoClient } from "./chains/owner-info-reader.js";
import { ChainInventory } from "./chains/inventory.js";
import { freshAttestationHealth } from "./routes/routes-matrix.js";
import { RegistryClient } from "./registry/client.js";
import packageJson from "../package.json" with { type: "json" };

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    appVersion: string;
    redis: import("ioredis").Redis;
    attestationPoller: import("./attestation/poller.js").AttestationPoller;
    solanaConnection?: import("@solana/web3.js").Connection;
  }
}

export async function buildApp(cfg: Config) {
  const logger = makeLogger(cfg) as unknown as FastifyBaseLogger;
  const app = Fastify({ logger });
  await app.register(fastifyCors, { origin: "*" });

  const limiter = new FixedWindowLimiter();
  app.addHook("onRequest", async (req, reply) => {
    (req as any)._startHrTime = process.hrtime.bigint();

    // Support/debugging currency: echo the caller's id or mint one; accept
    // inbound traceparent into the log context.
    const inboundId = req.headers["rome-request-id"];
    const requestId = (Array.isArray(inboundId) ? inboundId[0] : inboundId) ?? randomUUID();
    reply.header("Rome-Request-Id", requestId);
    const traceparent = req.headers["traceparent"];
    req.log = req.log.child({ requestId, ...(traceparent ? { traceparent } : {}) });

    // Per-IP fixed-window budgets + IETF draft headers.
    if (req.url === "/metrics") return;
    const cls = classify(req.method, req.url);
    const state = limiter.hit(req.ip, cls);
    reply.header("RateLimit-Limit", String(state.limit));
    reply.header("RateLimit-Remaining", String(state.remaining));
    reply.header("RateLimit-Reset", String(state.resetSeconds));
    if (!state.allowed) {
      const err = bridgeError("rome.bridge.rate-limited", `over the ${cls.name} budget of ${state.limit}/min`);
      reply.header("Retry-After", String(state.resetSeconds));
      await reply.status(429).send({ type: err.type, title: err.title, status: 429, detail: err.detail, code: err.code });
    }
  });
  app.addHook("onResponse", async (req, reply) => {
    const start = (req as any)._startHrTime as bigint | undefined;
    if (!start) return;
    const durationNs = process.hrtime.bigint() - start;
    const durationSec = Number(durationNs) / 1e9;
    const route = req.routeOptions?.url ?? req.url;
    httpRequestsTotal.inc({ route, status: String(reply.statusCode) });
    httpRequestDurationSeconds.observe({ route }, durationSec);
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    // If the response is an RFC 9457 (ex-7807, same wire shape) bridge error, increment by code
    if (reply.statusCode >= 400 && reply.statusCode < 600 && typeof payload === "string") {
      try {
        const body = JSON.parse(payload);
        if (body?.code?.startsWith("rome.bridge.")) {
          bridgeErrorsTotal.inc({ code: body.code });
        }
      } catch { /* not JSON, skip */ }
    }
    return payload;
  });

  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });

  const useInMemory = cfg.env === "test" || process.env.BRIDGE_API_USE_IN_MEMORY_REDIS === "1";
  let redis: import("ioredis").Redis;
  if (useInMemory) {
    const { default: RedisMock } = await import("ioredis-mock");
    redis = new (RedisMock as any)() as import("ioredis").Redis;
  } else {
    const { default: Redis } = await import("ioredis");
    redis = new Redis(cfg.redisUrl);
  }
  app.decorate("redis", redis);
  app.addHook("onClose", async () => { await redis.quit(); });

  // /v1/tokens factory long-tail: getLogs + Redis cache. Skipped in test env so
  // route tests inject their own mock (mirrors the chainInventory pattern).
  if (cfg.env !== "test") {
    app.decorate("factoryTokensFor", makeFactoryTokensFor({ redis }));

    // Background factory indexer — populates the tokencat:factory:<chainId> set
    // that factoryTokensFor reads. Off the request path (Rome caps eth_getLogs at
    // 12k blocks); one-time backfill from the registration slot, then incremental.
    const registryForIndexer = new RegistryClient({ source: { kind: "local", path: cfg.registryPath } });
    const factoryIndexer = makeFactoryIndexer({
      redis,
      listChains: () => registryForIndexer.listChains(),
      sourceFor: (rpcUrl: string) => {
        const client = createPublicClient({ transport: http(rpcUrl) });
        return {
          getLogs: (args: Parameters<FactoryChainSource["getLogs"]>[0]) => client.getLogs(args as never),
          getBlockNumber: () => client.getBlockNumber(),
          blockExists: async (n: bigint) => {
            try { await client.getBlock({ blockNumber: n }); return true; }
            catch { return false; }
          },
        } as unknown as FactoryChainSource;
      },
    });
    factoryIndexer.start(60_000);
    app.addHook("onClose", async () => factoryIndexer.stop());
  }

  const circle = new CircleAttestationClient({ baseUrl: process.env.CIRCLE_IRIS_BASE_URL ?? "https://iris-api-sandbox.circle.com/v1" });
  const store = new TransferStore(redis);

  // Wormhole inbound auto-advance — wired when env+config are present.
  // Sepolia (Wormhole chain id 10002) Token Bridge: 0xDB5492265f6038831E89f495670FF909aDe94bd9
  // Ethereum mainnet (chain id 2) Token Bridge:     0x3ee18B2214AFF97000D974cf647E54bfb53b8d51
  const isMainnet = process.env.ETHEREUM_NETWORK === "mainnet";
  const wormholeBaseUrl = process.env.WORMHOLESCAN_BASE_URL
    ?? (isMainnet ? "https://api.wormholescan.io" : "https://api.testnet.wormholescan.io");
  const wormholeClient = new WormholeAttestationClient({ baseUrl: wormholeBaseUrl });
  const wormholeSourceChain = {
    tokenBridgeEmitter: isMainnet
      ? "0x3ee18B2214AFF97000D974cf647E54bfb53b8d51"
      : "0xDB5492265f6038831E89f495670FF909aDe94bd9",
    wormholeChainId: isMainnet ? 2 : 10002,
  };

  // Shared attestation-health object — decorated HERE, before the poller is
  // constructed, and handed to it in BOTH branches. registerRoutes' decoration
  // is hasDecorator-guarded, so this is the single instance every consumer
  // (poller writes; /v1/health + /v1/routes read) shares. The prior ordering —
  // decorate inside registerRoutes, construct the poller first — handed the
  // poller `undefined`: vendor successes were never stamped, health ages read
  // null forever, and route live-degradation could never fire.
  if (!app.hasDecorator("attestationHealth")) {
    app.decorate("attestationHealth", freshAttestationHealth());
  }

  // txLogReader is lazily wired via the EthereumReader below (non-test envs).
  // In tests the poller's Wormhole path stays no-op unless a stub is injected.
  let poller: AttestationPoller;
  if (cfg.env !== "test") {
    const rpcUrl = process.env.ETHEREUM_RPC_URL;
    if (!rpcUrl) {
      // The reader verifies non-CCTP registrations; without the env it rides
      // viem's PUBLIC default RPC (flaky/rate-limited → false
      // source-tx-not-found). Loud at boot; ops provides it alongside
      // EVM_RPC_URLS_JSON.
      app.log.warn("ETHEREUM_RPC_URL is unset — source-tx verification falls back to viem's public default RPC (flaky); set it from the paid-RPC map");
    }
    const ethReaderForPoller = new EthereumReader({
      chain: isMainnet ? "mainnet" : "sepolia",
      ...(rpcUrl ? { rpcUrl } : {}),
    });
    poller = new AttestationPoller(
      store, circle, wormholeClient,
      (hash) => ethReaderForPoller.getTxLogs(hash),
      wormholeSourceChain,
      undefined,
      app.attestationHealth,
      (romeRpcUrl, evmTxHash) => solanaTxForEvmTx(romeRpcUrl, evmTxHash),
    );
  } else {
    poller = new AttestationPoller(
      store, circle, undefined, undefined, undefined, undefined,
      app.attestationHealth,
    );
  }
  app.decorate("attestationPoller", poller);

  // tick every 5s in non-test envs
  if (cfg.env !== "test") {
    const interval = setInterval(async () => {
      // Track the O(N) redis.keys scan latency. cheap at v1.0 volume,
      // monitor at scale. p99 crossing ~100ms is the signal to switch to a
      // pending-transfers Redis SET index.
      const stop = pollerKeysScanDurationSeconds.startTimer();
      const keys = await redis.keys("bridge:v1:transfer:*");
      stop();
      for (const key of keys) {
        const id = key.replace("bridge:v1:transfer:", "");
        try { await poller.tickOnce(id); } catch (err) { app.log.warn({ err, id }, "poller tick failed"); }
      }
    }, 5_000);
    app.addHook("onClose", async () => clearInterval(interval));

    // Terminal-failure reaper: sponsor-stalled pending records expire after
    // MAX_PENDING_SECONDS (never user-paced claims) instead of retrying every
    // 5s forever. Liveness verdict only — burns stay claimable on-chain.
    const maxPendingSeconds = Number(process.env.MAX_PENDING_SECONDS ?? 48 * 3600);
    const reaperInterval = setInterval(() => {
      reapExpired(store, { maxPendingSeconds, warn: (m) => app.log.warn(m) })
        .catch((err) => app.log.warn({ err }, "reaper pass failed"));
    }, 60_000);
    app.addHook("onClose", async () => clearInterval(reaperInterval));
  }

  // Only wire real EthereumReader in non-test envs. Tests inject their own stub via app.decorate.
  if (cfg.env !== "test") {
    const rpcUrl = process.env.ETHEREUM_RPC_URL;
    const ethereumReader = new EthereumReader({
      chain: process.env.ETHEREUM_NETWORK === "mainnet" ? "mainnet" : "sepolia",
      ...(rpcUrl ? { rpcUrl } : {}),
    });
    app.decorate("ethereumReader", ethereumReader);

    // Per-source EVM client pool (read-only). Catalog rpcUrl per entry;
    // EVM_RPC_URLS_JSON overrides per chain id; the legacy ETHEREUM_RPC_URL
    // env maps onto the configured default network's id.
    const overrides = parseRpcOverrides(process.env.EVM_RPC_URLS_JSON) ?? {};
    const legacyId = process.env.ETHEREUM_NETWORK === "mainnet" ? "1" : "11155111";
    if (rpcUrl && !overrides[legacyId]) overrides[legacyId] = rpcUrl;
    app.decorate("evmPool", new EvmClientPool({ rpcOverrides: overrides }));

    // ChainInventory composes registry programs/index.json + on-chain OwnerInfo PDA reads.
    // Tests inject a mocked inventory directly via app.decorate.
    // Uses cfg.solanaRpcUrl (SOLANA_RPC_URL) — a dedicated Solana RPC endpoint.
    // Fail-closed: with no RPC configured we DON'T wire it (every consumer
    // guards on `app.chainInventory`) rather than fall back to the public
    // devnet endpoint (rate-limited).
    if (cfg.solanaRpcUrl) {
      const { Connection } = await import("@solana/web3.js");
      const conn = new Connection(cfg.solanaRpcUrl, "confirmed");
      const ownerInfoClient = new OwnerInfoClient({ connection: conn });
      const registryClient = new RegistryClient({
        source: { kind: "local", path: cfg.registryPath },
      });
      const chainInventory = new ChainInventory({ registry: registryClient, ownerInfo: ownerInfoClient });
      app.decorate("chainInventory", chainInventory);
      // Reused by /v1/solana/* for same-origin blockhash reads by clients
      // that can't reach a Solana RPC directly.
      app.decorate("solanaConnection", conn);
    }
  }

  await registerRoutes(app, cfg);
  app.decorate("config", cfg);
  app.decorate("appVersion", packageJson.version);
  return app;
}

export async function startServer() {
  const { loadConfig } = await import("./config.js");
  const cfg = loadConfig();
  const app = await buildApp(cfg);
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
