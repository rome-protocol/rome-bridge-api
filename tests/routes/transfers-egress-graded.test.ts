/**
 * The egress status grading in verify.ts is only worth anything if a caller
 * actually hands it the chain. It is an OPTIONAL 4th parameter, so omitting it
 * compiles, type-checks, and passes every unit test while grading nothing —
 * the failure mode this file exists to prevent.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { FIXTURES_DIR } from "../helpers/chains";

const h = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../../src/transfers/verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/transfers/verify")>();
  return {
    ...actual,
    verifyEvmTxMatchesQuote: (...args: unknown[]) => {
      h.calls.push(args);
      return (actual.verifyEvmTxMatchesQuote as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const { buildApp } = await import("../../src/server");
process.env.BRIDGE_API_USE_IN_MEMORY_REDIS = "1";

const poolReadTx = vi.fn();
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ port: 0, env: "test", redisUrl: "redis://localhost:6379", logLevel: "error", registryPath: FIXTURES_DIR });
  (app as never as { decorate: (k: string, v: unknown) => void }).decorate("evmPool", { readTx: poolReadTx });
});
afterAll(async () => { await app.close(); });

describe("from-rome egress hands the Rome chain to verification", () => {
  it("passes a chain config carrying contracts[], so the target can be graded", async () => {
    const qres = await app.inject({ method: "POST", url: "/v1/quote", payload: {
      asset: "ETH", direction: "from-rome", sourceChain: "ethereum", romeChainId: "200010",
      amount: "1000000000000000",
      sender: { rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    }});
    expect(qres.statusCode).toBe(200);
    const quote = qres.json();
    const burnTx = quote.steps[0].unsignedTxs.at(-1);
    poolReadTx.mockImplementation(async (entry: { chainId: number }) =>
      entry.chainId === 200010 ? { to: burnTx.to, data: burnTx.data, value: burnTx.value } : null);

    h.calls.length = 0;
    const tres = await app.inject({ method: "POST", url: "/v1/transfers", payload: { quote, step1TxHash: "0x" + "2b".repeat(32) } });
    expect(tres.statusCode).toBe(200);

    expect(h.calls.length).toBeGreaterThan(0);
    const chainArg = h.calls[0]?.[3] as { contracts?: unknown[] } | undefined;
    expect(chainArg, "verification was called WITHOUT a chain — grading is dead code").toBeDefined();
    expect(Array.isArray(chainArg?.contracts)).toBe(true);
  });
});
