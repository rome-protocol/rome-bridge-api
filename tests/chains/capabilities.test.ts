import { describe, it, expect } from "vitest";
import { chainCapabilities } from "../../src/chains/capabilities";

describe("chainCapabilities — per-chain rails + constraints (mint-based)", () => {
  it("derives rails, CCTP sources, Wormhole assets; spl is always any-mint", () => {
    const caps = chainCapabilities(
      {
        assets: [
          { symbol: "USDC", solanaMint: "MINT_USDC", sourceEvm: { chainId: 11155111, protocol: "cctp" } },
          { symbol: "USDC", solanaMint: "MINT_USDC", sourceEvm: { chainId: 10143, protocol: "cctp" } },
          { symbol: "ETH", solanaMint: "MINT_ETH", sourceEvm: { chainId: 11155111, protocol: "wormhole" } },
        ],
      },
      { solanaMint: "MINT_USDC", symbol: "USDC" },
    );
    expect(caps.spl).toBe("any-mint");
    expect(caps.gasMint).toEqual({ solanaMint: "MINT_USDC", symbol: "USDC" });
    expect(caps.cctpSourceChainIds).toEqual([11155111, 10143]); // distinct, order-preserved
    expect(caps.wormholeAssets).toEqual([{ symbol: "ETH", solanaMint: "MINT_ETH" }]);
    expect(caps.rails).toEqual(["cctp", "wormhole", "spl-bridge", "native"]);
  });

  it("Solana-only chain (no bridge assets): spl-bridge + native, any-mint still true", () => {
    const caps = chainCapabilities(undefined, { solanaMint: "MINT_GAS", symbol: null });
    expect(caps.rails).toEqual(["spl-bridge", "native"]);
    expect(caps.spl).toBe("any-mint");
    expect(caps.cctpSourceChainIds).toEqual([]);
    expect(caps.wormholeAssets).toEqual([]);
  });
});
