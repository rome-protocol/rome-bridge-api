import { describe, it, expect } from "vitest";
import { mintBytes32ToBase58, factoryEventToInput, fetchFactoryTokens, resolveRegistrationSlot, scanFactoryWindows } from "../../src/chains/token-factory-index";

// The ERC20SPL factory emits TokenCreated(mint: bytes32, wrapper: address, ...).
// The mint is a Solana pubkey as bytes32; the catalog keys on base58 (matching
// registry tokens.json), so the index must convert. Known mappings verified
// on-chain earlier (cast mint_id + base58 decode).
describe("mintBytes32ToBase58 — Solana pubkey bytes32 → base58", () => {
  const cases: [string, string][] = [
    ["0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001", "So11111111111111111111111111111111111111112"],
    ["0x4de5b3fa1e6c00708f7ff480e2186357da3bc7110c576e9364da84c4c77ad904", "6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs"],
    ["0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7", "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"],
  ];
  it.each(cases)("%s → %s", (hex, base58) => {
    expect(mintBytes32ToBase58(hex)).toBe(base58);
  });
});

describe("factoryEventToInput — TokenCreated → mint-keyed FactoryTokenInput", () => {
  it("converts mint to base58 and keeps the wrapper; drops empty symbol", () => {
    expect(factoryEventToInput({
      mint: "0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001",
      wrapper: "0xWrapSol", symbol: "wSOL",
    })).toEqual({ mint: "So11111111111111111111111111111111111111112", wrapper: "0xWrapSol", symbol: "wSOL" });

    expect(factoryEventToInput({
      mint: "0x4de5b3fa1e6c00708f7ff480e2186357da3bc7110c576e9364da84c4c77ad904",
      wrapper: "0xWrapEth", symbol: "",
    })).toEqual({ mint: "6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs", wrapper: "0xWrapEth" });
  });
});

describe("fetchFactoryTokens — getLogs(TokenCreated) → inputs (injected client)", () => {
  it("maps every TokenCreated log to a base58-mint input", async () => {
    const fakeClient = {
      getLogs: async () => [
        { args: { mint: "0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001", wrapper: "0xWsol", symbol: "wSOL", name: "Rome SOL" } },
        { args: { mint: "0x4de5b3fa1e6c00708f7ff480e2186357da3bc7110c576e9364da84c4c77ad904", wrapper: "0xWeth", symbol: "wETH", name: "Rome ETH" } },
      ],
    } as unknown as Parameters<typeof fetchFactoryTokens>[0];

    const inputs = await fetchFactoryTokens(fakeClient, "0xFactory");
    expect(inputs).toEqual([
      { mint: "So11111111111111111111111111111111111111112", wrapper: "0xWsol", symbol: "wSOL" },
      { mint: "6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs", wrapper: "0xWeth", symbol: "wETH" },
    ]);
  });
});

describe("resolveRegistrationSlot — binary-search the chain's first block", () => {
  // Rome numbers blocks by Solana slot (~474M) and does NOT support the
  // "earliest" tag, so we find the registration slot = boundary of the
  // all-absent region below the chain's existence.
  it("finds the registration slot in ~log2(range) probes", async () => {
    const R = 472981101n;
    let probes = 0;
    const probe = {
      getBlockNumber: async () => 474394206n,
      blockExists: async (n: bigint) => { probes++; return n >= R; },
    };
    expect(await resolveRegistrationSlot(probe)).toBe(R);
    expect(probes).toBeLessThan(40); // log2(474M) ≈ 29
  });

  it("returns the tip when only the latest block exists", async () => {
    const probe = { getBlockNumber: async () => 100n, blockExists: async (n: bigint) => n >= 100n };
    expect(await resolveRegistrationSlot(probe)).toBe(100n);
  });

  it("ignores a synthetic genesis at block 0 — targets the chain's contiguous region", async () => {
    // Rome's real shape: block 0 exists (synthetic genesis), 1..R-1 absent (the
    // chain didn't exist at those slots), R..latest present. Must return R, not 0.
    const R = 472981101n;
    const probe = {
      getBlockNumber: async () => 474394206n,
      blockExists: async (n: bigint) => n === 0n || n >= R,
    };
    expect(await resolveRegistrationSlot(probe)).toBe(R);
  });
});

describe("scanFactoryWindows — paginated getLogs with halve-on-limit", () => {
  const SOL = "0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001";
  const log = (wrapper: string) => ({ args: { mint: SOL, wrapper } });

  it("covers [from,to] in contiguous, inclusive windows ≤ windowSize", async () => {
    const ranges: Array<[bigint, bigint]> = [];
    const source = { getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => { ranges.push([fromBlock, toBlock]); return []; } };
    await scanFactoryWindows(source as never, "0xF", 0n, 25n, { windowSize: 10n });
    expect(ranges).toEqual([[0n, 9n], [10n, 19n], [20n, 25n]]);
  });

  it("aggregates logs from every window", async () => {
    const source = { getLogs: async ({ fromBlock }: { fromBlock: bigint; toBlock: bigint }) => [log(fromBlock === 0n ? "0xA" : "0xB")] };
    const out = await scanFactoryWindows(source as never, "0xF", 0n, 19n, { windowSize: 10n });
    expect(out.map((t) => t.wrapper)).toEqual(["0xA", "0xB"]);
  });

  it("halves a window that hits the results limit, then collects both halves", async () => {
    const seen: Array<[bigint, bigint]> = [];
    const source = { getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      seen.push([fromBlock, toBlock]);
      if (toBlock - fromBlock > 4n) throw new Error("eth_getLogs returned more than 50000 results");
      return [log(`0x${fromBlock}`)];
    } };
    const out = await scanFactoryWindows(source as never, "0xF", 0n, 9n, { windowSize: 10n });
    expect(seen[0]).toEqual([0n, 9n]);  // full window tried first
    expect(out).toHaveLength(2);        // then split into two sub-windows that succeed
  });

  it("rethrows a non-range error on a single block (no infinite split)", async () => {
    const source = { getLogs: async () => { throw new Error("connection refused"); } };
    await expect(scanFactoryWindows(source as never, "0xF", 5n, 5n, { windowSize: 10n })).rejects.toThrow(/connection refused/);
  });
});
