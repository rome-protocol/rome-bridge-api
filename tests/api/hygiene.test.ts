import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server";
import { writePublishedChain } from "../helpers/chains";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  writePublishedChain(dir, "121301-hygtest", {
    chain: { chainId: 121301, name: "Marcus", network: "devnet", status: "live", rpcUrl: "https://marcus.invalid", romeEvmProgramId: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8" },
  });
  process.env.BRIDGE_RATE_LIMIT_READ_PER_MIN = "5"; // tiny window so the test trips it fast
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
});
afterAll(async () => {
  delete process.env.BRIDGE_RATE_LIMIT_READ_PER_MIN;
  await app.close();
});

describe("Rome-Request-Id echo (support/debugging currency)", () => {
  it("echoes an inbound id and generates one otherwise", async () => {
    const echoed = await app.inject({ method: "GET", url: "/v1/health", headers: { "rome-request-id": "req-from-caller-123" } });
    expect(echoed.headers["rome-request-id"]).toBe("req-from-caller-123");
    const generated = await app.inject({ method: "GET", url: "/v1/health" });
    expect(generated.headers["rome-request-id"]).toMatch(/[0-9a-f-]{16,}/);
  });

  it("accepts inbound traceparent without breaking the request", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health", headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" } });
    expect(res.statusCode).toBe(200);
  });
});

describe("rate limits — IETF draft headers on every response, 429 + Retry-After on overflow", () => {
  it("emits RateLimit-* on success and rate-limits past the per-minute budget", async () => {
    let tripped: Awaited<ReturnType<typeof app.inject>> | undefined;
    let firstOk: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({ method: "GET", url: "/v1/assets", remoteAddress: "10.9.9.9" });
      if (res.statusCode === 200 && !firstOk) firstOk = res;
      if (res.statusCode === 429) { tripped = res; break; }
    }
    expect(firstOk!.headers["ratelimit-limit"]).toBe("5");
    expect(Number(firstOk!.headers["ratelimit-remaining"])).toBeLessThan(5);
    expect(firstOk!.headers["ratelimit-reset"]).toBeDefined();
    expect(tripped, "429 never tripped").toBeDefined();
    expect(tripped!.headers["retry-after"]).toBeDefined();
    expect(tripped!.json().code).toBe("rome.bridge.rate-limited");
  });

  it("limits are per client ip", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/assets", remoteAddress: "10.7.7.7" });
    expect(res.statusCode).toBe(200); // fresh ip, fresh budget
  });
});

describe("GET /v1/openapi.json — served spec with route conformance", () => {
  it("serves OpenAPI 3.1 with info+paths", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.info.title).toMatch(/bridge/i);
    expect(Object.keys(doc.paths).length).toBeGreaterThanOrEqual(9);
  });

  it("every path in the doc answers non-404 (doc → code)", async () => {
    const doc = (await app.inject({ method: "GET", url: "/v1/openapi.json" })).json();
    for (const [path, ops] of Object.entries<Record<string, unknown>>(doc.paths)) {
      for (const method of Object.keys(ops)) {
        // Internal token-gated routes (x-internal) 404 without the worker token by
        // design — not part of the public reachability contract.
        if (method === "get" && !path.includes("{") && !(ops[method] as { "x-internal"?: boolean })["x-internal"]) {
          const res = await app.inject({ method: "GET", url: `/v1${path}`, remoteAddress: `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
          expect(res.statusCode, `GET /v1${path}`).not.toBe(404);
        }
      }
    }
  });
});
