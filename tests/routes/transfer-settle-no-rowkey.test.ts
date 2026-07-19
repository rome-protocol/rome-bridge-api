import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData } from "viem";
import { buildApp } from "../../src/server";
import { writePublishedChain } from "../helpers/chains";

/**
 * when a user settle authorization is submitted but
 * ROW_ENCRYPTION_KEY_BASE64 is NOT provisioned, the API must FAIL CLOSED —
 * refuse to store the signature in plaintext (at-rest encryption),
 * rather than silently downgrade. Same fixture as transfer-settle-sig, minus
 * the row key.
 */
const USER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // hardhat #0
let app: Awaited<ReturnType<typeof buildApp>>;
const readTx = vi.fn();

beforeAll(async () => {
  delete process.env.ROW_ENCRYPTION_KEY_BASE64; // the misconfiguration under test
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  writePublishedChain(dir, "121301-norowkey", {
    chain: { chainId: 121301, name: "Marcus", network: "devnet", status: "live", rpcUrl: "https://marcus.invalid", romeEvmProgramId: "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf", solana: { cluster: "devnet" } },
    bridge: {
      cctpIrisApiBase: "https://iris-api-sandbox.circle.com",
      sourceEvm: { chainId: 11155111, name: "Sepolia", cctpVersion: 2, cctpDomain: 0, cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", cctpTokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" },
      solana: { cctpDomain: 5, cctpMessageTransmitterProgramV2: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC", cctpTokenMessengerMinterProgramV2: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe" },
      assets: [{ id: "usdc", symbol: "USDC", solanaMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", sourceEvm: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", protocol: "cctp" } }],
    },
    tokens: [{ kind: "gas", mintId: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", gasPool: "AkZ6NSKzoM6Q3TqVwgtCixpjBDRqEhs5YTZxYzX6s2Jt", symbol: "USDC" }],
  });
  process.env.BRIDGE_API_USE_IN_MEMORY_REDIS = "1";
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
  (app as never as { decorate: (k: string, v: unknown) => void }).decorate("ethereumReader", { readTx });
});
afterAll(async () => { await app.close(); });

describe("POST /v1/transfers — settle sig with no ROW_ENCRYPTION_KEY (fail-closed)", () => {
  it("refuses a valid sig rather than storing it in plaintext", async () => {
    const qres = await app.inject({ method: "POST", url: "/v1/quote", payload: {
      asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301",
      amount: "1000000", sender: { ethereum: USER.address }, recipient: USER.address,
    }});
    const quote = qres.json();
    const burnTx = "0x" + "ab".repeat(32);
    const expectedTx = quote.steps[0].unsignedTxs.at(-1);
    readTx.mockResolvedValue({ to: expectedTx.to, data: expectedTx.data, value: expectedTx.value });
    const td = quote.signatureRequests[0].typedData;
    const digest = hashTypedData({ ...td, message: { ...td.message, sourceTxHash: burnTx } } as never);
    const sig = await USER.sign({ hash: digest });

    const res = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: burnTx, userSettleSig: sig } });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    // and nothing leaked to Redis
    const keys = await app.redis.keys("bridge:v1:transfer:*");
    for (const k of keys) expect(await app.redis.get(k)).not.toContain(sig.slice(2));
  });

  it("still registers WITHOUT a sig (v1 path needs no row key)", async () => {
    const qres = await app.inject({ method: "POST", url: "/v1/quote", payload: {
      asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301",
      amount: "1000000", sender: { ethereum: USER.address }, recipient: USER.address,
    }});
    const quote = qres.json();
    const burnTx = "0x" + "cd".repeat(32);
    const expectedTx = quote.steps[0].unsignedTxs.at(-1);
    readTx.mockResolvedValue({ to: expectedTx.to, data: expectedTx.data, value: expectedTx.value });
    const res = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: burnTx } });
    expect(res.statusCode).toBe(200);
  });
});
