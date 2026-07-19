import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server";
import { writePublishedChain } from "../helpers/chains";

let app: Awaited<ReturnType<typeof buildApp>>;
const simulateTx = vi.fn();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  writePublishedChain(dir, "121301-simtest", {
    chain: { chainId: 121301, name: "Marcus", network: "devnet", status: "live", rpcUrl: "https://marcus.invalid", romeEvmProgramId: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8", solana: { cluster: "devnet" } },
    bridge: {
      cctpIrisApiBase: "https://iris-api-sandbox.circle.com",
      sourceEvm: { chainId: 11155111, name: "Sepolia", cctpVersion: 2, cctpDomain: 0, cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", cctpTokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" },
      solana: { cctpDomain: 5 },
      assets: [{ id: "usdc", symbol: "USDC", solanaMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", sourceEvm: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", protocol: "cctp" } }],
    },
    tokens: [{ kind: "gas", mintId: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", gasPool: "AkZ6NSKzoM6Q3TqVwgtCixpjBDRqEhs5YTZxYzX6s2Jt", symbol: "USDC" }],
  });
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
  (app as never as { decorate: (k: string, v: unknown) => void }).decorate("evmPool", { readTx: vi.fn(), simulateTx });
});
afterAll(async () => { await app.close(); });

const payload = (over: Record<string, unknown> = {}) => ({
  asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301", amount: "1000000",
  sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
  recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
  ...over,
});

describe("quote fee/eta surface", () => {
  it("every quote carries the zero-protocol-fee guarantee + the observed-percentile ETA hook", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/quote", payload: payload() });
    const q = res.json();
    expect(q.protocolFee).toBe("0");
    expect(q.etaP90Seconds).toBeNull(); // hook present; populated once observed data exists
  });
});

describe("simulate: true — read-only preflight of step-1 txs", () => {
  it("attaches per-tx simulation results via the per-source client pool", async () => {
    simulateTx.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true });
    const res = await app.inject({ method: "POST", url: "/v1/quote", payload: payload({ simulate: true }) });
    const q = res.json();
    expect(simulateTx).toHaveBeenCalledTimes(2); // approve + depositForBurn
    expect(simulateTx.mock.calls[0]![1]).toMatchObject({ from: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" });
    expect(q.steps[0].unsignedTxs[0].simulation).toEqual({ ok: true });
    expect(q.steps[0].unsignedTxs[1].simulation).toEqual({ ok: true });
  });

  it("surfaces revert reasons (catches approve/balance failures before the wallet opens)", async () => {
    simulateTx.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, revertReason: "ERC20: transfer amount exceeds balance" });
    const res = await app.inject({ method: "POST", url: "/v1/quote", payload: payload({ simulate: true }) });
    const q = res.json();
    expect(q.steps[0].unsignedTxs[1].simulation).toEqual({ ok: false, revertReason: "ERC20: transfer amount exceeds balance" });
  });

  it("simulate omitted → no simulation fields, no pool calls", async () => {
    simulateTx.mockClear();
    const res = await app.inject({ method: "POST", url: "/v1/quote", payload: payload() });
    expect(simulateTx).not.toHaveBeenCalled();
    expect(res.json().steps[0].unsignedTxs[0].simulation).toBeUndefined();
  });
});
