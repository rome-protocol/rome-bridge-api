/**
 * drivePending — one sponsor drive pass: fetch all pending ids and tickOnce each
 * (one ready step per tick). Per-id failures are isolated so one bad transfer
 * never stalls the rest. This is the loop the worker was missing (v1.0.1 stub).
 */
import { describe, it, expect, vi } from "vitest";
import { drivePending } from "../../src/sponsor/drive.js";

describe("drivePending — worker settle drive loop", () => {
  it("calls tickOnce for every pending id", async () => {
    const tickOnce = vi.fn().mockResolvedValue({ acted: true });
    const r = await drivePending({ listPendingIds: async () => ["a", "b", "c"], tickOnce });
    expect(tickOnce.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
    expect(r).toMatchObject({ processed: 3, acted: 3 });
    expect(typeof r.durationMs).toBe("number");
  });

  it("isolates a per-id tickOnce failure — the others still run", async () => {
    const tickOnce = vi.fn()
      .mockResolvedValueOnce({ acted: true })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ acted: false, reason: "no ready sponsor step" });
    const warn = vi.fn();
    const r = await drivePending({ listPendingIds: async () => ["a", "b", "c"], tickOnce, warn });
    expect(tickOnce).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ processed: 3, acted: 1 });
  });

  it("no pending ids → no ticks", async () => {
    const tickOnce = vi.fn();
    const r = await drivePending({ listPendingIds: async () => [], tickOnce });
    expect(tickOnce).not.toHaveBeenCalled();
    expect(r).toMatchObject({ processed: 0, acted: 0 });
  });

  it("a HUNG tickOnce is bounded by tickTimeoutMs — the pass always settles (wedge-proof)", async () => {
    // The failure this closes: the worker's setInterval guards with a `driving`
    // flag that only clears when the pass promise SETTLES. One unbounded await
    // inside a tick (Solana RPC calls have no timeout) hangs the pass forever:
    // process alive, health green, zero passes ever again.
    const never = new Promise<never>(() => {});
    const tickOnce = vi.fn()
      .mockReturnValueOnce(never)                       // "a" hangs forever
      .mockResolvedValueOnce({ acted: true });          // "b" still runs
    const warn = vi.fn();
    const r = await drivePending({ listPendingIds: async () => ["a", "b"], tickOnce, warn, tickTimeoutMs: 50 });
    expect(r).toMatchObject({ processed: 2, acted: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/timed out after 50ms/));
  });
});
