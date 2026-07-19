import { describe, it, expect, afterAll } from "vitest";
import { buildApp } from "../../src/server";

const app = await buildApp({
  port: 0,
  env: "test",
  redisUrl: "redis://localhost:6379",
  logLevel: "error",
  registryPath: "/tmp/unused-in-test-env",
});

afterAll(async () => { await app.close(); });

describe("GET /v1/health", () => {
  it("returns 200 with status ok", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.attestation).toMatchObject({
      circle: expect.any(Object),
      wormhole: expect.any(Object),
    });
  });
});
