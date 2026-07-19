import { FastifyInstance } from "fastify";
import packageJson from "../../package.json" with { type: "json" };
import { Config } from "../config.js";
import { RegistryClient } from "../registry/client.js";
import { CachedRegistry } from "../registry/cache.js";
import { mergedCatalog } from "../registry/catalog.js";
import { caip2ForEvm } from "../lib/caip2.js";
import { WORKER_HEARTBEAT_KEY, type WorkerHeartbeatT } from "./worker.js";

interface EvmPoolPing {
  pingChainId?(entry: { chainId: number; rpcUrl?: string | undefined; name?: string | undefined }): Promise<{ ok: boolean }>;
}

export async function healthRoutes(app: FastifyInstance, cfg: Config) {
  const registry = new CachedRegistry(new RegistryClient({ source: { kind: "local", path: cfg.registryPath } }), 60_000);

  app.get("/health", async () => {
    // Per-source rpc status from the client pool — public-safe (no queue
    // depths, no throughput; those would help an abuser time spam).
    const sources: Record<string, { rpc: "ok" | "error" }> = {};
    const pool = (app as unknown as { evmPool?: EvmPoolPing }).evmPool;
    if (pool?.pingChainId) {
      try {
        for (const chain of await registry.listChains()) {
          for (const entry of mergedCatalog(chain.bridge)) {
            const key = caip2ForEvm(entry.chainId);
            if (key in sources) continue;
            const r = await pool.pingChainId(entry);
            sources[key] = { rpc: r.ok ? "ok" : "error" };
          }
        }
      } catch {
        // registry unreadable — health stays serviceable without sources
      }
    }

    // Real poller telemetry: age of the last successful vendor fetch from the
    // in-process poller's shared health object (null until the first success —
    // informational only, never degrades: with zero in-flight transfers there
    // is legitimately nothing to fetch).
    const att = (app as unknown as { attestationHealth?: import("./routes-matrix.js").AttestationHealth }).attestationHealth;
    const ageSeconds = (at: number | null | undefined) =>
      at === null || at === undefined ? null : Math.round((Date.now() - at) / 1000);

    // Worker liveness from the drive-pass heartbeat. With a worker configured
    // (WORKER_INTERNAL_TOKEN set), no/stale heartbeat degrades overall status —
    // a server without its sponsor silently strands every inbound transfer.
    const WORKER_STALE_AFTER_SECONDS = 60; // 12 missed 5s passes
    // A drained fee-payer stalls every transfer with only warn-spam (T2#9):
    // when the heartbeat reports the sponsor balance, gate on this floor.
    const MIN_SPONSOR_LAMPORTS = Number(process.env.WORKER_MIN_SPONSOR_LAMPORTS ?? 50_000_000); // 0.05 SOL
    let worker: {
      status: "ok" | "stale" | "missing" | "unknown";
      lastPassAgeSeconds: number | null;
      lastPass?: { processed: number; acted: number; durationMs: number };
      sponsorLamports?: number;
      sponsorBalanceOk?: boolean;
    };
    const rawBeat = await app.redis.get(WORKER_HEARTBEAT_KEY).catch(() => null);
    if (rawBeat) {
      try {
        const beat = JSON.parse(rawBeat) as WorkerHeartbeatT;
        const age = ageSeconds(beat.ts)!;
        worker = {
          status: age <= WORKER_STALE_AFTER_SECONDS ? "ok" : "stale",
          lastPassAgeSeconds: age,
          lastPass: { processed: beat.processed, acted: beat.acted, durationMs: beat.durationMs },
          ...(typeof beat.sponsorLamports === "number"
            ? { sponsorLamports: beat.sponsorLamports, sponsorBalanceOk: beat.sponsorLamports >= MIN_SPONSOR_LAMPORTS }
            : {}),
        };
      } catch {
        worker = { status: process.env.WORKER_INTERNAL_TOKEN ? "missing" : "unknown", lastPassAgeSeconds: null };
      }
    } else {
      worker = { status: process.env.WORKER_INTERNAL_TOKEN ? "missing" : "unknown", lastPassAgeSeconds: null };
    }
    const degraded = worker.status === "stale" || worker.status === "missing" || worker.sponsorBalanceOk === false;

    return {
      status: degraded ? "degraded" : "ok",
      version: packageJson.version,
      attestation: {
        circle:   { status: "ok", lastFetchAgeSeconds: ageSeconds(att?.circle.lastSuccessAt ?? null), upstream: "iris-api.circle.com" },
        wormhole: { status: "ok", lastFetchAgeSeconds: ageSeconds(att?.wormhole.lastSuccessAt ?? null), upstream: "api.wormholescan.io" },
      },
      worker,
      ...(Object.keys(sources).length ? { sources } : {}),
    };
  });
}
