/**
 * Solana `MessageTransmitter.receiveMessage` instruction builder.
 *
 * The sponsor worker calls this after Task 2 (Sepolia parse) + Circle IRIS
 * attestation fetch. The instruction is the only Solana tx the sponsor pays
 * for in the CCTP path — Circle's `TokenMessengerMinter` is reached via
 * Solana CPI inside `receiveMessage`, which mints the burned USDC into the
 * mintRecipient ATA carried inside the message.
 *
 * Caller responsibility:
 *   - All program / mint ids come from `chain.bridge.solana.*` in the
 *     registry; nothing is hardcoded here.
 *   - The payer is the sponsor's keypair. Circle's `caller` slot is the same
 *     pubkey (signer-only), matching Circle's own quickstart pattern.
 *
 * Reference: the Rome app/src/server/bridge/solana/receiveMessage.ts (same wire
 * structure; this version is registry-config-driven and stateless).
 */

import crypto from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { parseCctpMessage } from "./message.js";

/** CCTP destination domain for Solana. */
export const CCTP_DOMAIN_SOLANA = 5;

/** Anchor-prog `used_nonces` accounts are bucketed in groups of this size. */
const MAX_NONCES_PER_PDA = 6400n;

export interface CctpReceiveProgramIds {
  /** Circle `MessageTransmitter` program (e.g. `CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd` on devnet). */
  messageTransmitterProgram: string;
  /** Circle `TokenMessengerMinter` program (e.g. `CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3` on devnet). */
  tokenMessengerMinterProgram: string;
  /** SPL Token program (classic). */
  splTokenProgram: string;
  /** USDC SPL mint on the target Solana cluster. */
  usdcMint: string;
}

export interface BuildReceiveMessageParams {
  /** Sponsor pubkey — also occupies Circle's `caller` slot. */
  payer: PublicKey;
  /** Raw CCTP message bytes from `parseSepoliaCctpMessage(...).message`. */
  message: Uint8Array;
  /** Circle IRIS attestation bytes (typically 65 bytes / one signature on sandbox). */
  attestation: Uint8Array;
  /** Per-deployment program / mint ids, threaded from chain config. */
  programs: CctpReceiveProgramIds;
}

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function anchorDiscriminator(name: string): Buffer {
  return crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function encodeVecU8(bytes: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, Buffer.from(bytes)]);
}

function deriveUsedNonces(
  sourceDomain: number,
  nonce: bigint,
  messageTransmitterPid: PublicKey,
): PublicKey {
  const bucketStart = ((nonce - 1n) / MAX_NONCES_PER_PDA) * MAX_NONCES_PER_PDA + 1n;
  // Circle inserts a "-" delimiter between domain and bucket-start only when
  // the source-domain text representation is multi-digit (domain >= 11).
  const delimiter = sourceDomain < 11 ? Buffer.alloc(0) : Buffer.from("-");
  return pda(
    [
      Buffer.from("used_nonces"),
      Buffer.from(String(sourceDomain)),
      delimiter,
      Buffer.from(bucketStart.toString()),
    ],
    messageTransmitterPid,
  );
}

export function buildReceiveMessageInstruction(
  p: BuildReceiveMessageParams,
): TransactionInstruction {
  const parsed = parseCctpMessage(p.message);

  const messageTransmitterPid   = new PublicKey(p.programs.messageTransmitterProgram);
  const tokenMessengerMinterPid = new PublicKey(p.programs.tokenMessengerMinterProgram);
  const splTokenPid             = new PublicKey(p.programs.splTokenProgram);
  const usdcMint                = new PublicKey(p.programs.usdcMint);

  const messageTransmitter = pda([Buffer.from("message_transmitter")], messageTransmitterPid);
  const authorityPda = pda(
    [Buffer.from("message_transmitter_authority"), tokenMessengerMinterPid.toBuffer()],
    messageTransmitterPid,
  );
  const mtEventAuthority = pda([Buffer.from("__event_authority")], messageTransmitterPid);
  const usedNonces = deriveUsedNonces(parsed.sourceDomain, parsed.nonce, messageTransmitterPid);

  const tokenMessenger = pda([Buffer.from("token_messenger")], tokenMessengerMinterPid);
  const remoteTokenMessenger = pda(
    [Buffer.from("remote_token_messenger"), Buffer.from(String(parsed.sourceDomain))],
    tokenMessengerMinterPid,
  );
  const tokenMinter = pda([Buffer.from("token_minter")], tokenMessengerMinterPid);
  const localToken = pda(
    [Buffer.from("local_token"), usdcMint.toBuffer()],
    tokenMessengerMinterPid,
  );
  const tokenPair = pda(
    [Buffer.from("token_pair"), Buffer.from(String(parsed.sourceDomain)), Buffer.from(parsed.burnToken)],
    tokenMessengerMinterPid,
  );
  const custodyTokenAccount = pda(
    [Buffer.from("custody"), usdcMint.toBuffer()],
    tokenMessengerMinterPid,
  );
  const tmEventAuthority = pda([Buffer.from("__event_authority")], tokenMessengerMinterPid);

  const recipientTokenAccount = new PublicKey(parsed.mintRecipient);

  const data = Buffer.concat([
    anchorDiscriminator("receive_message"),
    encodeVecU8(p.message),
    encodeVecU8(p.attestation),
  ]);

  const keys = [
    { pubkey: p.payer,                  isSigner: true,  isWritable: true  },
    { pubkey: p.payer,                  isSigner: true,  isWritable: false },
    { pubkey: authorityPda,             isSigner: false, isWritable: false },
    { pubkey: messageTransmitter,       isSigner: false, isWritable: false },
    { pubkey: usedNonces,               isSigner: false, isWritable: true  },
    { pubkey: tokenMessengerMinterPid,  isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
    { pubkey: mtEventAuthority,         isSigner: false, isWritable: false },
    { pubkey: messageTransmitterPid,    isSigner: false, isWritable: false },
    { pubkey: tokenMessenger,           isSigner: false, isWritable: false },
    { pubkey: remoteTokenMessenger,     isSigner: false, isWritable: false },
    { pubkey: tokenMinter,              isSigner: false, isWritable: true  },
    { pubkey: localToken,               isSigner: false, isWritable: true  },
    { pubkey: tokenPair,                isSigner: false, isWritable: false },
    { pubkey: recipientTokenAccount,    isSigner: false, isWritable: true  },
    { pubkey: custodyTokenAccount,      isSigner: false, isWritable: true  },
    { pubkey: splTokenPid,              isSigner: false, isWritable: false },
    { pubkey: tmEventAuthority,         isSigner: false, isWritable: false },
    { pubkey: tokenMessengerMinterPid,  isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: messageTransmitterPid, keys, data });
}
