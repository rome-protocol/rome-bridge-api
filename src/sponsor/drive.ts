import type { TickResult } from "./bridge-sponsor.js";

export interface DrivePendingDeps {
  /** All pending transfer ids (GET /v1/transfers/pending on the server). */
  listPendingIds: () => Promise<string[]>;
  /** Advance one ready sponsor step for a transfer. */
  tickOnce: (transferId: string) => Promise<TickResult>;
  warn?: ((msg: string) => void) | undefined;
  /**
   * Hard wall-clock cap per tick. The drive loop's no-overlap guard only
   * clears when the pass promise SETTLES — one unbounded await inside a tick
   * (Solana RPC calls carry no timeout of their own) would otherwise wedge the
   * worker forever: process alive, health green, zero passes. A timed-out tick
   * forfeits its turn (its Solana effects are on-chain-idempotent: ATA create
   * is idempotent, receive is nonce-guarded, settle is replay-guarded).
   */
  tickTimeoutMs?: number | undefined;
}

const DEFAULT_TICK_TIMEOUT_MS = 90_000;

function withTickTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tick timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * One sponsor drive pass: fetch every pending transfer id and tickOnce each.
 * tickOnce advances ONE ready step per call, so successive passes walk a transfer
 * ensure-ata → cctp-receive-message → settle as the attestation poller marks each
 * next step ready. Per-id failures are isolated + warned, and per-id TIME is
 * bounded, so one stuck transfer never stalls (or wedges) the rest of the queue.
 */
export async function drivePending(deps: DrivePendingDeps): Promise<{ processed: number; acted: number; durationMs: number }> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const tickTimeoutMs = deps.tickTimeoutMs ?? DEFAULT_TICK_TIMEOUT_MS;
  const t0 = Date.now();
  const ids = await deps.listPendingIds();
  let acted = 0;
  for (const id of ids) {
    try {
      const r = await withTickTimeout(deps.tickOnce(id), tickTimeoutMs);
      if (r.acted) acted++;
    } catch (err) {
      warn(`[sponsor] tickOnce ${id} failed: ${(err as Error).message}`);
    }
  }
  return { processed: ids.length, acted, durationMs: Date.now() - t0 };
}
