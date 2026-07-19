import { describe, it, expect } from "vitest";
import { decodeFunctionData, parseAbi } from "viem";
import { buildEthWormholeOutboundQuote } from "../../src/route-builders/eth-wormhole-outbound";

// Live RomeBridgeWithdraw v6 on Hadrian (registry contracts.json). burnUSDC AND
// burnETH live on the SAME v6 contract — so the Wormhole-out builder must resolve
// the burn target via liveContractAddress(chain, "RomeBridgeWithdraw"), exactly
// like the CCTP-out builder, NOT via a phantom bridge.rome.wormholeWithdraw key
// (which is not part of the registry bridge.json shape and is never populated).
const LIVE_WITHDRAW = "0x9975fe4b721bf52f2a5bcc795fa2e29edc50de8b";

const HADRIAN_CONFIG = {
  chainId: "200010", slug: "hadrian", network: "devnet" as const, status: "live" as const,
  contracts: [
    { name: "RomeBridgeWithdraw", versions: [
      { version: "5.0.0", address: "0x8510803f89eda2e5ade77b27ded8a0fb96a3042f", status: "retired" },
      { version: "6.0.0", address: LIVE_WITHDRAW, status: "live" },
    ] },
  ],
  bridge: {
    sourceEvm: {
      chainId: 11155111,
      wormhole: { tokenBridge: "0xDB5492265f6038831E89f495670FF909aDe94bd9" }, // Sepolia (legacy nested)
      wormholeTokenBridge: "0xDB5492265f6038831E89f495670FF909aDe94bd9",       // published flat field
    },
    gasMint: { address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", symbol: "USDC", decimals: 6 },
    assets: [{ id: "eth", symbol: "ETH", decimals: 8, solanaMint: "6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs", sourceEvm: { address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", protocol: "wormhole" } }],
  },
  // The 8-dec wETH spl_wrapper burnETH actually pulls — distinct from 18-dec route amounts.
  tokens: [
    { kind: "gas", assetRef: "usdc", symbol: "USDC", decimals: 6, address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", mintId: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
    { kind: "spl_wrapper", assetRef: "eth", symbol: "wETH", decimals: 8, address: "0x8c2c1486cadf7d07312908a065f14af65f56be7e", mintId: "6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs" },
  ],
} as any;
const ROME_PROGRAM_ID = "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf";

const senderRecipient = {
  sender: { rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562", ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
  recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
};

describe("buildEthWormholeOutboundQuote", () => {
  it("produces 2 steps: rome [approve, burn] as ONE user step → ethereum claim", () => {
    // approve+burn are one STEP (two txs) so registration's step1TxHash binds
    // the BURN — the spec verifies the LAST unsignedTx of step 1, and the burn is
    // the tx the VAA (and the poller's wormholescan lookup) hangs off.
    const q = buildEthWormholeOutboundQuote({
      amount: "1000000000000000000", ...senderRecipient,
      chain: HADRIAN_CONFIG, programId: ROME_PROGRAM_ID,
    });
    expect(q.route).toBe("eth-wormhole-from-rome");
    // burnToken = the wETH wrapper (8-dec on-chain), NOT native gas or the 18-dec
    // route scale. A client reads balanceOf(burnToken) + gates on burnAmount so a
    // 1.0-ETH entry against a 0.1-wETH balance never reaches MetaMask (the burn
    // would revert → MetaMask shows a garbage "Unavailable" fee).
    expect((q as { burnToken?: string }).burnToken).toBe("0x8c2c1486cadf7d07312908a065f14af65f56be7e");
    expect((q as { burnTokenDecimals?: number }).burnTokenDecimals).toBe(8);
    // 1e18 wei ÷ 10^(18-8) = 1e8 in 8-dec wETH.
    expect((q as { burnAmount?: string }).burnAmount).toBe("100000000");
    expect(q.steps).toHaveLength(2);
    expect(q.steps[0]?.chain).toMatch(/^rome-/);
    expect(q.steps[0]?.kind).toBe("wormhole-burn-eth");
    expect(q.steps[0]?.userSigns).toBe(true);
    expect(q.steps[0]?.unsignedTxs).toHaveLength(2); // [approveBurnETH, burnETH]
    expect(q.steps[1]?.chain).toBe("ethereum");
    expect(q.steps[1]?.kind).toBe("wormhole-claim-on-ethereum");
    expect(q.steps[1]?.blockedBy).toContain("step-1");
    expect(q.steps[1]?.blockedBy).toContain("wormhole-vaa");
  });

  it("stamps the claim step with the destination token bridge + unwrap method", () => {
    const q = buildEthWormholeOutboundQuote({
      amount: "1000000000000000000", ...senderRecipient,
      chain: HADRIAN_CONFIG, programId: ROME_PROGRAM_ID,
    });
    const claim = q.steps[1]!;
    expect(claim.claimTokenBridge).toBe("0xDB5492265f6038831E89f495670FF909aDe94bd9");
    // ETH route: the destination asset is native ETH held in the bridge —
    // redeem-and-unwrap, not the ERC20-emitting completeTransfer.
    expect(claim.claimMethod).toBe("completeTransferAndUnwrapETH");
  });

  it("resolves the burn target from the live RomeBridgeWithdraw contract", () => {
    const q = buildEthWormholeOutboundQuote({
      amount: "1000000000000000000", ...senderRecipient,
      chain: HADRIAN_CONFIG, programId: ROME_PROGRAM_ID,
    });
    expect(q.steps[0]?.unsignedTxs?.[0]?.to?.toLowerCase()).toBe(LIVE_WITHDRAW);
    expect(q.steps[0]?.unsignedTxs?.[1]?.to?.toLowerCase()).toBe(LIVE_WITHDRAW);
  });

  it("throws when no live RomeBridgeWithdraw is published", () => {
    const noContract = { ...HADRIAN_CONFIG, contracts: [] } as any;
    expect(() => buildEthWormholeOutboundQuote({
      amount: "1000000000000000000", ...senderRecipient,
      chain: noContract, programId: ROME_PROGRAM_ID,
    })).toThrow(/RomeBridgeWithdraw/);
  });

  it("rejects missing sender.rome", () => {
    expect(() => buildEthWormholeOutboundQuote({
      amount: "1000000000000000000", sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: HADRIAN_CONFIG, programId: ROME_PROGRAM_ID,
    })).toThrow(/sender.rome/);
  });

  // The API amount unit is 18-dec wei (ROUTE_SPECS), but the on-chain burn unit
  // is the wETH WRAPPER's decimals (8 — Wormhole normalizes transfer amounts to
  // 8 dp; the wrapper mirrors the wrapped mint). Emitting wei into burnETH
  // calldata would burn 10^10× the intent.
  describe("wrapper-unit conversion", () => {
    const ABI = parseAbi([
      "function approveBurnETH(uint256 amount)",
      "function burnETH(uint256 amount, address recipient)",
    ]);
    const decodedAmounts = (q: ReturnType<typeof buildEthWormholeOutboundQuote>) => {
      const approve = decodeFunctionData({ abi: ABI, data: q.steps[0]!.unsignedTxs![0]!.data as `0x${string}` });
      const burn = decodeFunctionData({ abi: ABI, data: q.steps[0]!.unsignedTxs![1]!.data as `0x${string}` });
      return { approve: approve.args![0], burn: burn.args![0] };
    };

    it("encodes approve+burn amounts in 8-dec wrapper units, not wei (default when no asset row)", () => {
      const q = buildEthWormholeOutboundQuote({
        amount: "1000000000000000", ...senderRecipient, // 0.001 ETH in wei
        chain: HADRIAN_CONFIG, programId: ROME_PROGRAM_ID,
      });
      expect(decodedAmounts(q)).toEqual({ approve: 100000n, burn: 100000n }); // 0.001 at 8 dp
      expect(q.amountIn).toBe("1000000000000000");  // API units stay wei
      expect(q.amountOut).toBe("1000000000000000");
    });

    it("honors the registry ETH asset row's decimals when present", () => {
      const withAssets = {
        ...HADRIAN_CONFIG,
        bridge: {
          ...HADRIAN_CONFIG.bridge,
          assets: [{ id: "eth", symbol: "ETH", decimals: 6, solanaMint: "6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs", sourceEvm: { address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", protocol: "wormhole" } }],
        },
      } as never;
      const q = buildEthWormholeOutboundQuote({
        amount: "1000000000000000", ...senderRecipient,
        chain: withAssets, programId: ROME_PROGRAM_ID,
      });
      expect(decodedAmounts(q)).toEqual({ approve: 1000n, burn: 1000n }); // 0.001 at 6 dp
    });

    it("rejects amounts with dust below the wrapper granularity", () => {
      expect(() => buildEthWormholeOutboundQuote({
        amount: "1000000000000001", ...senderRecipient, // 0.001 ETH + 1 wei
        chain: HADRIAN_CONFIG, programId: ROME_PROGRAM_ID,
      })).toThrow(/granularity|multiple/i);
    });
  });
});
