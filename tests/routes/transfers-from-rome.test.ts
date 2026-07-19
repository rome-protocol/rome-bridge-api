/**
 * From-rome (non-CCTP) registration parity — audit T1#3 / spec pre-B2.
 *
 * Before this, resolveStamp handled only usdc-cctp*: every other from-rome
 * route fell to the Sepolia-only reader, whose readTx(romeBurnHash) → null →
 * 400 source-tx-not-found. Wormhole egress records could never register, so
 * clients had no tracking and the Rome app Phase B had no outbound path.
 *
 * Now: from-rome wormhole routes verify the burn via the ROME chain's own RPC
 * (registry chain.rpcUrl through the evm pool — the spec equality, binding the
 * burn = the LAST unsignedTx of step 1) and the claim step is stamped with
 * the registry-resolved romeRpcUrl the poller needs for sig resolution.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { FIXTURES_DIR } from "../helpers/chains";
import { buildApp } from "../../src/server";

process.env.BRIDGE_API_USE_IN_MEMORY_REDIS = "1";

const poolReadTx = vi.fn();

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: FIXTURES_DIR });
  (app as never as { decorate: (k: string, v: unknown) => void }).decorate("evmPool", { readTx: poolReadTx });
});
afterAll(async () => { await app.close(); });

describe("POST /v1/transfers — eth-wormhole-from-rome", () => {
  async function quoteWhOut() {
    const qres = await app.inject({ method: "POST", url: "/v1/quote", payload: {
      asset: "ETH", direction: "from-rome", sourceChain: "ethereum", romeChainId: "200010",
      amount: "1000000000000000",
      sender: { rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    }});
    expect(qres.statusCode).toBe(200);
    return qres.json();
  }

  it("registers when the Rome burn matches the quote (verified via the ROME chain RPC)", async () => {
    const quote = await quoteWhOut();
    const burnTx = quote.steps[0].unsignedTxs.at(-1); // the burn — step1TxHash binds it
    poolReadTx.mockImplementation(async (entry: { chainId: number }, _hash: string) => {
      // The verification client must be the ROME chain's (200010), not Sepolia's.
      if (entry.chainId !== 200010) return null;
      return { to: burnTx.to, data: burnTx.data, value: burnTx.value };
    });

    const tres = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: "0x" + "1a".repeat(32) } });
    expect(tres.statusCode).toBe(200);
    const record = tres.json();
    expect(record.route).toBe("eth-wormhole-from-rome");
    const claim = record.steps.find((s: { kind: string }) => s.kind === "wormhole-claim-on-ethereum");
    // Registration stamps the registry-resolved Rome RPC for the poller.
    expect(claim.romeRpcUrl).toBeTruthy();
    expect(claim.claimTokenBridge).toBeTruthy();
  });

  it("rejects a burn that does not match the quote (the spec equality holds on Rome txs too)", async () => {
    const quote = await quoteWhOut();
    poolReadTx.mockResolvedValue({ to: quote.steps[0].unsignedTxs[0].to, data: "0xdeadbeef", value: "0" });
    const tres = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: "0x" + "2b".repeat(32) } });
    expect(tres.statusCode).toBe(400);
    expect(tres.json().code).toBe("rome.bridge.source-tx-mismatch");
  });

  it("404s when the burn is not found on the Rome chain", async () => {
    const quote = await quoteWhOut();
    poolReadTx.mockResolvedValue(null);
    const tres = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: "0x" + "3c".repeat(32) } });
    expect([400, 404]).toContain(tres.statusCode);
    expect(tres.json().code).toBe("rome.bridge.source-tx-not-found");
  });
});
