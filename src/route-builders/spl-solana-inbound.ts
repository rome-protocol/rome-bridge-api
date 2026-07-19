import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ROUTE_SPECS, assertAmountInRange } from "./route-keys.js";
import { deriveExternalAuthorityPda } from "../lib/pda.js";
import { deriveUserPdaAta } from "../lib/ata.js";
import { bridgeError } from "../errors.js";
import { parseWalletPubkey } from "../lib/solana-wallet.js";
import type { Quote, QuoteInput, QuoteStep } from "./usdc-cctp-inbound.js";

function serializeIx(ix: TransactionInstruction) {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(ix.data).toString("base64"),
  };
}

/**
 * Asset-agnostic Solana→Rome inbound for ANY existing SPL (LSTs like mSOL/bSOL,
 * or any factory-minted token). Unlike the SOL rail, the sender ALREADY holds
 * the SPL — there is no native-wrap prelude. Step 1's unsigned Solana tx:
 *
 *   1. ATA Program — createAssociatedTokenAccountIdempotent for the RECIPIENT's
 *      Rome PDA-ATA (cold-path fix; sender pays rent — no sponsor on this rail)
 *   2. SPL Token — transferChecked: sender's SPL ATA → recipient's PDA-ATA on
 *      Rome, bound by (mint, decimals) to prevent mint-substitution
 *
 * The Rome side is a wrapper view over `mint`; egress (spl-solana-from-rome)
 * sends the underlying `mint` back out. An LST is never a chain's gas mint, so
 * there is never a claim-as-gas step here (always keep-as-wrapper).
 */
export function buildSplSolanaInboundQuote(input: QuoteInput): Quote {
  const spec = ROUTE_SPECS["spl-solana-to-rome"];
  const amount = BigInt(input.amount);
  assertAmountInRange(spec, input);
  if (!input.sender.solana) {
    throw bridgeError("rome.bridge.sender-incomplete", "SPL Solana inbound requires sender.solana");
  }
  if (!input.splAsset?.mint) {
    throw bridgeError("rome.bridge.asset-not-supported", "SPL rail requires splAsset.mint");
  }

  const mint = new PublicKey(input.splAsset.mint);
  const decimals = input.splAsset.decimals;
  const senderSolana = parseWalletPubkey(input.sender.solana, "SPL Solana inbound sender");
  const senderAta = getAssociatedTokenAddressSync(mint, senderSolana);

  const programId = new PublicKey(input.programId);
  const [userPda] = deriveExternalAuthorityPda(input.recipient, programId);
  const destinationAta = deriveUserPdaAta(userPda, mint);

  const ixs: TransactionInstruction[] = [
    // 1. ensure the RECIPIENT's PDA-ATA exists (idempotent; sender pays rent).
    createAssociatedTokenAccountIdempotentInstruction(
      senderSolana, destinationAta, userPda, mint,
    ),
    // 2. transferChecked the SPL to the recipient PDA-ATA. mint + decimals bound.
    createTransferCheckedInstruction(
      senderAta, mint, destinationAta, senderSolana, amount, decimals,
    ),
  ];

  const unsignedTx = {
    kind: "solana-instructions" as const,
    instructions: ixs.map(serializeIx),
    feePayer: senderSolana.toBase58(),
    recentBlockhashPlaceholder: true as const,
  };

  const steps: QuoteStep[] = [
    { n: 1, chain: "solana", kind: "solana-spl-transfer", unsignedTx: unsignedTx as any },
  ];

  return {
    route: "spl-solana-to-rome",
    direction: "to-rome",
    amountIn: input.amount,
    amountOut: input.amount,
    fee: { bps: 0, absolute: "0", asset: input.splAsset.symbol ?? "SPL" },
    etaSeconds: 30,
    steps,
  };
}
