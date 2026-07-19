import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server";
import { writePublishedChain } from "../helpers/chains";

let app: Awaited<ReturnType<typeof buildApp>>;
const pingChainId = vi.fn();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  writePublishedChain(dir, "121301-healthtest", {
    chain: { chainId: 121301, name: "Marcus", network: "devnet", status: "live", rpcUrl: "https://marcus.invalid", romeEvmProgramId: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8" },
    bridge: {
      cctpIrisApiBase: "https://iris-api-sandbox.circle.com",
      sourceEvm: { chainId: 11155111, name: "Sepolia", rpcUrl: "https://sepolia.example", cctpVersion: 2, cctpDomain: 0, cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", cctpTokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" },
      sourceEvms: [{ chainId: 10143, name: "Monad Testnet", rpcUrl: "https://monad.example", cctpVersion: 2, cctpDomain: 15 }],
      solana: { cctpDomain: 5 },
      assets: [{ id: "usdc", symbol: "USDC", solanaMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", sourceEvm: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", protocol: "cctp" } }],
    },
    tokens: [{ kind: "gas", mintId: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", gasPool: "AkZ6NSKzoM6Q3TqVwgtCixpjBDRqEhs5YTZxYzX6s2Jt", symbol: "USDC" }],
  });
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
  (app as never as { decorate: (k: string, v: unknown) => void }).decorate("evmPool", { readTx: vi.fn(), pingChainId });
});
afterAll(async () => { await app.close(); });

describe("GET /v1/health — per-source rpc status (public-safe)", () => {
  it("reports every catalog source keyed by CAIP-2 with pool-driven status", async () => {
    pingChainId.mockImplementation(async (entry: { chainId: number }) => entry.chainId === 10143 ? { ok: false } : { ok: true });
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    const body = res.json();
    expect(body.sources).toEqual({
      "eip155:11155111": { rpc: "ok" },
      "eip155:10143": { rpc: "error" },
    });
    // public-safe: no queue depths, no throughput
    expect(JSON.stringify(body)).not.toMatch(/queue|depth|throughput/i);
  });
});

describe("quote signatureRequests seam", () => {
  it("gas-mode V2 CCTP inbound carries the user's SettleAuthorization template", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/quote", payload: {
      asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301",
      amount: "1000000", sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    }});
    const reqs = res.json().signatureRequests;
    expect(reqs).toHaveLength(1);
    expect(reqs[0].kind).toBe("settle-authorization-eip712");
    expect(reqs[0].fillFromBurn).toBe("sourceTxHash");
    expect(reqs[0].typedData.primaryType).toBe("SettleAuthorization");
    expect(Number(reqs[0].typedData.message.deadline)).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("wrapper-mode (romeChainId omitted) carries an empty seam — nothing to settle", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/quote", payload: {
      asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301", intent: "wrapper",
      amount: "1000000", sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    }});
    expect(res.json().signatureRequests).toEqual([]);
  });
});
