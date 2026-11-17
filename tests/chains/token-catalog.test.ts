import { describe, it, expect } from "vitest";
import { buildTokenCatalog, registryTokensToInputs, buildTokenList, resolveCanonicalWrapper } from "../../src/chains/token-catalog";

/**
 * The bridge catalog is MINT-KEYED: the SPL mint is the asset identity; wrappers
 * are fungible views over a mint (a mint can have 0/1/N wrappers — the drift).
 * buildTokenCatalog merges the registry-verified set (tokens.json) with the
 * permissionless on-chain factory set (TokenCreated) into one mint-keyed catalog.
 */
describe("buildTokenCatalog — mint-keyed (mint is the identity, wrappers are views)", () => {
  it("keys by mint; registry entries are verified, factory-only entries are not", () => {
    const cat = buildTokenCatalog(
      [{ mint: "MINT_USDC", wrapper: "0xReg_usdc", symbol: "wUSDC", decimals: 6 }],
      [{ mint: "MINT_BSOL", wrapper: "0xFac_bsol", symbol: "bSOL", decimals: 9 }],
    );
    expect(cat.get("MINT_USDC")).toMatchObject({
      mint: "MINT_USDC", verified: true, symbol: "wUSDC", decimals: 6, wrappers: ["0xReg_usdc"],
    });
    expect(cat.get("MINT_BSOL")).toMatchObject({
      mint: "MINT_BSOL", verified: false, symbol: "bSOL", decimals: 9, wrappers: ["0xFac_bsol"],
    });
    expect(cat.size).toBe(2);
  });

  it("merges N wrappers over one mint — registry-canonical first, case-insensitive dedup", () => {
    const cat = buildTokenCatalog(
      [{ mint: "MINT_WETH", wrapper: "0xREGweth", symbol: "wETH", decimals: 8 }],
      [
        { mint: "MINT_WETH", wrapper: "0xFACwethA" },
        { mint: "MINT_WETH", wrapper: "0xregweth" }, // same as registry wrapper, different case → dropped
        { mint: "MINT_WETH", wrapper: "0xFACwethB" },
      ],
    );
    const e = cat.get("MINT_WETH")!;
    expect(e.verified).toBe(true);            // registry presence wins even though factory also has it
    expect(e.wrappers[0]).toBe("0xREGweth");  // canonical (registry) wrapper first
    expect(e.wrappers).toHaveLength(3);        // the case-insensitive duplicate is dropped
    expect(e.wrappers.map((w) => w.toLowerCase())).toEqual(["0xregweth", "0xfacwetha", "0xfacwethb"]);
  });

  it("a mint present in both takes symbol/decimals from the registry (verified source of truth)", () => {
    const cat = buildTokenCatalog(
      [{ mint: "MINT_X", wrapper: "0xreg", symbol: "REG", decimals: 6 }],
      [{ mint: "MINT_X", wrapper: "0xfac", symbol: "FAC", decimals: 9 }],
    );
    const e = cat.get("MINT_X")!;
    expect(e.verified).toBe(true);
    expect(e.symbol).toBe("REG");
    expect(e.decimals).toBe(6);
    expect(e.wrappers).toEqual(["0xreg", "0xfac"]);
  });

  it("registry entry without a wrapper still lists the mint (verified, empty wrappers)", () => {
    const cat = buildTokenCatalog([{ mint: "MINT_GAS", symbol: "USDC", decimals: 6 }], []);
    expect(cat.get("MINT_GAS")).toMatchObject({ mint: "MINT_GAS", verified: true, wrappers: [] });
  });
});

describe("registryTokensToInputs — tokens.json → mint-keyed inputs (real wrappers only)", () => {
  it("maps spl_wrapper + erc20 (real addr + SPL decimals); skips gas (native/sentinel) and mintId-less", () => {
    const inputs = registryTokensToInputs([
      // gas entry: sentinel address 0xeeee, gas-decimals 18 — the mint's SPL wrapper below is the real one.
      { kind: "gas", symbol: "USDC", decimals: 18, mintId: "MINT_USDC", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
      { kind: "spl_wrapper", symbol: "wUSDC", decimals: 6, mintId: "MINT_USDC", address: "0xwusdc" },
      { kind: "spl_wrapper", symbol: "wSOL", decimals: 9, mintId: "MINT_SOL", address: "0xwsol" },
      { kind: "erc20", symbol: "FOO", decimals: 6, mintId: "MINT_FOO", address: "0xfoo" },
      { kind: "spl_wrapper", symbol: "noMint", address: "0xnomint" }, // no mintId → skipped (can't key)
    ]);
    expect(inputs).toEqual([
      { mint: "MINT_USDC", wrapper: "0xwusdc", symbol: "wUSDC", decimals: 6 },
      { mint: "MINT_SOL", wrapper: "0xwsol", symbol: "wSOL", decimals: 9 },
      { mint: "MINT_FOO", wrapper: "0xfoo", symbol: "FOO", decimals: 6 },
    ]);
  });

  it("feeds buildTokenCatalog so the gas mint appears via its real SPL wrapper, not the sentinel", () => {
    const cat = buildTokenCatalog(
      registryTokensToInputs([
        { kind: "gas", symbol: "USDC", decimals: 18, mintId: "MINT_USDC", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
        { kind: "spl_wrapper", symbol: "wUSDC", decimals: 6, mintId: "MINT_USDC", address: "0xwusdc" },
      ]),
      [],
    );
    expect(cat.get("MINT_USDC")).toMatchObject({ verified: true, decimals: 6, wrappers: ["0xwusdc"] });
    expect(cat.get("MINT_USDC")!.wrappers).not.toContain("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  });
});

describe("buildTokenList — tokens.json + factory → sorted, verified-first list", () => {
  it("puts curated (verified) entries first, then merges the factory long-tail", () => {
    const list = buildTokenList(
      [
        { kind: "spl_wrapper", symbol: "wETH", decimals: 8, mintId: "MINT_ETH", address: "0xweth" },
        { kind: "gas", symbol: "USDC", decimals: 18, mintId: "MINT_USDC", address: "0xeee" }, // gas → excluded
      ],
      [
        { mint: "MINT_BSOL", wrapper: "0xbsol", symbol: "bSOL" },
        { mint: "MINT_ETH", wrapper: "0xweth_alt" }, // 2nd wrapper over a verified mint
      ],
    );
    expect(list.map((e) => [e.mint, e.verified])).toEqual([
      ["MINT_ETH", true], // verified first
      ["MINT_BSOL", false], // factory long-tail after
    ]);
    expect(list[0]).toMatchObject({ symbol: "wETH", wrappers: ["0xweth", "0xweth_alt"] }); // canonical first, alt merged
    expect(list[1]).toMatchObject({ symbol: "bSOL", verified: false, wrappers: ["0xbsol"] });
  });
});

describe("resolveCanonicalWrapper — mint → registry-canonical wrapper (mint-first callers)", () => {
  it("returns the registry spl_wrapper for a mint; undefined when unknown", () => {
    const tokens = [
      { kind: "gas", mintId: "MINT_ETH", address: "0xeee", symbol: "ETH", decimals: 18 },
      { kind: "spl_wrapper", mintId: "MINT_ETH", address: "0xweth", symbol: "wETH", decimals: 8 },
    ];
    expect(resolveCanonicalWrapper(tokens, "MINT_ETH")).toBe("0xweth"); // the real wrapper, not the gas sentinel
    expect(resolveCanonicalWrapper(tokens, "MINT_UNKNOWN")).toBeUndefined();
    expect(resolveCanonicalWrapper([], "MINT_ETH")).toBeUndefined();
  });
});

/**
 * The Hadrian H14 tokens.json lists the legacy SOL wrapper (row 3) before the current one (row 4), then two older
 * legacy SOL wrappers (rows 5, 6). The current wrapper must be the canonical one and name the token.
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";
const H14_SOL_ROWS = [
  { kind: "gas", symbol: "USDC", decimals: 18, mintId: "MINT_USDC", address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
  { kind: "spl_wrapper", symbol: "wUSDC", decimals: 6, mintId: "MINT_USDC", address: "0xbce339ba4c3a8de3bb8af1c5539e6ac11da3112d" },
  { kind: "spl_wrapper", symbol: "SOL", decimals: 9, mintId: SOL_MINT, address: "0x2522d86592c431758ece4a76e147eb1cb20e9802", legacy: { replacedBy: "0x800b2965aac6efdcfca13f0c719307760b6780dc", note: "SOL (legacy)" } },
  { kind: "spl_wrapper", symbol: "SOL", decimals: 9, mintId: SOL_MINT, address: "0x800b2965aac6efdcfca13f0c719307760b6780dc" },
  { kind: "spl_wrapper", symbol: "roSOL", decimals: 9, mintId: SOL_MINT, address: "0xad72d881e883bf225a193d86550cccf6b529794b", legacy: { replacedBy: "0x2522d86592c431758ece4a76e147eb1cb20e9802", note: "roSOL (legacy)" } },
  { kind: "spl_wrapper", symbol: "wSOL", decimals: 9, mintId: SOL_MINT, address: "0x39f36444fcb79b3e691544aee2a832ebef54ca9f", legacy: { replacedBy: "0xad72d881e883bf225a193d86550cccf6b529794b", note: "Rome SOL (legacy)" } },
];

describe("legacy wrappers never lead (Hadrian H14 shape)", () => {
  it("the current SOL wrapper is first and names the token; the legacy ones follow in file order", () => {
    const list = buildTokenList(H14_SOL_ROWS, []);
    const sol = list.find((e) => e.mint === SOL_MINT)!;
    expect(sol.wrappers).toEqual([
      "0x800b2965aac6efdcfca13f0c719307760b6780dc",
      "0x2522d86592c431758ece4a76e147eb1cb20e9802",
      "0xad72d881e883bf225a193d86550cccf6b529794b",
      "0x39f36444fcb79b3e691544aee2a832ebef54ca9f",
    ]);
    expect(sol).toMatchObject({ verified: true, symbol: "SOL", decimals: 9 });
  });

  it("Wormhole outbound resolves the current wrapper, in either row order", () => {
    expect(resolveCanonicalWrapper(H14_SOL_ROWS, SOL_MINT)).toBe("0x800b2965aac6efdcfca13f0c719307760b6780dc");
    expect(resolveCanonicalWrapper([...H14_SOL_ROWS].reverse(), SOL_MINT)).toBe("0x800b2965aac6efdcfca13f0c719307760b6780dc");
  });

  it("a mint with only a legacy wrapper keeps it, named by that row", () => {
    const cat = buildTokenCatalog(
      registryTokensToInputs([{ kind: "spl_wrapper", symbol: "wETH", decimals: 8, mintId: "MINT_ETH", address: "0xold", legacy: { replacedBy: "0xnew" } }]),
      [],
    );
    expect(cat.get("MINT_ETH")).toMatchObject({ verified: true, symbol: "wETH", decimals: 8, wrappers: ["0xold"] });
  });

  it("a legacy row does not override the symbol of a current row that comes before it", () => {
    const cat = buildTokenCatalog(
      registryTokensToInputs([
        { kind: "spl_wrapper", symbol: "SOL", decimals: 9, mintId: "M", address: "0xnew" },
        { kind: "spl_wrapper", symbol: "wSOL", decimals: 9, mintId: "M", address: "0xold", legacy: { replacedBy: "0xnew" } },
      ]),
      [],
    );
    expect(cat.get("M")).toMatchObject({ symbol: "SOL", wrappers: ["0xnew", "0xold"] });
  });
});
