/**
 * executeWormholeReceiveFlow — orchestrates the full 3-stage Solana receive
 * flow for inbound ETH-via-Wormhole transfers.
 *
 * Why this exists: Wormhole's `complete_transfer_wrapped` is the LAST step,
 * not the only step. The full flow needs:
 *
 *   1. `verifySignatures` — multiple ixs (each batched at up to 7 sigs).
 *      Each batch goes in its own tx WITHOUT a ComputeBudget prefix —
 *      the Secp256k1Program writes its verification record to the
 *      instructions sysvar at a fixed instruction index, and the paired
 *      Wormhole-verify ix reads from that exact index. A ComputeBudget
 *      prefix shifts the index and verify fails (observed as custom
 *      program error 0x2 against the Wormhole SDK at the time of
 *      writing — the durable claim is "verify fails because the sysvar
 *      index is wrong"; the specific code may rot if the SDK renumbers).
 *
 *   2. `postVaa` — one tx. Reads the verified signatureSet, creates the
 *      `PostedVAA` PDA.
 *
 *   3. `createAssociatedTokenAccountIdempotent` + `completeTransferWrapped`
 *      — one tx. The complete ix mints wrapped SPL to the recipient ATA
 *      pinned in the VAA's `to` field, but does NOT create the ATA
 *      itself — first-time recipients fail with InvalidAccountData
 *      otherwise. The ATA owner is the user's `external_auth(user,
 *      programId)` PDA on the destination rome-evm program, carried as
 *      `recipientPdaOwner` since it can't be derived from just the VAA.
 *
 * Returns: the completeTransferWrapped tx signature (the final + only
 * useful sig from the integrator's POV; verify/post sigs are inputs).
 *
 * Empirically verified against Solana devnet 2026-05-22 (live
 * trace: 0.001 ETH bridged from Sepolia, landed at chain 9000013).
 */
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { deserialize } from "@wormhole-foundation/sdk-connect";
import { createCompleteTransferWrappedInstruction } from "@wormhole-foundation/sdk-solana-tokenbridge";
import { utils as wormholeCoreUtils } from "@wormhole-foundation/sdk-solana-core";

/** Injectable helper bag — defaults to the real Wormhole SDK; tests stub. */
export interface WormholeReceiveHelpers {
  buildVerifyIxs: (
    connection: Connection, corePid: PublicKey, payer: PublicKey, vaa: ReturnType<typeof deserialize<"TokenBridge:Transfer">>, signatureSet: PublicKey,
  ) => Promise<TransactionInstruction[]>;
  buildPostIx: (
    connection: Connection, corePid: PublicKey, payer: PublicKey, vaa: ReturnType<typeof deserialize<"TokenBridge:Transfer">>, signatureSet: PublicKey,
  ) => TransactionInstruction;
  buildCompleteIx: (
    connection: Connection, tokenBridgePid: PublicKey, corePid: PublicKey, payer: PublicKey, vaa: ReturnType<typeof deserialize<"TokenBridge:Transfer">>,
  ) => Promise<TransactionInstruction>;
  sendTx: (
    connection: Connection, payer: Keypair, signers: Keypair[],
    ixs: TransactionInstruction[], opts: { computeBudget?: boolean },
  ) => Promise<string>;
  /**
   * True when the VAA's PostedVAA account already exists on-chain — a retry
   * after a blip that landed postVaa. Skipping verify+post on resume prevents
   * the permanent strand ("already in use" on the second postVaa) and stops
   * burning sponsor SOL on re-verifies. Errors are treated as "not posted"
   * (fail-open to the full flow — worst case is the pre-guard behavior).
   */
  isVaaPosted: (
    connection: Connection, corePid: PublicKey, vaa: ReturnType<typeof deserialize<"TokenBridge:Transfer">>,
  ) => Promise<boolean>;
}

const defaultHelpers: WormholeReceiveHelpers = {
  buildVerifyIxs: (conn, pid, payer, vaa, sigSet) =>
    wormholeCoreUtils.createVerifySignaturesInstructions(conn, pid, payer, vaa, sigSet),
  buildPostIx: (conn, pid, payer, vaa, sigSet) =>
    wormholeCoreUtils.createPostVaaInstruction(conn, pid, payer, vaa, sigSet),
  buildCompleteIx: (conn, tbPid, corePid, payer, vaa) =>
    Promise.resolve(createCompleteTransferWrappedInstruction(conn, tbPid, corePid, payer, vaa)),
  sendTx: async (conn, payer, signers, ixs, opts) => {
    const tx = new Transaction();
    if (opts.computeBudget) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    for (const ix of ixs) tx.add(ix);
    const allSigners = [payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey))];
    return sendAndConfirmTransaction(conn, tx, allSigners, { commitment: "confirmed" });
  },
  isVaaPosted: async (conn, corePid, vaa) => {
    const postedVaaKey = wormholeCoreUtils.derivePostedVaaKey(corePid, Buffer.from(vaa.hash));
    const info = await conn.getAccountInfo(postedVaaKey, "confirmed");
    return info !== null;
  },
};

export interface ExecuteWormholeReceiveFlowOpts {
  connection: Connection;
  payer: Keypair;
  vaaBytes: Uint8Array;
  tokenBridgePid: PublicKey;
  wormholeCorePid: PublicKey;
  recipientAta: PublicKey;
  recipientPdaOwner: PublicKey;
  wrappedMint: PublicKey;
  splTokenProgram: PublicKey;
  /** Optional injectable helpers for testing. Defaults to real Wormhole SDK + sendAndConfirmTransaction. */
  helpers?: Partial<WormholeReceiveHelpers>;
}

export async function executeWormholeReceiveFlow(
  opts: ExecuteWormholeReceiveFlowOpts,
): Promise<string> {
  const h: WormholeReceiveHelpers = { ...defaultHelpers, ...(opts.helpers ?? {}) };
  const vaa = deserialize("TokenBridge:Transfer", opts.vaaBytes);

  // Resume guard (audit T2#8): a retry after a blip that already landed
  // postVaa must NOT re-run verify+post — the second postVaa on the same
  // PostedVAA account fails ("already in use") → permanent strand, and each
  // re-verify burns sponsor SOL. Best-effort: a check error falls open to the
  // full flow (worst case = pre-guard behavior).
  let alreadyPosted = false;
  try {
    alreadyPosted = await h.isVaaPosted(opts.connection, opts.wormholeCorePid, vaa);
  } catch {
    alreadyPosted = false;
  }

  if (!alreadyPosted) {
  // 1. verifySignatures — fresh signatureSet keypair per receive (single-use).
  const signatureSet = Keypair.generate();
  const verifyIxs = await h.buildVerifyIxs(
    opts.connection, opts.wormholeCorePid, opts.payer.publicKey, vaa, signatureSet.publicKey,
  );
  // SDK returns pairs (Secp256k1 + Wormhole-verify), 1 pair per signature
  // batch (up to 7 sigs per pair). Send 1 pair per tx WITHOUT a ComputeBudget
  // prefix — Secp256k1Program writes its verification record to the
  // instructions sysvar at a FIXED index, and the paired Wormhole-verify ix
  // reads from that exact index. Prefixing ComputeBudget shifts every ix's
  // sysvar position and verify fails (custom error 0x2). The empty `{}` opts
  // below is load-bearing: do NOT "tidy up" by adding `computeBudget: true`
  // here to match postVaa / complete below — those are different stages with
  // no secp coupling.
  for (let i = 0; i < verifyIxs.length; i += 2) {
    const batch = verifyIxs.slice(i, i + 2);
    try {
      await h.sendTx(opts.connection, opts.payer, [signatureSet], batch, {});
    } catch (e) {
      throw new Error(`wormhole receive flow failed at stage "verifySignatures batch ${Math.floor(i / 2) + 1}": ${(e as Error).message}`);
    }
  }

  // 2. postVaa — creates the PostedVAA PDA from the verified signatureSet.
  const postIx = h.buildPostIx(opts.connection, opts.wormholeCorePid, opts.payer.publicKey, vaa, signatureSet.publicKey);
  try {
    await h.sendTx(opts.connection, opts.payer, [], [postIx], { computeBudget: true });
  } catch (e) {
    throw new Error(`wormhole receive flow failed at stage "postVaa": ${(e as Error).message}`);
  }
  } // end !alreadyPosted — stages 1+2 are one-shot per VAA; stage 3 is safe to retry.

  // 3. createATA-idempotent + completeTransferWrapped.
  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    opts.payer.publicKey,
    opts.recipientAta,
    opts.recipientPdaOwner,
    opts.wrappedMint,
    opts.splTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const completeIx = await h.buildCompleteIx(
    opts.connection, opts.tokenBridgePid, opts.wormholeCorePid, opts.payer.publicKey, vaa,
  );
  try {
    return await h.sendTx(opts.connection, opts.payer, [], [createAtaIx, completeIx], { computeBudget: true });
  } catch (e) {
    throw new Error(`wormhole receive flow failed at stage "completeTransferWrapped": ${(e as Error).message}`);
  }
}
