import { describe, it, expect } from "vitest";
import { decodeFunctionData, parseAbi, pad, getAddress } from "viem";
import { buildTokenWormholeOutboundQuote } from "../../src/route-builders/token-wormhole-outbound";
import type { QuoteInput } from "../../src/route-builders/usdc-cctp-inbound";
import { ROME_BRIDGE_WITHDRAW, syntheticChain } from "../helpers/chains";

const ABI = parseAbi([
  "function approveWormholeBurn(address assetWrapper, uint256 amount)",
  "function burnToWormhole(address assetWrapper, uint256 amount, bytes32 recipient, uint16 targetChain)",
]);
const WMSOL_WRAPPER = "0x1111111111111111111111111111111111111111";
const SENDER = "0x1f4946Be340F06c46A50E65084790968aBcc48F6";
const DEST_EVM = "0x00000000000000000000000000000000000000d1"; // recipient on the L2

const base = (destinationChainId?: number, wrapper?: string): QuoteInput => ({
  amount: "10000000",
  sender: { rome: SENDER },
  recipient: DEST_EVM,
  chain: syntheticChain({ chainId: "200010" }),
  programId: "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf",
  ...(destinationChainId !== undefined ? { destinationChainId } : {}),
  splAsset: { mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", decimals: 9, symbol: "wmSOL", ...(wrapper ? { wrapper } : {}) },
});

describe("generic Wormhole egress (token-wormhole-from-rome)", () => {
  it("emits [approveWormholeBurn, burnToWormhole, wormhole-claim] on RomeBridgeWithdraw, mint-agnostic", () => {
    const q = buildTokenWormholeOutboundQuote(base(11155111, WMSOL_WRAPPER)); // Sepolia
    expect(q.route).toBe("token-wormhole-from-rome");
    expect(q.steps.map((s) => s.kind)).toEqual(["wormhole-burn-token", "wormhole-claim-on-destination"]);
    // Both txs target the live RomeBridgeWithdraw (resolved from registry).
    expect(q.steps[0]!.unsignedTxs![0]!.to.toLowerCase()).toBe(ROME_BRIDGE_WITHDRAW.toLowerCase());
    expect(q.steps[0]!.unsignedTxs![1]!.to.toLowerCase()).toBe(ROME_BRIDGE_WITHDRAW.toLowerCase());
    // approve(wrapper, amount)
    const approve = decodeFunctionData({ abi: ABI, data: q.steps[0]!.unsignedTxs![0]!.data });
    expect(approve.functionName).toBe("approveWormholeBurn");
    expect(getAddress(approve.args[0] as string)).toBe(getAddress(WMSOL_WRAPPER));
    // burn(wrapper, amount, recipient-bytes32, targetChain=Sepolia 10002)
    const burn = decodeFunctionData({ abi: ABI, data: q.steps[0]!.unsignedTxs![1]!.data });
    expect(burn.functionName).toBe("burnToWormhole");
    expect(getAddress(burn.args[0] as string)).toBe(getAddress(WMSOL_WRAPPER));
    expect(burn.args[1]).toBe(10_000_000n);
    expect((burn.args[2] as string).toLowerCase()).toBe(pad(DEST_EVM as `0x${string}`, { size: 32 }).toLowerCase()); // universal addr
    expect(burn.args[3]).toBe(10002); // Wormhole chain id for Sepolia
    // burnToken = the wrapper being approved/burned (so a client shows the
    // bridgeable balance, not gas); decimals + amount ride through for the gate.
    expect((q as { burnToken?: string }).burnToken?.toLowerCase()).toBe(WMSOL_WRAPPER.toLowerCase());
    expect((q as { burnTokenDecimals?: number }).burnTokenDecimals).toBe(9); // wmSOL
    expect((q as { burnAmount?: string }).burnAmount).toBe("10000000");
  });

  it("mint-first: resolves the wrapper from splAsset.mint via the chain's registry tokens (no wrapper supplied)", () => {
    const MINT = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
    const RESOLVED = "0x2222222222222222222222222222222222222222";
    const input: QuoteInput = {
      amount: "10000000",
      sender: { rome: SENDER },
      recipient: DEST_EVM,
      chain: syntheticChain({
        chainId: "200010",
        tokens: [{ kind: "spl_wrapper", mintId: MINT, address: RESOLVED, symbol: "wmSOL", decimals: 9 }],
      }),
      programId: "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf",
      destinationChainId: 11155111,
      splAsset: { mint: MINT, decimals: 9, symbol: "wmSOL" }, // NO wrapper — resolved from the mint
    };
    const q = buildTokenWormholeOutboundQuote(input);
    const approve = decodeFunctionData({ abi: ABI, data: q.steps[0]!.unsignedTxs![0]!.data });
    expect(getAddress(approve.args[0] as string)).toBe(getAddress(RESOLVED));
    const burn = decodeFunctionData({ abi: ABI, data: q.steps[0]!.unsignedTxs![1]!.data });
    expect(getAddress(burn.args[0] as string)).toBe(getAddress(RESOLVED));
  });

  it("maps Arbitrum (42161) → Wormhole chain 23", () => {
    const q = buildTokenWormholeOutboundQuote(base(42161, WMSOL_WRAPPER));
    const burn = decodeFunctionData({ abi: ABI, data: q.steps[0]!.unsignedTxs![1]!.data });
    expect(burn.args[3]).toBe(23);
  });

  it("rejects when the wrapper is absent (egress needs a wrapper address, not a mint)", () => {
    expect(() => buildTokenWormholeOutboundQuote(base(11155111, undefined))).toThrow(/wrapper/);
  });

  it("rejects an unmapped destination chain (fail-closed on the Wormhole id map)", () => {
    expect(() => buildTokenWormholeOutboundQuote(base(999999, WMSOL_WRAPPER))).toThrow(/Wormhole chain id/);
  });

  it("rejects when destinationChainId is missing", () => {
    expect(() => buildTokenWormholeOutboundQuote(base(undefined, WMSOL_WRAPPER))).toThrow(/destinationChainId/);
  });
});

describe("buildTokenWormholeOutboundQuote — 2-step reshape + claim stamping", () => {
  // Mirrors the ETH route: [approve, burn] as ONE step so registration binds
  // the burn; claim carries destination redeem metadata when the catalog has it.
  const HADRIAN = {
    chainId: "200010", slug: "hadrian", network: "devnet" as const, status: "live" as const,
    contracts: [{ name: "RomeBridgeWithdraw", versions: [{ version: "9.0.0", address: "0x65fc94ba1045b65889f0b27d3d02e5bfbc2aee03", status: "live" }] }],
    bridge: {
      sourceEvm: { chainId: 11155111, wormholeTokenBridge: "0xDB5492265f6038831E89f495670FF909aDe94bd9" },
    },
    tokens: [],
  } as never;
  const input = {
    amount: "1000000000",
    sender: { rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
    recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    destinationChainId: 11155111,
    splAsset: { mint: "So11111111111111111111111111111111111111112", decimals: 9, symbol: "wSOL", wrapper: "0x1dece035e589e01d2f6e1f8ba1d4a5f04a1f4201" },
    chain: HADRIAN, programId: "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf",
  };

  it("emits 2 steps — [approve, burn] in one user step, then the claim", () => {
    const q = buildTokenWormholeOutboundQuote(input as never);
    expect(q.steps).toHaveLength(2);
    expect(q.steps[0]?.kind).toBe("wormhole-burn-token");
    expect(q.steps[0]?.unsignedTxs).toHaveLength(2);
    expect(q.steps[1]?.kind).toBe("wormhole-claim-on-destination");
    expect(q.steps[1]?.blockedBy).toEqual(["step-1", "wormhole-vaa"]);
  });

  it("stamps claimTokenBridge + completeTransfer (ERC20 delivery) when the destination entry has it", () => {
    const q = buildTokenWormholeOutboundQuote(input as never);
    expect(q.steps[1]?.claimTokenBridge).toBe("0xDB5492265f6038831E89f495670FF909aDe94bd9");
    expect(q.steps[1]?.claimMethod).toBe("completeTransfer");
  });

  it("omits claim metadata (still quotes) when the destination has no wormholeTokenBridge", () => {
    const bare = { ...(HADRIAN as Record<string, unknown>), bridge: { sourceEvm: { chainId: 11155111 } } };
    const q = buildTokenWormholeOutboundQuote({ ...input, chain: bare } as never);
    expect(q.steps).toHaveLength(2);
    expect(q.steps[1]?.claimTokenBridge).toBeUndefined();
  });
});
