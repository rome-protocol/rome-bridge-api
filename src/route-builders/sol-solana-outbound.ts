import { encodeFunctionData, parseAbi, bytesToHex } from "viem";
import { PublicKey } from "@solana/web3.js";
import { ROUTE_SPECS, assertAmountInRange } from "./route-keys.js";
import { bridgeError } from "../errors.js";
import { liveContractAddress } from "../registry/contracts.js";
import type { Quote, QuoteInput, QuoteStep } from "./usdc-cctp-inbound.js";

// wSOL mint is canonical and cluster-invariant.
// https://spl.solana.com/token — the native-SOL wrapper.
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const WITHDRAW_PRECOMPILE = "0x4200000000000000000000000000000000000016";
const WITHDRAW_ABI = parseAbi(["function withdrawal(bytes32 recipient)"]);
// Rome→Solana SPL egress lives on RomeBridgeWithdraw (v6+), NOT the ERC20-SPL
// wrapper. The 3-arg, mint-explicit form is asset-agnostic — ONE contract bridges
// out ANY SPL by passing its mint (the Rome app; the cached wrappers
// deliberately expose no egress, so calling them reverts empty-0x). Selectors:
// ensureRecipientAta=0xeeaed29d, bridgeOutToSolana=0x8efe5df8.
const BRIDGE_EGRESS_ABI = parseAbi([
  "function ensureRecipientAta(bytes32 solanaRecipient, bytes32 mint)",
  "function bridgeOutToSolana(bytes32 solanaRecipient, uint256 amount, bytes32 mint)",
]);

/**
 * Rome → Solana SOL egress. Gas-relative, gas designation read from the rome-evm
 * program's on-chain OwnerInfo (`input.onchainGasMint`) — registry `gasToken` is
 * a drift-prone mirror used only as fallback.
 *
 *   - SOL IS this chain's gas mint → native `withdrawal(recipient)` (0x42..16),
 *     msg.value = amount * 10^(18-9). (User holds SOL as native gas.)
 *   - SOL is NOT the gas mint (e.g. on a USDC-gas chain) → RomeBridgeWithdraw
 *     `ensureRecipientAta(recipient, mint)` + `bridgeOutToSolana(recipient, amount, mint)`
 *     (mint-explicit ⇒ asset-agnostic; recipient = wallet, not ATA).
 */
export function buildSolSolanaOutboundQuote(input: QuoteInput): Quote {
  const spec = ROUTE_SPECS["sol-solana-from-rome"];
  const amount = BigInt(input.amount);
  assertAmountInRange(spec, input);
  if (!input.sender.rome) {
    throw bridgeError("rome.bridge.sender-incomplete", "SOL Solana outbound requires sender.rome");
  }

  let recipientPubkey: PublicKey;
  try { recipientPubkey = new PublicKey(input.recipient); }
  catch { throw bridgeError("rome.bridge.recipient-invalid", `recipient ${input.recipient} is not a valid Solana pubkey`); }
  const recipientBytes32 = bytesToHex(recipientPubkey.toBytes());

  // Gas designation from on-chain OwnerInfo first; registry mirror as fallback.
  const chainGasMint = input.onchainGasMint ?? input.chain.gasToken?.mintId;
  const isGasMint = chainGasMint === WSOL_MINT;

  const steps: QuoteStep[] = isGasMint
    ? [{
        n: 1, chain: `rome-${input.chain.chainId}`, kind: "native-withdraw",
        userSigns: true, sponsorPaysFees: false,
        unsignedTxs: [{
          to: WITHDRAW_PRECOMPILE,
          data: encodeFunctionData({ abi: WITHDRAW_ABI, functionName: "withdrawal", args: [recipientBytes32] }),
          value: (amount * 10n ** BigInt(18 - spec.decimals)).toString(),
          estimatedGas: "300000",
          description: "Withdraw native SOL gas to Solana via the 0x42..16 precompile",
        }],
      }]
    : (() => {
        const withdraw = liveContractAddress(input.chain, "RomeBridgeWithdraw") as `0x${string}` | undefined;
        if (!withdraw) throw bridgeError("rome.bridge.asset-not-supported", "no live RomeBridgeWithdraw in the registry for this chain");
        const mintBytes32 = bytesToHex(new PublicKey(WSOL_MINT).toBytes());
        return [{
          n: 1, chain: `rome-${input.chain.chainId}`, kind: "spl-erc20-bridge-out",
          userSigns: true, sponsorPaysFees: false,
          unsignedTxs: [
            {
              to: withdraw,
              data: encodeFunctionData({ abi: BRIDGE_EGRESS_ABI, functionName: "ensureRecipientAta", args: [recipientBytes32, mintBytes32] }),
              value: "0", estimatedGas: "300000",
              description: "Ensure the recipient wSOL ATA exists on Solana (skip when already present)",
            },
            {
              to: withdraw,
              data: encodeFunctionData({ abi: BRIDGE_EGRESS_ABI, functionName: "bridgeOutToSolana", args: [recipientBytes32, amount, mintBytes32] }),
              value: "0", estimatedGas: "300000",
              description: "Bridge wSOL out to the Solana recipient via RomeBridgeWithdraw.bridgeOutToSolana(recipient, amount, mint)",
            },
          ],
        }];
      })();

  return {
    route: "sol-solana-from-rome",
    direction: "from-rome",
    amountIn: input.amount,
    amountOut: input.amount,
    fee: { bps: 0, absolute: "0", asset: "SOL" },
    etaSeconds: 5,
    steps,
  };
}
