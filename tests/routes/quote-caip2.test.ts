import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server";
import { writePublishedChain } from "../helpers/chains";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  writePublishedChain(dir, "121301-caiptest", {
    chain: { chainId: 121301, name: "Marcus", network: "devnet", status: "live", rpcUrl: "https://marcus.invalid", romeEvmProgramId: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8", solana: { cluster: "devnet" } },
    bridge: {
      cctpIrisApiBase: "https://iris-api-sandbox.circle.com",
      sourceEvm: { chainId: 11155111, name: "Sepolia", cctpVersion: 2, cctpDomain: 0, cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", cctpTokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" },
      sourceEvms: [{ chainId: 10143, name: "Monad Testnet", cctpVersion: 2, cctpDomain: 15, cctpTokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", cctpTokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" }],
      solana: { cctpDomain: 5 },
      assets: [
        { id: "usdc", symbol: "USDC", solanaMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", sourceEvm: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", protocol: "cctp" } },
        { id: "usdc-monad", symbol: "USDC", solanaMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", sourceEvm: { chainId: 10143, address: "0x534b2f3A21130d7a60830c2Df862319e593943A3", protocol: "cctp", cctpVersion: 2 } },
      ],
    },
    tokens: [{ kind: "gas", mintId: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", gasPool: "AkZ6NSKzoM6Q3TqVwgtCixpjBDRqEhs5YTZxYzX6s2Jt", symbol: "USDC" }],
  });
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
});
afterAll(async () => { await app.close(); });

const payload = (over: Record<string, unknown>) => ({
  asset: "USDC", direction: "to-rome", romeChainId: "121301", amount: "1000000",
  sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
  recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
  ...over,
});

describe("POST /v1/quote — CAIP-2 dual-accept", () => {
  it("accepts a CAIP-2 sourceChain, implies the source, emits CAIP-2 alongside legacy labels — no Sunset header", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/quote", payload: payload({ sourceChain: "eip155:10143" }) });
    expect(res.statusCode).toBe(200);
    expect(res.headers.sunset).toBeUndefined();
    const q = res.json();
    expect(q.sourceChainId).toBe(10143);
    expect(q.sourceChainRef).toBe("eip155:10143");
    expect(q.steps[0].chain).toBe("evm-10143");        // legacy label unchanged (store index compat)
    expect(q.steps[0].chainRef).toBe("eip155:10143");  // CAIP-2 alongside
    expect(q.steps[0].chainName).toBe("Monad Testnet");
    expect(q.steps[1].chainRef).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"); // ensure-ata
    expect(q.steps[2].chainRef).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"); // receive
    expect(q.steps[3].chainRef).toBe("eip155:121301");
    expect(q.steps[3].chainName).toBe("Marcus");
  });

  it("legacy symbolic sourceChain still works and carries the Sunset header", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/quote", payload: payload({ sourceChain: "ethereum" }) });
    expect(res.statusCode).toBe(200);
    expect(res.headers.sunset).toMatch(/2026/);
    expect(res.json().sourceChainRef).toBe("eip155:11155111");
  });

  it("both request styles produce byte-identical step labels — the transfers natural key can never fork", async () => {
    const a = await app.inject({ method: "POST", url: "/v1/quote", payload: payload({ sourceChain: "ethereum" }) });
    const b = await app.inject({ method: "POST", url: "/v1/quote", payload: payload({ sourceChain: "eip155:11155111" }) });
    expect(a.json().steps[0].chain).toBe(b.json().steps[0].chain);
    expect(a.json().steps[0].unsignedTxs[1].data).toBe(b.json().steps[0].unsignedTxs[1].data);
  });

  it("conflicting sourceChain vs sourceChainId → 400 source-chain-conflict", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/quote", payload: payload({ sourceChain: "eip155:10143", sourceChainId: 84532 }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("rome.bridge.source-chain-conflict");
  });

  it("unsupported namespaces are refused cleanly", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/quote", payload: payload({ sourceChain: "cosmos:hub-4" }) });
    expect(res.statusCode).toBe(400);
  });
});
