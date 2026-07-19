import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server";
import { writePublishedChain } from "../helpers/chains";

// The Solana deposit lane (Rome runs inside Solana → a direct deposit) must be
// ADVERTISED in the matrix, or a client can't offer it. It gates on the
// chain having a Solana cluster; status is always active (a direct on-chain
// deposit has no attestation vendor to be degraded).

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  writePublishedChain(dir, "121301-soltest", {
    chain: { chainId: 121301, name: "Marcus", network: "devnet", status: "live", rpcUrl: "https://marcus.invalid", romeEvmProgramId: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8", solana: { cluster: "devnet" } },
    bridge: { solana: { cctpDomain: 5 }, assets: [{ id: "usdc", symbol: "USDC", solanaMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }] },
    tokens: [{ kind: "gas", mintId: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", gasPool: "AkZ6NSKzoM6Q3TqVwgtCixpjBDRqEhs5YTZxYzX6s2Jt", symbol: "USDC" }],
  });
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
});
afterAll(async () => { await app.close(); });

describe("GET /v1/routes — Solana deposit lane advertised", () => {
  it("emits a SOL to-rome row for a chain with a Solana cluster", async () => {
    const { routes } = (await app.inject({ method: "GET", url: "/v1/routes" })).json();
    const sol = routes.find((r: { asset: string; rail: string; direction: string }) => r.asset === "SOL" && r.rail === "solana" && r.direction === "to-rome");
    expect(sol, "a SOL/solana to-rome row must exist").toBeTruthy();
    expect(sol).toMatchObject({
      asset: "SOL", rail: "solana", direction: "to-rome",
      romeChainId: "121301", decimals: 9, status: "active",
      limits: { min: expect.any(String), max: expect.any(String) },
    });
    expect(sol.sourceChainId).toMatch(/^solana:/); // CAIP-2 for the chain's cluster
  });
});
