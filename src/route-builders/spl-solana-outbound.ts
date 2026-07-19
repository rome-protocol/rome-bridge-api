import { encodeFunctionData, parseAbi, bytesToHex } from "viem";
import { PublicKey } from "@solana/web3.js";
import { ROUTE_SPECS, assertAmountInRange } from "./route-keys.js";
import { bridgeError } from "../errors.js";
import { liveContractAddress } from "../registry/contracts.js";
import type { Quote, QuoteInput, QuoteStep } from "./usdc-cctp-inbound.js";

// Rome→Solana SPL egress lives on RomeBridgeWithdraw (v6+), mint-explicit and
// asset-agnostic: ONE contract bridges out ANY SPL by passing its mint.
// Selectors: ensureRecipientAta(bytes32,bytes32)=0xeeaed29d,
// bridgeOutToSolana(bytes32,uint256,bytes32)=0x8efe5df8.
const BRIDGE_EGRESS_ABI = parseAbi([
  "function ensureRecipientAta(bytes32 solanaRecipient, bytes32 mint)",
  "function bridgeOutToSolana(bytes32 solanaRecipient, uint256 amount, bytes32 mint)",
]);

/**
 * Asset-agnostic Rome→Solana outbound for ANY SPL (LSTs like mSOL/bSOL, or any
 * factory-minted token). The caller holds a wrapper view over `mint` on Rome;
 * RomeBridgeWithdraw.bridgeOutToSolana transfers the UNDERLYING SPL from the
 * caller's PDA-ATA to the recipient's Solana ATA (signed as external_auth(caller)).
 *
 * An LST is never a chain's gas mint, so this rail always takes the wrapper
 * egress (never the native-withdraw precompile). Emits [ensureRecipientAta,
 * bridgeOutToSolana]; ensureRecipientAta is NOT idempotent on-chain, so a client
 * that has already confirmed the recipient ATA exists should skip it and send
 * only the final tx.
 */
export function buildSplSolanaOutboundQuote(input: QuoteInput): Quote {
  const spec = ROUTE_SPECS["spl-solana-from-rome"];
  const amount = BigInt(input.amount);
  assertAmountInRange(spec, input);
  if (!input.sender.rome) {
    throw bridgeError("rome.bridge.sender-incomplete", "SPL Solana outbound requires sender.rome");
  }
  if (!input.splAsset?.mint) {
    throw bridgeError("rome.bridge.asset-not-supported", "SPL rail requires splAsset.mint");
  }

  let recipientPubkey: PublicKey;
  try { recipientPubkey = new PublicKey(input.recipient); }
  catch { throw bridgeError("rome.bridge.recipient-invalid", `recipient ${input.recipient} is not a valid Solana pubkey`); }
  const recipientBytes32 = bytesToHex(recipientPubkey.toBytes());
  const mintBytes32 = bytesToHex(new PublicKey(input.splAsset.mint).toBytes());

  const withdraw = liveContractAddress(input.chain, "RomeBridgeWithdraw") as `0x${string}` | undefined;
  if (!withdraw) throw bridgeError("rome.bridge.asset-not-supported", "no live RomeBridgeWithdraw in the registry for this chain");

  const steps: QuoteStep[] = [{
    n: 1, chain: `rome-${input.chain.chainId}`, kind: "spl-erc20-bridge-out",
    userSigns: true, sponsorPaysFees: false,
    unsignedTxs: [
      {
        to: withdraw,
        data: encodeFunctionData({ abi: BRIDGE_EGRESS_ABI, functionName: "ensureRecipientAta", args: [recipientBytes32, mintBytes32] }),
        value: "0", estimatedGas: "300000",
        description: "Ensure the recipient SPL ATA exists on Solana (skip when already present)",
      },
      {
        to: withdraw,
        data: encodeFunctionData({ abi: BRIDGE_EGRESS_ABI, functionName: "bridgeOutToSolana", args: [recipientBytes32, amount, mintBytes32] }),
        value: "0", estimatedGas: "300000",
        description: "Bridge the SPL out to the Solana recipient via RomeBridgeWithdraw.bridgeOutToSolana(recipient, amount, mint)",
      },
    ],
  }];

  return {
    route: "spl-solana-from-rome",
    direction: "from-rome",
    amountIn: input.amount,
    amountOut: input.amount,
    fee: { bps: 0, absolute: "0", asset: input.splAsset.symbol ?? "SPL" },
    etaSeconds: 5,
    steps,
  };
}
