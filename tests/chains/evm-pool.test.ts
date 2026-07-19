import { describe, it, expect, vi } from "vitest";
import { EvmClientPool, parseRpcOverrides } from "../../src/chains/evm-pool";
import type { SourceEvmEntry } from "../../src/registry/catalog";

const sepolia: SourceEvmEntry = { chainId: 11155111, name: "Sepolia", rpcUrl: "https://sepolia.example" };
const monad: SourceEvmEntry = { chainId: 10143, name: "Monad Testnet", rpcUrl: "https://monad.example" };

function stubFactory() {
  const built: Array<{ chainId: number; url: string }> = [];
  const txs = new Map<string, { to: string; input: string; value: bigint }>();
  const factory = (chainId: number, rpcUrl: string) => {
    built.push({ chainId, url: rpcUrl });
    return {
      getTransaction: vi.fn(async ({ hash }: { hash: string }) => {
        const tx = txs.get(`${chainId}:${hash}`);
        if (!tx) throw new Error("not found");
        return tx;
      }),
    };
  };
  return { built, txs, factory };
}

describe("EvmClientPool", () => {
  it("builds one client per source chainId and caches it", () => {
    const { built, factory } = stubFactory();
    const pool = new EvmClientPool({ clientFactory: factory });
    const a = pool.clientFor(sepolia);
    const b = pool.clientFor(sepolia);
    const c = pool.clientFor(monad);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(built).toEqual([
      { chainId: 11155111, url: "https://sepolia.example" },
      { chainId: 10143, url: "https://monad.example" },
    ]);
  });

  it("EVM_RPC_URLS_JSON override wins over the catalog rpcUrl", () => {
    const { built, factory } = stubFactory();
    const pool = new EvmClientPool({
      clientFactory: factory,
      rpcOverrides: parseRpcOverrides('{"11155111": ["https://internal-sepolia.example"], "10143": "https://internal-monad.example"}'),
    });
    pool.clientFor(sepolia);
    pool.clientFor(monad);
    expect(built.map((b) => b.url)).toEqual(["https://internal-sepolia.example", "https://internal-monad.example"]);
  });

  it("fails closed when neither catalog rpcUrl nor override exists", () => {
    const pool = new EvmClientPool({ clientFactory: stubFactory().factory });
    expect(() => pool.clientFor({ chainId: 424242 })).toThrow(/no rpc/i);
  });

  it("readTx routes by the entry's chain and normalizes the view; missing tx → null", async () => {
    const { txs, factory } = stubFactory();
    const pool = new EvmClientPool({ clientFactory: factory });
    txs.set("10143:0xabc", { to: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", input: "0xdead", value: 0n });
    const monadTx = await pool.readTx(monad, "0xabc");
    expect(monadTx).toEqual({ to: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA", data: "0xdead", value: "0" });
    // the same hash does NOT resolve via the Sepolia client — no cross-chain bleed
    expect(await pool.readTx(sepolia, "0xabc")).toBeNull();
  });

  it("parseRpcOverrides refuses malformed JSON loudly", () => {
    expect(() => parseRpcOverrides("{oops")).toThrow(/EVM_RPC_URLS_JSON/);
    expect(parseRpcOverrides(undefined)).toBeUndefined();
  });
});
