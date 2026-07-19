import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData } from "viem";
import { buildApp } from "../../src/server";
import { writePublishedChain } from "../helpers/chains";
import { RowCipher } from "../../src/lib/row-crypto";

const ROW_KEY = Buffer.alloc(32, 7).toString("base64");
const USER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // hardhat #0
let app: Awaited<ReturnType<typeof buildApp>>;
const readTx = vi.fn();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "registry-"));
  writePublishedChain(dir, "121301-sigtest", {
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
  process.env.ROW_ENCRYPTION_KEY_BASE64 = ROW_KEY;
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: dir });
  (app as never as { decorate: (k: string, v: unknown) => void }).decorate("ethereumReader", { readTx });
});
afterAll(async () => {
  delete process.env.ROW_ENCRYPTION_KEY_BASE64;
  await app.close();
});

async function quoteAndBurn() {
  const qres = await app.inject({ method: "POST", url: "/v1/quote", payload: {
    asset: "USDC", direction: "to-rome", sourceChain: "ethereum", romeChainId: "121301",
    amount: "1000000", sender: { ethereum: USER.address }, recipient: USER.address,
  }});
  const quote = qres.json();
  const burnTx = "0x" + Math.random().toString(16).slice(2).padEnd(64, "a").slice(0, 64);
  const expectedTx = quote.steps[0].unsignedTxs.at(-1);
  readTx.mockResolvedValue({ to: expectedTx.to, data: expectedTx.data, value: expectedTx.value });
  return { quote, burnTx };
}

async function signSettle(quote: { signatureRequests: Array<{ typedData: never }> }, burnTx: string) {
  const td = quote.signatureRequests[0].typedData as { domain: never; types: never; primaryType: never; message: Record<string, unknown> };
  const digest = hashTypedData({ ...td, message: { ...td.message, sourceTxHash: burnTx } } as never);
  return USER.sign({ hash: digest });
}

describe("POST /v1/transfers — trustless settle sig", () => {
  it("accepts a valid user sig and stores it ENCRYPTED (never plaintext in Redis)", async () => {
    const { quote, burnTx } = await quoteAndBurn();
    const sig = await signSettle(quote, burnTx);
    const res = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: burnTx, userSettleSig: sig } });
    expect(res.statusCode).toBe(200);
    const record = res.json();
    expect(record.settleDeadline).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const raw = await app.redis.get(`bridge:v1:transfer:${record.id}`);
    expect(raw).not.toContain(sig.slice(2)); // ciphertext, not the raw sig
    // and it decrypts back to the exact sig with the row key
    const stored = JSON.parse(raw!).userSettleSig;
    expect(new RowCipher(ROW_KEY).decrypt(stored)).toBe(sig);
  });

  it("rejects a sig that recovers to someone other than the recipient", async () => {
    const { quote, burnTx } = await quoteAndBurn();
    const attacker = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // hardhat #1
    const td = quote.signatureRequests[0].typedData;
    const digest = hashTypedData({ ...td, message: { ...td.message, sourceTxHash: burnTx } } as never);
    const badSig = await attacker.sign({ hash: digest });
    const res = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: burnTx, userSettleSig: badSig } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("rome.bridge.source-tx-mismatch");
  });

  it("still registers WITHOUT a sig (legacy v1 settle path stays open)", async () => {
    const { quote, burnTx } = await quoteAndBurn();
    const res = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: burnTx } });
    expect(res.statusCode).toBe(200);
    expect(res.json().userSettleSig).toBeNull();
  });
});
