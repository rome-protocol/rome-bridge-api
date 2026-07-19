import { PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ROUTE_SPECS, assertAmountInRange } from "./route-keys.js";
import { deriveExternalAuthorityPda } from "../lib/pda.js";
import { deriveUserPdaAta } from "../lib/ata.js";
import { bridgeError } from "../errors.js";
import { assetFor } from "../registry/catalog.js";
import type { Quote, QuoteInput, QuoteStep } from "./usdc-cctp-inbound.js";

// USDC mint per Solana cluster. For v1.0 devnet only; production reads from chain config.
const USDC_BY_SOLANA_CLUSTER: Record<string, string> = {
  "solana-devnet": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "solana-mainnet": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

// Shape for a Solana step's unsigned tx.
// The caller must inject a recent blockhash before signing — this shape carries
// the instruction body only; the feePayer + recentBlockhashPlaceholder flag
// signal that completion is required before submission.
export interface UnsignedSolanaTx {
  kind: "solana-instructions";
  instructions: Array<{
    programId: string;       // base58
    keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
    data: string;            // base64
  }>;
  feePayer: string;          // base58 — the sender.solana wallet
  recentBlockhashPlaceholder: true;  // signal: caller must inject a fresh blockhash
}

export function buildUsdcSolanaInboundQuote(input: QuoteInput): Quote {
  const spec = ROUTE_SPECS["usdc-solana-to-rome"];
  const amount = BigInt(input.amount);
  assertAmountInRange(spec, input);
  if (!input.sender.solana) {
    throw bridgeError("rome.bridge.sender-incomplete", "USDC Solana inbound requires sender.solana");
  }

  // Source USDC mint = the chain's USDC asset row (registry bridge.json);
  // cluster default only when the chain publishes no USDC asset.
  const usdcMintAddress: string =
    assetFor(input.chain.bridge, { symbol: "USDC" })?.solanaMint ??
    USDC_BY_SOLANA_CLUSTER["solana-devnet"]!;
  const usdcMint = new PublicKey(usdcMintAddress);

  const senderSolana = new PublicKey(input.sender.solana);
  // Source: sender's own ATA for USDC on Solana
  const senderAta = getAssociatedTokenAddressSync(usdcMint, senderSolana);

  const programId = new PublicKey(input.programId);
  const [userPda] = deriveExternalAuthorityPda(input.recipient, programId);
  // Destination: the Rome-side PDA-ATA derived from the recipient's EVM address
  const destinationAta = deriveUserPdaAta(userPda, usdcMint);

  // Cold-recipient fix: a first-time recipient's PDA-ATA does not exist
  // yet; create it idempotently (sender pays rent — there is no sponsor on this
  // rail) BEFORE the transfer, else transferChecked fails on a brand-new
  // recipient. transferChecked (over plain transfer) binds mint + decimals,
  // guarding against mint substitution.
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(senderSolana, destinationAta, userPda, usdcMint),
    createTransferCheckedInstruction(senderAta, usdcMint, destinationAta, senderSolana, amount, spec.decimals),
  ];

  const unsignedTx: UnsignedSolanaTx = {
    kind: "solana-instructions",
    instructions: ixs.map((ix) => ({
      programId: ix.programId.toBase58(),
      keys: ix.keys.map((k) => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(ix.data).toString("base64"),
    })),
    feePayer: senderSolana.toBase58(),
    recentBlockhashPlaceholder: true,
  };

  // Step 2 (claim-as-gas) fires only when USDC IS this chain's gas mint AND the
  // user wants gas. The gas designation is read from the rome-evm program's
  // on-chain OwnerInfo (input.onchainGasMint) — authoritative; the registry
  // gasToken is a drift-prone mirror used only as fallback. If USDC is not the
  // gas mint, or intent="wrapper", the USDC arrives as the wUSDC wrapper and no
  // claim step is emitted (keep-as-wrapper).
  const chainGasMint = input.onchainGasMint ?? input.chain.gasToken?.mintId;
  const settleAsGas = chainGasMint === usdcMintAddress && (input.intent ?? "gas") === "gas";

  const steps: QuoteStep[] = [
    {
      n: 1,
      chain: "solana",
      kind: "solana-spl-transfer",
      unsignedTx: unsignedTx as any,
    },
  ];
  if (settleAsGas) {
    steps.push({
      n: 2,
      chain: `rome-${input.chain.chainId}`,
      kind: "claim-as-gas",
      unsignedTx: null,
      blockedBy: ["step-1"],
    });
  }

  return {
    route: "usdc-solana-to-rome",
    direction: "to-rome",
    amountIn: input.amount,
    amountOut: input.amount,
    fee: { bps: 0, absolute: "0", asset: "USDC" },
    etaSeconds: 30,
    steps,
  };
}
