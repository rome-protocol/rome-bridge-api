import { encodeFunctionData, parseAbi } from "viem";
import { ROUTE_SPECS, assertAmountInRange } from "./route-keys.js";
import { liveContractAddress } from "../registry/contracts.js";
import { assetFor, entryFor } from "../registry/catalog.js";
import { bridgeError } from "../errors.js";
import type { Quote, QuoteInput, QuoteStep } from "./usdc-cctp-inbound.js";

// approveBurnETH + burnETH live on the SAME RomeBridgeWithdraw v6 contract as
// burnUSDC (Cardo-proven on-chain). Resolve the address from the registry's
// live version — identical to usdc-cctp-outbound — never a pinned constant or a
// phantom bridge.rome key. burnETH's Wormhole target chain is immutable
// (Sepolia) by contract construction, matching the ETH↔Sepolia Wormhole route.
const ROME_BRIDGE_WITHDRAW_ABI = parseAbi([
  "function approveBurnETH(uint256 amount)",
  "function burnETH(uint256 amount, address recipient)",
]);

export function buildEthWormholeOutboundQuote(input: QuoteInput): Quote {
  const spec = ROUTE_SPECS["eth-wormhole-from-rome"];
  const amount = BigInt(input.amount);
  assertAmountInRange(spec, input);
  if (!input.sender.rome) {
    throw bridgeError("rome.bridge.sender-incomplete", "ETH Wormhole outbound requires sender.rome");
  }

  const withdrawAddr = liveContractAddress(input.chain, "RomeBridgeWithdraw") as `0x${string}` | undefined;
  if (!withdrawAddr) throw bridgeError("rome.bridge.asset-not-supported", "no live RomeBridgeWithdraw in the registry for this chain");

  // API amounts are 18-dec wei; the on-chain burn unit is the wETH WRAPPER's
  // decimals (8 — Wormhole normalizes transfer amounts to 8 dp and the wrapper
  // mirrors the wrapped mint; registry asset row overrides when present).
  // Emitting wei into burnETH would burn 10^10× the intent.
  const wrapperDecimals = BigInt(assetFor(input.chain.bridge, { symbol: "ETH" })?.decimals ?? 8);
  const granularity = 10n ** (18n - wrapperDecimals);
  if (amount % granularity !== 0n) {
    throw bridgeError("rome.bridge.amount-out-of-range",
      `amount ${input.amount} has dust below the wrapper granularity — ETH outbound amounts must be a multiple of ${granularity} wei (${wrapperDecimals}-decimal Wormhole normalization)`);
  }
  const wrapperAmount = amount / granularity;

  // The wETH spl_wrapper is what burnETH actually pulls — a client reads
  // balanceOf(burnToken) + gates on burnAmount (both in the wrapper's 8-dec),
  // NOT the 18-dec route scale. Without this a client shows native gas and a
  // 1.0-ETH entry over a 0.1-wETH balance reverts → MetaMask "Unavailable" fee.
  const burnRow = input.chain.tokens?.find((t) => t.kind === "spl_wrapper" && t.assetRef === "eth");

  const approveData = encodeFunctionData({
    abi: ROME_BRIDGE_WITHDRAW_ABI, functionName: "approveBurnETH", args: [wrapperAmount],
  });
  const burnData = encodeFunctionData({
    abi: ROME_BRIDGE_WITHDRAW_ABI, functionName: "burnETH",
    args: [wrapperAmount, input.recipient as `0x${string}`],
  });

  // Claim metadata (stamped when the catalog has the destination bridge):
  // the poller materializes the destination redeem from these once the VAA
  // is signed. ETH route delivers NATIVE ETH → completeTransferAndUnwrapETH.
  const claimTokenBridge = entryFor(input.chain.bridge)?.wormholeTokenBridge as `0x${string}` | undefined;

  const steps: QuoteStep[] = [
    {
      // ONE step, two txs ([approve, burn] — the CCTP-in [approve, deposit]
      // shape): registration's step1TxHash then binds the BURN (verifies
      // the LAST unsignedTx), which is the tx the VAA hangs off. The txs stay
      // separate on-chain (the 1.4M-CU split is a per-TX constraint, not a
      // per-step one).
      n: 1, chain: `rome-${input.chain.chainId}`, kind: "wormhole-burn-eth",
      userSigns: true, sponsorPaysFees: false,
      unsignedTxs: [
        {
          to: withdrawAddr,
          data: approveData,
          value: "0",
          estimatedGas: "100000",
          description: "Approve burnETH on RomeBridgeWithdraw",
        },
        {
          to: withdrawAddr,
          data: burnData,
          value: "0",
          estimatedGas: "250000",
          description: "Burn wETH on Rome, emits Wormhole publishMessage",
        },
      ],
    },
    {
      n: 2, chain: "ethereum", kind: "wormhole-claim-on-ethereum",
      userSigns: true, sponsorPaysFees: false,
      unsignedTx: null, blockedBy: ["step-1", "wormhole-vaa"],
      ...(claimTokenBridge ? { claimTokenBridge, claimMethod: "completeTransferAndUnwrapETH" } : {}),
    },
  ];

  return {
    route: "eth-wormhole-from-rome",
    direction: "from-rome",
    amountIn: input.amount,
    amountOut: input.amount,
    fee: { bps: 0, absolute: "0", asset: "ETH" },
    burnToken: burnRow?.address,
    burnTokenDecimals: burnRow?.decimals ?? Number(wrapperDecimals),
    burnAmount: wrapperAmount.toString(),
    etaSeconds: 900,
    steps,
  };
}
