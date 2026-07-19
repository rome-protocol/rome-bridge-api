import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { writePublishedChain } from "../helpers/chains";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/server";

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "registry-"));
  writePublishedChain(dir, "121301-marcus", {
    chain: { chainId: 121301, name: "Marcus", network: "devnet", status: "live", rpcUrl: "https://marcus.invalid", romeEvmProgramId: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8" },
    bridge: {
      sourceEvm: { chainId: 11155111, name: "Sepolia", cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", cctpMessageTransmitter: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD" },
      solana: { cctpDomain: 5 },
      assets: [{ id: "usdc", symbol: "USDC", solanaMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, sourceEvm: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", protocol: "cctp" } }],
    },
    tokens: [{ kind: "gas", mintId: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", gasPool: "AkZ6NSKzoM6Q3TqVwgtCixpjBDRqEhs5YTZxYzX6s2Jt", symbol: "USDC", decimals: 18, address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }],
  });
  process.env.REGISTRY_PATH = dir;
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
});
afterAll(async () => { await app.close(); });

describe("POST /v1/quote", () => {
  it("returns a 3-step quote for USDC CCTP inbound to Hadrian", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/quote",
      payload: {
        asset: "USDC", direction: "to-rome",
        sourceChain: "ethereum", romeChainId: "121301",
        amount: "100000000",
        sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
        recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.route).toBe("usdc-cctp-to-rome");
    expect(body.steps).toHaveLength(3);
  });

  it("echoes sender and recipient on the quote response (transfer records index by them)", async () => {
    // POST /v1/transfers copies (quote as any).sender/.recipient into the
    // record, and the store's address index is built from those — a quote
    // that doesn't echo them registers records invisible to
    // GET /v1/transfers?address=.
    const res = await app.inject({
      method: "POST", url: "/v1/quote",
      payload: {
        asset: "USDC", direction: "to-rome",
        sourceChain: "ethereum", romeChainId: "121301",
        amount: "100000000",
        sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
        recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sender).toEqual({ ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" });
    expect(body.recipient).toBe("0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562");
  });

  it("returns 400 + RFC 7807 problem on missing sender.ethereum", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/quote",
      payload: { asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301", amount: "100000000", sender: {}, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "rome.bridge.sender-incomplete" });
  });

  it("types a malformed body as request-invalid, not recipient-invalid (integrators branch on the code)", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/quote", payload: { asset: "USDC" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "rome.bridge.request-invalid", title: "Request invalid" });
  });

  it("returns 400 on amount out of range (0 is below the 1-base-unit floor even on devnet — see amount-floor.test.ts)", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/quote",
      payload: { asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301", amount: "0", sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" }, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("rome.bridge.amount-out-of-range");
  });
});
