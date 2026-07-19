import { FastifyInstance } from "fastify";
import { z } from "zod";
import { workerAuthorized } from "../lib/worker-auth.js";

/** Redis key holding the sponsor worker's last drive-pass heartbeat. */
export const WORKER_HEARTBEAT_KEY = "bridge:v1:worker:heartbeat";

const HeartbeatBody = z.object({
  processed: z.number().int().min(0),
  acted: z.number().int().min(0),
  durationMs: z.number().min(0),
  /** Sponsor fee-payer balance at pass time — /health gates on it (T2#9). */
  sponsorLamports: z.number().int().min(0).optional(),
});

export interface WorkerHeartbeatT {
  /** Server-side epoch ms of the report (never trust the worker's clock). */
  ts: number;
  processed: number;
  acted: number;
  durationMs: number;
  sponsorLamports?: number | undefined;
}

/**
 * POST /worker/heartbeat — the sponsor worker reports each drive pass so
 * /health surfaces REAL worker liveness. Closes the deployed-server failure mode
 * where no worker container existed at all yet health said "ok": with
 * WORKER_INTERNAL_TOKEN configured, a missing/stale heartbeat degrades health.
 */
export async function workerRoutes(app: FastifyInstance) {
  app.post("/worker/heartbeat", async (req, reply) => {
    if (!workerAuthorized(req)) { reply.status(404); return { error: "not found" }; }
    const parsed = HeartbeatBody.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: "invalid heartbeat", detail: parsed.error.message };
    }
    const beat: WorkerHeartbeatT = { ts: Date.now(), ...parsed.data };
    await app.redis.set(WORKER_HEARTBEAT_KEY, JSON.stringify(beat));
    return { ok: true };
  });
}
