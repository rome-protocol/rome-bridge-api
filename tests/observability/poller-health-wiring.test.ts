/**
 * The poller and /v1/health MUST share the SAME attestationHealth object.
 *
 * The live bug this pins: buildApp constructed the poller with
 * `app.attestationHealth` at server.ts:~162, but the object was only decorated
 * later inside registerRoutes (server.ts:~222 → routes/index.ts) — so the
 * poller captured `undefined`, never stamped a vendor success, and BOTH
 * consumers stayed blind forever: /v1/health attestation ages read null and
 * /v1/routes live-degradation could never fire (every route perpetually
 * "active"). Health looked green while telemetry was dead.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePublishedChain } from "../helpers/chains";
import { buildApp } from "../../src/server";

const dir = mkdtempSync(join(tmpdir(), "registry-"));
writePublishedChain(dir, "121301-marcus", {
  chain: { chainId: 121301, name: "Marcus", network: "devnet", status: "live", rpcUrl: "https://marcus.invalid", romeEvmProgramId: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8" },
  bridge: {
    sourceEvm: { chainId: 11155111, name: "Sepolia", cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", cctpMessageTransmitter: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD" },
    solana: { cctpDomain: 5 },
    assets: [{ id: "usdc", symbol: "USDC", solanaMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, sourceEvm: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", protocol: "cctp" } }],
  },
  tokens: [{ kind: "gas", mintId: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", gasPool: "AkZ6NSKzoM6Q3TqVwgtCixpjBDRqEhs5YTZxYzX6s2Jt", symbol: "USDC", decimals: 18, address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }],
});
process.env.BRIDGE_API_USE_IN_MEMORY_REDIS = "1";

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
});
afterAll(async () => { await app.close(); });

describe("attestationHealth wiring", () => {
  it("the poller holds the SAME health object /v1/health and /v1/routes read", () => {
    const pollerHealth = (app.attestationPoller as unknown as { health?: unknown }).health;
    expect(pollerHealth).toBeDefined();
    expect(pollerHealth).toBe(
      (app as unknown as { attestationHealth: unknown }).attestationHealth,
    );
  });
});
