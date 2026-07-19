import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server";

// After a client submits the deposit via its wallet, it polls this same-origin
// read for confirmation. Pure read of getSignatureStatuses — no keys, no signing.

const dir = mkdtempSync(join(tmpdir(), "registry-"));
let app: Awaited<ReturnType<typeof buildApp>>;

// Table the stub returns, keyed by signature.
const STATUS: Record<string, { confirmationStatus: string | null; err: unknown; slot: number } | null> = {
  CONF: { confirmationStatus: "confirmed", err: null, slot: 285601000 },
  FINAL: { confirmationStatus: "finalized", err: null, slot: 285600900 },
  FAILED: { confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] }, slot: 285601050 },
  UNKNOWN: null,
};

beforeAll(async () => {
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
  (app as unknown as { decorate: (k: string, v: unknown) => void }).decorate("solanaConnection", {
    getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map((s) => STATUS[s] ?? null) }),
  });
});

afterAll(async () => { await app.close(); });

describe("GET /v1/solana/tx", () => {
  it("reports a confirmed tx", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/solana/tx?signature=CONF" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ signature: "CONF", status: "confirmed", err: null, slot: 285601000 });
  });

  it("reports a finalized tx", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/solana/tx?signature=FINAL" });
    expect(res.json().status).toBe("finalized");
  });

  it("surfaces an on-chain failure as err (not a 5xx)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/solana/tx?signature=FAILED" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("confirmed");
    expect(body.err).not.toBeNull();
  });

  it("reports an unseen signature as status:unknown (still pending, not an error)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/solana/tx?signature=UNKNOWN" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("unknown");
  });

  it("400s when signature is missing", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/solana/tx" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("rome.bridge.request-invalid");
  });

  it("503s when no Solana RPC is configured", async () => {
    const bare = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
    const res = await bare.inject({ method: "GET", url: "/v1/solana/tx?signature=CONF" });
    expect(res.statusCode).toBe(503);
    await bare.close();
  });
});
