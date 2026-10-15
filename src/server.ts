import Fastify, { FastifyBaseLogger } from "fastify";
import fastifyCors, { type FastifyCorsOptions } from "@fastify/cors";
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
  
  // CORS: configure allowed origins per deployment. Never use "*" on a bridge
  // API — transfers, settle material and quotes are all readable cross-origin;
  // default is deny (origin=false), enable via BRIDGE_CORS_ORIGINS.
  const corsOrigins = (process.env.BRIDGE_CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const corsOptions: FastifyCorsOptions = corsOrigins.length > 0 ? { origin: corsOrigins } : { origin: false };

  await app.register(fastifyCors, corsOptions);

  const limiter = new FixedWindowLimiter();
  app.addHook("onRequest", async (req, reply) => {
    (req as any)._startHrTime = process.hrtime.bigint();

    const inboundId = req.headers["rome-request-id"];
    const requestId = (Array.isArray(inboundId) ? inboundId[0] : inboundId) ?? randomUUID();
    reply.header("Rome-Request-Id", requestId);
    const traceparent = req.headers["traceparent"];
    req.log = req.log.child({ requestId, ...(traceparent ? { traceparent } : {}) });

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

  if (cfg.env !== "test") {
    app.decorate("factoryTokensFor", makeFactoryTokensFor({ redis }));

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

  if (!app.hasDecorator("attestationHealth")) {
    app.decorate("attestationHealth", freshAttestationHealth());
  }

  let poller: AttestationPoller;
  if (cfg.env !== "test") {
    const rpcUrl = process.env.ETHEREUM_RPC_URL;
    if (!rpcUrl) {
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

  if (cfg.env !== "test") {
    const interval = setInterval(async () => {
      const stop = pollerKeysScanDurationSeconds.startTimer();
      const keys = await redis.keys("bridge:v1:transfer:*");
      stop();
      for (const key of keys) {
        const id = key.replace("bridge:v1:transfer:", "");
        try { await poller.tickOnce(id); } catch (err) { app.log.warn({ err, id }, "poller tick failed"); }
      }
    }, 5_000);
    app.addHook("onClose", async () => clearInterval(interval));

    const maxPendingSeconds = Number(process.env.MAX_PENDING_SECONDS ?? 48 * 3600);
    const reaperInterval = setInterval(() => {
      reapExpired(store, { maxPendingSeconds, warn: (m) => app.log.warn(m) })
        .catch((err) => app.log.warn({ err }, "reaper pass failed"));
    }, 60_000);
    app.addHook("onClose", async () => clearInterval(reaperInterval));
  }

  if (cfg.env !== "test") {
    const rpcUrl = process.env.ETHEREUM_RPC_URL;
    const ethereumReader = new EthereumReader({
      chain: process.env.ETHEREUM_NETWORK === "mainnet" ? "mainnet" : "sepolia",
      ...(rpcUrl ? { rpcUrl } : {}),
    });
    app.decorate("ethereumReader", ethereumReader);

    const overrides = parseRpcOverrides(process.env.EVM_RPC_URLS_JSON) ?? {};
    const legacyId = process.env.ETHEREUM_NETWORK === "mainnet" ? "1" : "11155111";
    if (rpcUrl && !overrides[legacyId]) overrides[legacyId] = rpcUrl;
    app.decorate("evmPool", new EvmClientPool({ rpcOverrides: overrides }));

    if (cfg.solanaRpcUrl) {
      const { Connection } = await import("@solana/web3.js");
      const conn = new Connection(cfg.solanaRpcUrl, "confirmed");
      const ownerInfoClient = new OwnerInfoClient({ connection: conn });
      const registryClient = new RegistryClient({
        source: { kind: "local", path: cfg.registryPath },
      });
      const chainInventory = new ChainInventory({ registry: registryClient, ownerInfo: ownerInfoClient });
      app.decorate("chainInventory", chainInventory);
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