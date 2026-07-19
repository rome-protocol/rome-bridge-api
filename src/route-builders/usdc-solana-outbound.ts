import { encodeFunctionData, parseAbi, bytesToHex } from "viem";
import { PublicKey } from "@solana/web3.js";
import { ROUTE_SPECS, assertAmountInRange } from "./route-keys.js";
import { bridgeError } from "../errors.js";
import { assetFor } from "../registry/catalog.js";
import type { Quote, QuoteInput, QuoteStep } from "./usdc-cctp-inbound.js";

// USDC mint per Solana cluster (last-resort fallback; prefer registry/wrapper row).
const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

// Rome → Solana native withdraw precompile (0x42..16). msg.value carries the
// amount in 18-dec wei; the precompile converts to the mint's SPL units and
// delivers to the Solana recipient. Same call the Rome app's useNativeWithdrawSend makes.
const WITHDRAW_PRECOMPILE = "0x4200000000000000000000000000000000000016";
const WITHDRAW_ABI = parseAbi(["function withdrawal(bytes32 recipient)"]);
// Generic ERC20-SPL wrapper egress (the Rome app useOutboundSplBridge): recipient is
// the Solana WALLET (contract derives the ATA); arg order is (recipient, amount).
const WRAPPER_EGRESS_ABI = parseAbi([
  "function ensureRecipientAta(bytes32 solanaRecipient)",
  "function bridgeOutToSolana(bytes32 solanaRecipient, uint256 value)",
]);

/**
 * Rome → Solana USDC egress. Routing is GAS-RELATIVE and the gas designation is
 * read from the rome-evm program's on-chain OwnerInfo (`input.onchainGasMint`,
 * resolved by the quote handler) — NOT the registry, which is a drift-prone
 * mirror. Registry `gasToken.mintId` is only a fallback when the on-chain read
 * is unavailable.
 *
 *   - USDC IS this chain's gas mint  → native `withdrawal(recipient)` on 0x42..16,
 *     msg.value = amount * 10^(18-decimals). (On a USDC-gas chain the user holds
 *     USDC as native gas; the wUSDC wrapper is redundant.)
 *   - USDC is NOT the gas mint       → wrapper `ensureRecipientAta` + `bridgeOutToSolana`
 *     on the wUSDC wrapper (recipient = wallet).
 */
export function buildUsdcSolanaOutboundQuote(input: QuoteInput): Quote {
  const spec = ROUTE_SPECS["usdc-solana-from-rome"];
  const amount = BigInt(input.amount);
  assertAmountInRange(spec, input);
  if (!input.sender.rome) {
    throw bridgeError("rome.bridge.sender-incomplete", "USDC Solana outbound requires sender.rome");
  }

  // recipient = the user's Solana WALLET (base58), NOT an ATA — both paths take
  // the wallet (withdrawal delivers to it; the wrapper derives the ATA on-chain).
  let recipientPubkey: PublicKey;
  try { recipientPubkey = new PublicKey(input.recipient); }
  catch { throw bridgeError("rome.bridge.recipient-invalid", `recipient ${input.recipient} is not a valid Solana pubkey`); }
  const recipientBytes32 = bytesToHex(recipientPubkey.toBytes());

  // Asset identity (which SPL is "USDC" on this chain) — registry is fine for
  // identity. Gas designation (is that mint the chain's gas?) — on-chain first.
  const wrapperRow = input.chain.tokens?.find((t) => t.kind === "spl_wrapper" && t.assetRef === "usdc");
  const usdcMint = assetFor(input.chain.bridge, { symbol: "USDC" })?.solanaMint
    ?? wrapperRow?.mintId
    ?? USDC_DEVNET_MINT;
  const chainGasMint = input.onchainGasMint ?? input.chain.gasToken?.mintId;
  const isGasMint = !!chainGasMint && chainGasMint === usdcMint;

  const steps: QuoteStep[] = isGasMint
    ? [{
        n: 1, chain: `rome-${input.chain.chainId}`, kind: "native-withdraw",
        userSigns: true, sponsorPaysFees: false,
        unsignedTxs: [{
          to: WITHDRAW_PRECOMPILE,
          data: encodeFunctionData({ abi: WITHDRAW_ABI, functionName: "withdrawal", args: [recipientBytes32] }),
          // 18-dec native gas; precompile converts to the mint's SPL units.
          value: (amount * 10n ** BigInt(18 - spec.decimals)).toString(),
          estimatedGas: "300000",
          description: "Withdraw native USDC gas to Solana via the 0x42..16 precompile",
        }],
      }]
    : (() => {
        const wrapper = wrapperRow?.address as `0x${string}` | undefined;
        if (!wrapper) throw bridgeError("rome.bridge.asset-not-supported", "no USDC spl_wrapper in tokens.json");
        return [{
          n: 1, chain: `rome-${input.chain.chainId}`, kind: "spl-erc20-bridge-out",
          userSigns: true, sponsorPaysFees: false,
          unsignedTxs: [
            {
              to: wrapper,
              data: encodeFunctionData({ abi: WRAPPER_EGRESS_ABI, functionName: "ensureRecipientAta", args: [recipientBytes32] }),
              value: "0", estimatedGas: "300000",
              description: "Ensure recipient wUSDC ATA exists on Solana (idempotent)",
            },
            {
              to: wrapper,
              data: encodeFunctionData({ abi: WRAPPER_EGRESS_ABI, functionName: "bridgeOutToSolana", args: [recipientBytes32, amount] }),
              value: "0", estimatedGas: "300000",
              description: "Bridge wUSDC out to the Solana recipient via SPL_ERC20.bridgeOutToSolana",
            },
          ],
        }];
      })();

  return {
    route: "usdc-solana-from-rome",
    direction: "from-rome",
    amountIn: input.amount,
    amountOut: input.amount,
    fee: { bps: 0, absolute: "0", asset: "USDC" },
    etaSeconds: 5,
    steps,
  };
}
