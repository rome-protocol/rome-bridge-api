/**
 * Regression: settle-auth signature recovery must be ESM-safe.
 *
 * The server runs the compiled `dist/` as native ESM (`"type": "module"`), where
 * bare CJS `require()` is undefined. recoverAddressSync originally lazy-
 * required the @noble primitives — invisible under vitest/tsx (which shim
 * require), fatal on the server: every POST /v1/transfers died with
 * "settle authorization invalid: could not recover signer: require is not
 * defined" (live-hit on bridge-api.devnet 2026-07-06, burn 0xf816f0b5…).
 *
 * Two guards:
 *  1. functional — a real secp256k1 signature round-trips through
 *     verifySettleAuthorization (recovers to the signing recipient);
 *  2. tripwire — the module keeps zero bare require() calls, so the ESM
 *     regression can't come back in a form vitest's interop hides.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { hashTypedData, type Hex } from "viem";
import { verifySettleAuthorization } from "../src/cctp/settle-auth.js";
import { settleAuthorizationTypedData, type SettleAuthorizationParams } from "../src/cctp/eip712-settle.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("settle-auth ESM safety", () => {
  it("recovers the recipient from a client-signed SettleAuthorization", async () => {
    const key = generatePrivateKey();
    const recipient = privateKeyToAccount(key);
    const sourceTxHash = ("0x" + "ab".repeat(32)) as Hex;

    const params: SettleAuthorizationParams = {
      romeEvmProgramId: Keypair.generate().publicKey,
      sourceEvmChainId: 11155111n,
      destinationChainId: 200010n,
      mint: Keypair.generate().publicKey,
      amount: 1_000_000n,
      sourceChain: 0n,
      sourceTxHash,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    };
    const digest = hashTypedData(settleAuthorizationTypedData(params));
    const signature = await recipient.sign({ hash: digest });

    const res = verifySettleAuthorization({
      ...params,
      recipient: recipient.address,
      signature,
    });
    expect(res.ok, `verify failed: ${(res as { reason?: string }).reason}`).toBe(true);
  });

  it("keeps settle-auth free of bare require() (server dist is native ESM)", () => {
    const src = readFileSync(join(HERE, "../src/cctp/settle-auth.ts"), "utf8");
    expect(src).not.toMatch(/\brequire\(/);
  });
});
