import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server";
import { writePublishedChain } from "../helpers/chains";
import { TransferStore } from "../../src/transfers/store";

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let store: TransferStore;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  writePublishedChain(dir, "121301-ssetest", {
    chain: { chainId: 121301, name: "Marcus", network: "devnet", status: "live", rpcUrl: "https://marcus.invalid", romeEvmProgramId: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8" },
  });
  process.env.BRIDGE_API_USE_IN_MEMORY_REDIS = "1";
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  store = new TransferStore(app.redis);
});
afterAll(async () => { await app.close(); });

async function readFrames(res: Response, wantEvents: number, timeoutMs = 5_000): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while ((buf.match(/^id: /gm)?.length ?? 0) < wantEvents && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
  }
  await reader.cancel();
  return buf;
}

describe("GET /v1/transfers/{id}/events — SSE with Last-Event-ID resume", () => {
  it("streams replayed + live events with stable ids; resume skips delivered frames", async () => {
    const id = await store.create({
      route: "usdc-cctp-to-rome", direction: "to-rome", amountIn: "1", amountOut: "1",
      sender: {}, recipient: "0xabc", outcome: "pending",
      steps: [
        { n: 1, chain: "ethereum", kind: "cctp-approve-and-deposit", status: "submitted" },
        { n: 2, chain: "solana", kind: "cctp-receive-message", status: "blocked" },
      ],
    });

    // First connection: sees the replayed "created" event, then a live step event.
    const ac1 = new AbortController();
    const res1 = await fetch(`${baseUrl}/v1/transfers/${id}/events`, { signal: ac1.signal, headers: { accept: "text/event-stream" } });
    expect(res1.headers.get("content-type")).toMatch(/text\/event-stream/);
    const live = (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await store.updateStep(id, 2, { status: "ready" });
    })();
    const frames1 = await readFrames(res1, 2);
    await live;
    ac1.abort();
    expect(frames1).toMatch(/id: 1\nevent: created/);
    expect(frames1).toMatch(/id: 2\nevent: step\ndata: .*"status":"ready"/);

    // Resume with Last-Event-ID: 1 — only the step event replays, exactly once.
    const ac2 = new AbortController();
    const res2 = await fetch(`${baseUrl}/v1/transfers/${id}/events`, {
      signal: ac2.signal,
      headers: { accept: "text/event-stream", "last-event-id": "1" },
    });
    const frames2 = await readFrames(res2, 1);
    ac2.abort();
    expect(frames2).not.toMatch(/event: created/);
    expect(frames2.match(/^id: 2$/gm)).toHaveLength(1);
  });

  it("404s unknown transfers", async () => {
    const res = await fetch(`${baseUrl}/v1/transfers/txf_nope/events`);
    expect(res.status).toBe(404);
  });
});
