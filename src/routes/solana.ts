import { FastifyInstance } from "fastify";
import { Config } from "../config.js";
import { bridgeError } from "../errors.js";

interface SigStatus { confirmationStatus: string | null; err: unknown; slot: number }
interface SolanaConn {
  getLatestBlockhash(commitment?: string): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getSignatureStatuses(sigs: string[], cfg?: { searchTransactionHistory?: boolean }): Promise<{ value: Array<SigStatus | null> }>;
}

/**
 * Same-origin Solana reads for browser clients.
 *
 * Rome EVM runs inside a Solana program, so a Solana→Rome "bridge" is a plain
 * on-chain deposit: the user's wallet-signed tx calls the rome-evm deposit
 * instruction, which credits their EVM balance atomically. A browser client
 * that can't reach a Solana RPC directly reads a
 * fresh blockhash here, sets it on the tx, and hands the tx to the wallet to
 * sign and submit over the wallet's own connection. These endpoints are pure
 * reads: no keys, no signing — consistent with the service's read-only posture.
 */
export async function solanaRoutes(app: FastifyInstance, _cfg: Config) {
  function conn(): SolanaConn | null {
    if (!app.hasDecorator("solanaConnection")) return null;
    return (app as unknown as { solanaConnection: SolanaConn | null }).solanaConnection ?? null;
  }

  app.get("/solana/latest-blockhash", async (_req, reply) => {
    const c = conn();
    if (!c) {
      const err = bridgeError("rome.bridge.upstream-unavailable", "Solana RPC is not configured on this deployment");
      reply.status(err.status);
      return { ...err };
    }
    try {
      const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
      return { blockhash, lastValidBlockHeight };
    } catch {
      const err = bridgeError("rome.bridge.upstream-unavailable", "could not fetch a Solana blockhash from the upstream RPC");
      reply.status(err.status);
      return { ...err };
    }
  });

  // Confirmation poll for a submitted deposit signature. status:"unknown" means
  // "not seen yet" (still pending) — NOT an error; a client keeps polling. An
  // on-chain failure rides through as a non-null `err` on a 200, never a 5xx —
  // the request succeeded, the tx is what failed.
  app.get<{ Querystring: { signature?: string } }>("/solana/tx", async (req, reply) => {
    const signature = req.query.signature;
    if (!signature || typeof signature !== "string") {
      const err = bridgeError("rome.bridge.request-invalid", "query param 'signature' is required");
      reply.status(err.status);
      return { ...err };
    }
    const c = conn();
    if (!c) {
      const err = bridgeError("rome.bridge.upstream-unavailable", "Solana RPC is not configured on this deployment");
      reply.status(err.status);
      return { ...err };
    }
    try {
      const { value } = await c.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const st = value[0];
      if (!st) return { signature, status: "unknown", err: null };
      return { signature, status: st.confirmationStatus ?? "unknown", err: st.err ?? null, slot: st.slot };
    } catch {
      const err = bridgeError("rome.bridge.upstream-unavailable", "could not read the Solana signature status");
      reply.status(err.status);
      return { ...err };
    }
  });
}
