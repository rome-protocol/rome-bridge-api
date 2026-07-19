/**
 * Production sponsor hooks, extracted from run.ts into an injectable factory
 * so the funded E2E harness runs the SAME wiring the deployed worker runs.
 *
 * Version-keyed dispatch (the record stamp's cctpVersion rides in on the
 * input): V1 receive keeps the inline idempotent ATA create; V2 receive is a
 * SINGLE receive_message ix (message+attestation overflow 1232B with an
 * inline create — ensure-ata is its own preceding step) with the fee ATA
 * resolved from the on-chain token_messenger config.
 */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { buildReceiveMessageInstruction } from "../cctp/solana-receive-message.js";
import { buildReceiveMessageV2Instruction, decodeFeeRecipientTokenAccount } from "../cctp/solana-receive-message-v2.js";
import type { SendEnsureAtaInput, SendReceiveMessageInput } from "./bridge-sponsor.js";

const SPONSOR_CU_LIMIT = Number(process.env.SPONSOR_CU_LIMIT ?? 400_000);

export type SignAndSend = (connection: Connection, signer: Keypair, ixs: TransactionInstruction[], opts?: { computeBudget?: boolean }) => Promise<string>;

export const defaultSignAndSend: SignAndSend = async (connection, signer, ixs, opts) => {
  const tx = new Transaction();
  if (opts?.computeBudget !== false) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: SPONSOR_CU_LIMIT }));
  for (const ix of ixs) tx.add(ix);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  return connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
};

const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));

/** Derive the token_messenger config PDA and read the fee-recipient ATA from it. */
async function resolveFeeRecipientAta(connection: Connection, programs: SendReceiveMessageInput["programs"]): Promise<PublicKey> {
  const tmm = new PublicKey(programs.tokenMessengerMinterProgram);
  const [tokenMessengerConfig] = PublicKey.findProgramAddressSync([Buffer.from("token_messenger")], tmm);
  const info = await connection.getAccountInfo(tokenMessengerConfig);
  if (!info) throw new Error(`token_messenger config account missing under ${tmm.toBase58()}`);
  return decodeFeeRecipientTokenAccount(Buffer.from(info.data), new PublicKey(programs.usdcMint));
}

export interface SponsorHooks {
  buildAndSendReceiveMessage(input: SendReceiveMessageInput): Promise<string>;
  buildAndSendEnsureAta(input: SendEnsureAtaInput): Promise<string>;
}

export function makeSponsorHooks(opts: { connection: Connection; signAndSend?: SignAndSend }): SponsorHooks {
  const signAndSend = opts.signAndSend ?? defaultSignAndSend;

  return {
    async buildAndSendReceiveMessage(input) {
      if (input.cctpVersion === 2) {
        const feeRecipientAta = await resolveFeeRecipientAta(opts.connection, input.programs);
        const receiveIx = buildReceiveMessageV2Instruction({
          payer: input.signer.publicKey,
          messageHex: input.message,
          attestationHex: input.attestation,
          feeRecipientAta,
          usdcMint: input.programs.usdcMint,
          programs: input.programs,
        });
        // Receive-only ≈181K CU fits the 200K default; the ComputeBudget
        // prefix pushes the tx to 1264 > 1232 bytes (live-measured) — omit it.
        return signAndSend(opts.connection, input.signer, [receiveIx], { computeBudget: false });
      }

      // V1: inline idempotent ATA create + receive (fits in one tx).
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        input.signer.publicKey,
        new PublicKey(input.recipientAta),
        new PublicKey(input.recipientPdaOwner),
        new PublicKey(input.programs.usdcMint),
        new PublicKey(input.programs.splTokenProgram),
      );
      const receiveIx = buildReceiveMessageInstruction({
        payer: input.signer.publicKey,
        message: hexToBytes(input.message),
        attestation: hexToBytes(input.attestation),
        programs: input.programs,
      });
      return signAndSend(opts.connection, input.signer, [createAtaIx, receiveIx]);
    },

    async buildAndSendEnsureAta(input) {
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        input.signer.publicKey,
        new PublicKey(input.recipientAta),
        new PublicKey(input.recipientPdaOwner),
        new PublicKey(input.mint),
        new PublicKey(input.splTokenProgram),
      );
      return signAndSend(opts.connection, input.signer, [createAtaIx]);
    },
  };
}
