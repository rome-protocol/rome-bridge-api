import { encodeFunctionData, parseAbi } from "viem";
import { ChainConfig } from "../registry/types.js";
import { ROUTE_SPECS, assertAmountInRange } from "./route-keys.js";
import { cctpDomainFor, entryFor, resolveCctpAddresses } from "../registry/catalog.js";
import { liveContractAddress } from "../registry/contracts.js";
import { bridgeError } from "../errors.js";
import type { Quote, QuoteInput, QuoteStep } from "./usdc-cctp-inbound.js";

/**
 * Outbound (Rome → any catalog EVM chain) via RomeBridgeWithdraw v6: the
 * destination CCTP domain is a per-call parameter, so ONE deployed contract
 * serves every catalog destination (unlisted domains revert on-chain via the
 * constructor allowlist — quotes fail closed here first). Contract address
 * resolves from the registry's live version, never a pinned constant.
 */
const ROME_BRIDGE_WITHDRAW_V6_ABI = parseAbi([
  "function burnUSDC(uint256 amount, address recipient, uint32 destinationDomain)",
]);

export function buildUsdcCctpOutboundQuote(input: QuoteInput): Quote {
  const spec = ROUTE_SPECS["usdc-cctp-from-rome"];
  const amount = BigInt(input.amount);
  assertAmountInRange(spec, input);
  if (!input.sender.rome) {
    throw bridgeError("rome.bridge.sender-incomplete", "USDC CCTP outbound requires sender.rome");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.recipient)) {
    throw bridgeError("rome.bridge.recipient-invalid", "outbound recipient must be an EVM address on the destination chain");
  }

  const withdraw = liveContractAddress(input.chain, "RomeBridgeWithdraw") as `0x${string}` | undefined;
  if (!withdraw) throw bridgeError("rome.bridge.asset-not-supported", "no live RomeBridgeWithdraw in the registry for this chain");

  const entry = input.destinationChainId === undefined
    ? entryFor(input.chain.bridge)
    : entryFor(input.chain.bridge, input.destinationChainId);
  if (!entry) throw bridgeError("rome.bridge.asset-not-supported", `destination chain ${input.destinationChainId} is not in the registry bridge catalog`);

  const destinationDomain = cctpDomainFor(input.chain.bridge, entry);
  if (destinationDomain === undefined) throw bridgeError("rome.bridge.asset-not-supported", `destination ${entry.chainId} has no cctpDomain`);

  // The user redeems on the destination via MessageTransmitterV2.receiveMessage —
  // quoting without the transmitter would strand the flow at the claim step.
  const claimTransmitter = resolveCctpAddresses(entry, 2).messageTransmitter;
  if (!claimTransmitter) throw bridgeError("rome.bridge.asset-not-supported", `destination ${entry.chainId} has no V2 messageTransmitter configured`);

  // The token burnUSDC actually pulls is the Rome-side wUSDC spl_wrapper (6-dec),
  // NOT the 18-dec native gas USDC. Surface it so a client reads the bridgeable
  // balance instead of gas (see Quote.burnToken). wUSDC decimals == the route's
  // 6-dec, so burnAmount == amountIn.
  const burnRow = input.chain.tokens?.find((t) => t.kind === "spl_wrapper" && t.assetRef === "usdc");
  const burnToken = burnRow?.address;
  const burnTokenDecimals = burnRow?.decimals;

  const burnData = encodeFunctionData({
    abi: ROME_BRIDGE_WITHDRAW_V6_ABI, functionName: "burnUSDC",
    args: [amount, input.recipient as `0x${string}`, destinationDomain],
  });

  const steps: QuoteStep[] = [
    {
      n: 1, chain: `rome-${input.chain.chainId}`, kind: "cctp-burn-usdc",
      userSigns: true, sponsorPaysFees: false,
      unsignedTxs: [{
        to: withdraw,
        data: burnData,
        value: "0",
        estimatedGas: "250000",
        description: `Burn wUSDC on Rome via RomeBridgeWithdraw, CCTP v2 to domain ${destinationDomain}`,
      }],
    },
    {
      n: 2, chain: `evm-${entry.chainId}`, kind: "cctp-claim-on-destination",
      userSigns: true, sponsorPaysFees: false,
      unsignedTx: null, blockedBy: ["step-1", "circle-attestation"],
      claimTransmitter,
      claimDomain: destinationDomain,
    },
  ];

  return {
    route: "usdc-cctp-from-rome",
    direction: "from-rome",
    amountIn: input.amount,
    amountOut: input.amount,
    fee: { bps: 0, absolute: "0", asset: "USDC" },
    protocolFee: "0",
    etaP90Seconds: null,
    cctpVersion: 2,
    destinationChainId: entry.chainId,
    burnToken,
    burnTokenDecimals,
    burnAmount: amount.toString(),
    etaSeconds: 90, // Solana-origin burns attest fast; destination gas is on the user
    steps,
  };
}
