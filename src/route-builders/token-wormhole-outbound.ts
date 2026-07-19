import { encodeFunctionData, parseAbi, pad } from "viem";
import { ROUTE_SPECS, assertAmountInRange } from "./route-keys.js";
import { liveContractAddress } from "../registry/contracts.js";
import { entryFor } from "../registry/catalog.js";
import { resolveCanonicalWrapper } from "../chains/token-catalog.js";
import { bridgeError } from "../errors.js";
import type { Quote, QuoteInput, QuoteStep } from "./usdc-cctp-inbound.js";

// Generic Wormhole egress on RomeBridgeWithdraw (v7+): asset-agnostic + per-call
// destination. Split across two EVM txs — approve then burn — because a single
// atomic Rome DoTx with both CPIs exceeds Solana's 1.4M CU budget (same reason
// as the ETH-specific approveBurnETH/burnETH pair).
const WORMHOLE_GENERIC_ABI = parseAbi([
  "function approveWormholeBurn(address assetWrapper, uint256 amount)",
  "function burnToWormhole(address assetWrapper, uint256 amount, bytes32 recipient, uint16 targetChain)",
]);

// EVM chain id → Wormhole chain id. Only chains the deployed RomeBridgeWithdraw
// allowlists will actually burn; this map just resolves the wire value. Sepolia
// is live on v7; the rest unblock once v8 (setter) allowlists them on-chain.
// Wormhole assigns ONE id per chain across mainnet+testnet.
const WORMHOLE_CHAIN_ID: Record<number, number> = {
  1: 2,            // Ethereum
  11155111: 10002, // Sepolia
  42161: 23,       // Arbitrum One
  421614: 10003,   // Arbitrum Sepolia
  43114: 6,        // Avalanche C-Chain
  43113: 6,        // Avalanche Fuji
  8453: 30,        // Base
  84532: 10004,    // Base Sepolia
  137: 5,          // Polygon
};

/**
 * Generic Rome→L2 Wormhole outbound for ANY allowlisted wrapper. Emits
 * [approveWormholeBurn, burnToWormhole] on RomeBridgeWithdraw, then a
 * Wormhole-native claim step (the user redeems the emitted VAA on the
 * destination — NOT a bridge-api build).
 *
 * Requires: splAsset.wrapper (the ERC20-SPL wrapper on Rome — burnToWormhole
 * takes a wrapper address, not a raw mint) and destinationChainId (mapped to a
 * Wormhole chain id). The on-chain contract fail-closes if the wrapper or target
 * chain isn't allowlisted — this builder only shapes the calldata.
 */
export function buildTokenWormholeOutboundQuote(input: QuoteInput): Quote {
  const spec = ROUTE_SPECS["token-wormhole-from-rome"];
  const amount = BigInt(input.amount);
  assertAmountInRange(spec, input);
  if (!input.sender.rome) {
    throw bridgeError("rome.bridge.sender-incomplete", "token Wormhole outbound requires sender.rome");
  }
  // Mint-first: the caller may supply only splAsset.mint; resolve the canonical
  // ERC20-SPL wrapper from the chain's registry tokens (burnToWormhole takes a
  // wrapper address). An explicit splAsset.wrapper still wins.
  const wrapper = (input.splAsset?.wrapper
    ?? (input.splAsset?.mint ? resolveCanonicalWrapper(input.chain.tokens ?? [], input.splAsset.mint) : undefined)) as
    | `0x${string}`
    | undefined;
  if (!wrapper) {
    throw bridgeError(
      "rome.bridge.asset-not-supported",
      "Wormhole egress requires splAsset.mint (with a registry wrapper) or splAsset.wrapper",
    );
  }
  if (input.destinationChainId === undefined) {
    throw bridgeError("rome.bridge.asset-not-supported", "token Wormhole outbound requires destinationChainId");
  }
  const targetChain = WORMHOLE_CHAIN_ID[input.destinationChainId];
  if (targetChain === undefined) {
    throw bridgeError("rome.bridge.asset-not-supported", `no Wormhole chain id mapped for EVM chain ${input.destinationChainId}`);
  }

  const withdraw = liveContractAddress(input.chain, "RomeBridgeWithdraw") as `0x${string}` | undefined;
  if (!withdraw) throw bridgeError("rome.bridge.asset-not-supported", "no live RomeBridgeWithdraw in the registry for this chain");

  // Wormhole universal address = the 20-byte EVM recipient left-padded to 32B.
  const recipientBytes32 = pad(input.recipient as `0x${string}`, { size: 32 });
  const sym = input.splAsset?.symbol ?? "TOKEN";

  // Claim metadata: stamped when the destination catalog entry publishes its
  // token bridge — the poller then materializes the redeem calldata once the
  // VAA is signed. Without it the quote still works (portal redeem).
  const claimTokenBridge = entryFor(input.chain.bridge, input.destinationChainId)?.wormholeTokenBridge as `0x${string}` | undefined;

  const steps: QuoteStep[] = [
    {
      // ONE step, two txs ([approve, burn] — CCTP-in shape): step1TxHash then
      // binds the BURN (verifies the LAST unsignedTx), the tx the VAA
      // hangs off. Txs stay separate on-chain (the 1.4M-CU split is per-TX).
      n: 1, chain: `rome-${input.chain.chainId}`, kind: "wormhole-burn-token",
      userSigns: true, sponsorPaysFees: false,
      unsignedTxs: [{
        to: withdraw,
        data: encodeFunctionData({ abi: WORMHOLE_GENERIC_ABI, functionName: "approveWormholeBurn", args: [wrapper, amount] }),
        value: "0", estimatedGas: "1500000",
        description: `Approve Wormhole burn of ${sym} on RomeBridgeWithdraw`,
      }, {
        to: withdraw,
        data: encodeFunctionData({ abi: WORMHOLE_GENERIC_ABI, functionName: "burnToWormhole", args: [wrapper, amount, recipientBytes32, targetChain] }),
        value: "0", estimatedGas: "1500000",
        description: `Burn ${sym} on Rome → Wormhole transfer_tokens to chain ${targetChain}, emits redeemable VAA`,
      }],
    },
    {
      // Delivery is the wrapped ERC20 on the destination → completeTransfer.
      n: 2, chain: `eip155:${input.destinationChainId}`, kind: "wormhole-claim-on-destination",
      userSigns: true, sponsorPaysFees: false,
      unsignedTx: null, blockedBy: ["step-1", "wormhole-vaa"],
      ...(claimTokenBridge ? { claimTokenBridge, claimMethod: "completeTransfer" } : {}),
    },
  ];

  return {
    route: "token-wormhole-from-rome",
    direction: "from-rome",
    amountIn: input.amount,
    amountOut: input.amount,
    fee: { bps: 0, absolute: "0", asset: sym },
    // burnToken = the wrapper approved/burned; its decimals mirror the SPL mint,
    // so burnAmount == amountIn. Page shows balanceOf(wrapper), not gas.
    burnToken: wrapper,
    burnTokenDecimals: input.splAsset?.decimals,
    burnAmount: input.amount,
    etaSeconds: 900,
    steps,
  };
}
