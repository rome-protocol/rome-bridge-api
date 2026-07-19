import { describe, it, expect, afterAll } from "vitest";
import { buildApp } from "../src/server";

let app: Awaited<ReturnType<typeof buildApp>>;
afterAll(async () => { if (app) await app.close(); });

describe("server lifecycle", () => {
  it("starts a poller and exposes it on the Fastify instance", async () => {
    app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: "/tmp/unused-in-test-env" });
    expect((app as any).attestationPoller).toBeDefined();
  });
});
