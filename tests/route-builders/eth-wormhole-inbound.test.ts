import { describe, it, expect } from "vitest";
import { buildEthWormholeInboundQuote } from "../../src/route-builders/eth-wormhole-inbound";

import { syntheticChain } from "../helpers/chains";

const HADRIAN_CONFIG = syntheticChain({
  chainId: "121301",
  bridge: {
    // Published flat shape: wormholeTokenBridge on the source entry; the
    // wrapped-ETH mint comes from the chain's ETH asset row.
    sourceEvm: { chainId: 11155111, wormholeTokenBridge: "0xDB5492265f6038831E89f495670FF909aDe94bd9" },
    assets: [{ symbol: "ETH", solanaMint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs" }],
    solana: { cctpDomain: 5 },
  },
});
const ROME_PROGRAM_ID = "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8";

describe("buildEthWormholeInboundQuote", () => {
  it("produces 2 steps for wETH inbound (wrapper-only, no Rome claim)", () => {
    const q = buildEthWormholeInboundQuote({
      amount: "1000000000000000000", // 1 ETH
      sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562", solana: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: HADRIAN_CONFIG,
      programId: ROME_PROGRAM_ID,
    });
    expect(q.route).toBe("eth-wormhole-to-rome");
    expect(q.steps).toHaveLength(2);
    expect(q.steps[0]?.chain).toBe("ethereum");
    expect(q.steps[0]?.kind).toBe("wormhole-wrap-and-transfer-eth");
    expect(q.steps[0]?.unsignedTxs).toHaveLength(1);
    expect(q.steps[0]?.unsignedTxs?.[0]?.value).toBe("1000000000000000000"); // ETH is payable, value carries the amount
    expect(q.steps[1]?.chain).toBe("solana");
    expect(q.steps[1]?.kind).toBe("wormhole-complete-transfer-wrapped");
    expect(q.steps[1]?.blockedBy).toContain("step-1");
    expect(q.steps[1]?.blockedBy).toContain("wormhole-vaa");
  });

  it("accepts an EVM-only sender — destination derives from recipient, Solana leg is sponsor-executed", () => {
    const base = {
      amount: "1000000000000000000",
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: HADRIAN_CONFIG,
      programId: ROME_PROGRAM_ID,
    };
    const evmOnly = buildEthWormholeInboundQuote({
      ...base, sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
    });
    const dualWallet = buildEthWormholeInboundQuote({
      ...base, sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562", solana: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA" },
    });
    // sender.solana must not influence the quote: the recipient ATA and the
    // burn calldata are byte-identical with and without it.
    expect(evmOnly.steps[1]?.recipientAta).toBeTruthy();
    expect(evmOnly.steps[1]?.recipientAta).toBe(dualWallet.steps[1]?.recipientAta);
    expect(evmOnly.steps[1]?.recipientPdaOwner).toBe(dualWallet.steps[1]?.recipientPdaOwner);
    expect(evmOnly.steps[0]?.unsignedTxs?.[0]?.data).toBe(dualWallet.steps[0]?.unsignedTxs?.[0]?.data);
  });

  it("rejects missing sender.ethereum", () => {
    expect(() => buildEthWormholeInboundQuote({
      amount: "1000000000000000000", sender: { solana: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: HADRIAN_CONFIG, programId: ROME_PROGRAM_ID,
    })).toThrow(/sender.ethereum/);
  });

  it("rejects when wormhole TokenBridge address not configured", () => {
    const noWormholeChain = { ...HADRIAN_CONFIG, bridge: { ...HADRIAN_CONFIG.bridge, sourceEvm: { chainId: 11155111 } } };
    expect(() => buildEthWormholeInboundQuote({
      amount: "1000000000000000000",
      sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562", solana: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: noWormholeChain, programId: ROME_PROGRAM_ID,
    })).toThrow(/tokenBridge|wormhole/i);
  });
});
