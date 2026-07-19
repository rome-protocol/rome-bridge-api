import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ROUTE_SPECS, assertAmountInRange } from "./route-keys.js";
import { deriveExternalAuthorityPda } from "../lib/pda.js";
import { deriveUserPdaAta } from "../lib/ata.js";
import { bridgeError } from "../errors.js";
import { parseWalletPubkey } from "../lib/solana-wallet.js";
import type { Quote, QuoteInput, QuoteStep } from "./usdc-cctp-inbound.js";

// wSOL mint is the same address on all Solana clusters (mainnet, devnet, testnet).
// https://spl.solana.com/token — the native-SOL wrapper is a canonical well-known address.
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const SOL_DECIMALS = 9;

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
 * Build the inbound-SOL-into-Rome quote.
 *
 * Step 1's unsigned tx wraps native SOL inline (no caller-side pre-wrap
 * needed):
 *
 *   1. ATA Program — createAssociatedTokenAccountIdempotent (no-op if
 *      sender's wSOL ATA already exists)
 *   2. System Program — transfer `amount` lamports: sender → sender's
 *      wSOL ATA
 *   3. SPL Token — syncNative on sender's wSOL ATA (reflects the new
 *      lamports as token amount)
 *   4. SPL Token — transferChecked: sender's wSOL ATA → recipient's
 *      PDA-ATA on Rome (bound by mint + decimals to prevent
 *      mint-substitution)
 *
 * Caller may pass either a fresh native-SOL balance OR a pre-existing
 * wSOL-funded ATA — both work because the idempotent ATA-create + the
 * extra lamport transfer don't double-wrap (lamports just sit at the
 * ATA until step 4 spends them).
 */
export function buildSolSolanaInboundQuote(input: QuoteInput): Quote {
  const spec = ROUTE_SPECS["sol-solana-to-rome"];
  const amount = BigInt(input.amount);
  assertAmountInRange(spec, input);
  if (!input.sender.solana) {
    throw bridgeError("rome.bridge.sender-incomplete", "SOL Solana inbound requires sender.solana");
  }

  const senderSolana = parseWalletPubkey(input.sender.solana, "SOL Solana inbound sender");
  const senderWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, senderSolana);

  const programId = new PublicKey(input.programId);
  const [userPda] = deriveExternalAuthorityPda(input.recipient, programId);
  const destinationAta = deriveUserPdaAta(userPda, WSOL_MINT);

  const ixs: TransactionInstruction[] = [
    // 1. ensure sender's wSOL ATA exists (idempotent — safe to send unconditionally)
    createAssociatedTokenAccountIdempotentInstruction(
      senderSolana, senderWsolAta, senderSolana, WSOL_MINT,
    ),
    // 2. move `amount` lamports from sender → wSOL ATA
    SystemProgram.transfer({
      fromPubkey: senderSolana, toPubkey: senderWsolAta, lamports: amount,
    }),
    // 3. tell SPL Token the ATA's lamport balance is wrapped
    createSyncNativeInstruction(senderWsolAta),
    // 4. Cold-recipient fix: ensure the RECIPIENT's PDA-ATA exists
    //    (idempotent; sender pays rent — no sponsor on this rail) before transfer.
    createAssociatedTokenAccountIdempotentInstruction(
      senderSolana, destinationAta, userPda, WSOL_MINT,
    ),
    // 5. transferChecked the wrapped amount to recipient PDA-ATA. mint + decimals bound.
    createTransferCheckedInstruction(
      senderWsolAta, WSOL_MINT, destinationAta, senderSolana,
      amount, SOL_DECIMALS,
    ),
  ];

  const unsignedTx = {
    kind: "solana-instructions" as const,
    instructions: ixs.map(serializeIx),
    feePayer: senderSolana.toBase58(),
    recentBlockhashPlaceholder: true as const,
  };

  // Step 2 (claim-as-gas) fires only when wSOL IS this chain's gas mint AND the
  // user wants gas. The gas designation is read from the rome-evm program's
  // on-chain OwnerInfo (input.onchainGasMint) — authoritative; the registry
  // gasToken is a drift-prone mirror used only as fallback. If wSOL is not the
  // gas mint, or intent="wrapper", it arrives as the wSOL wrapper and no claim
  // step is emitted (keep-as-wrapper).
  const chainGasMint = input.onchainGasMint ?? input.chain.gasToken?.mintId;
  const settleAsGas = chainGasMint === WSOL_MINT.toBase58() && (input.intent ?? "gas") === "gas";

  const steps: QuoteStep[] = [
    {
      n: 1,
      chain: "solana",
      kind: "solana-wsol-transfer",
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
    route: "sol-solana-to-rome",
    direction: "to-rome",
    amountIn: input.amount,
    amountOut: input.amount,
    fee: { bps: 0, absolute: "0", asset: "SOL" },
    etaSeconds: 30,
    steps,
  };
}
