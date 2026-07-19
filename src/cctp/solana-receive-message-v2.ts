/**
 * CCTP V2 `receive_message` instruction builder (Solana).
 *
 * Ported from the Rome app's field-proven builder (landed Sepolia + Monad receives
 * reproduce byte-for-byte there). V2-specific facts, validated against landed
 * txs:
 *  - `used_nonce` PDA is seeded by the 32-byte message nonce — ONE PDA PER
 *    MESSAGE; V1's per-domain bucketed `used_nonces` is gone.
 *  - `remote_token_messenger` + `token_pair` are seeded by the SOURCE DOMAIN
 *    as a decimal STRING read from the message — never a constant.
 *  - Account 14 is the fee recipient's token account; the fee-recipient
 *    pubkey lives at offset 109 of the token_messenger config account
 *    (pinned by fixture token-messenger-config-01.json). Resolve on-chain.
 *  - The receive tx CANNOT carry the recipient-ATA create inline: message
 *    (376B) + attestation (130B) overflow the 1232-byte limit (measured
 *    1338). ensure-ata is its own preceding step. Receive-only ≈181K CU —
 *    no compute-budget ix needed.
 *
 * Deviation from the reference: the local USDC mint is an explicit parameter
 * (the caller has it from the step's stamped `programs.usdcMint`), not a
 * hardcoded devnet constant.
 */
import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { parseCctpMessageV2 } from "./message-v2.js";

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const pda = (seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

/**
 * Fee-recipient pubkey offset inside the token_messenger config account —
 * Circle's anchor account layout, stable per program deployment.
 */
const FEE_RECIPIENT_OFFSET = 109;

export function decodeFeeRecipientTokenAccount(tokenMessengerData: Buffer, usdcMint: PublicKey): PublicKey {
  if (tokenMessengerData.length < FEE_RECIPIENT_OFFSET + 32) {
    throw new Error(
      `token_messenger config too short: ${tokenMessengerData.length} bytes (need >= ${FEE_RECIPIENT_OFFSET + 32})`,
    );
  }
  const feeRecipient = new PublicKey(tokenMessengerData.subarray(FEE_RECIPIENT_OFFSET, FEE_RECIPIENT_OFFSET + 32));
  return getAssociatedTokenAddressSync(usdcMint, feeRecipient, true);
}

export interface BuildReceiveMessageV2Params {
  payer: PublicKey;
  /** 0x-hex wire message (148B header + burn body). */
  messageHex: string;
  /** 0x-hex iris attestation. */
  attestationHex: string;
  /** Fee recipient's token account (decodeFeeRecipientTokenAccount). */
  feeRecipientAta: PublicKey;
  /** The chain's local USDC mint (seeds local_token/custody). */
  usdcMint: string;
  programs: {
    messageTransmitterProgram: string;
    tokenMessengerMinterProgram: string;
    splTokenProgram?: string;
  };
}

export function buildReceiveMessageV2Instruction(p: BuildReceiveMessageV2Params): TransactionInstruction {
  const mtProgram = new PublicKey(p.programs.messageTransmitterProgram);
  const tmmProgram = new PublicKey(p.programs.tokenMessengerMinterProgram);
  const splTokenProgram = new PublicKey(p.programs.splTokenProgram ?? SPL_TOKEN_PROGRAM);
  const usdcMint = new PublicKey(p.usdcMint);

  const msgBytes = Buffer.from(p.messageHex.replace(/^0x/, ""), "hex");
  const msg = parseCctpMessageV2(new Uint8Array(msgBytes));
  const domainStr = String(msg.sourceDomain);
  const nonce = Buffer.from(msg.nonce);
  const burnToken = Buffer.from(msg.burnToken);
  const mintRecipientAta = new PublicKey(Buffer.from(msg.mintRecipient));

  const messageTransmitter = pda([Buffer.from("message_transmitter")], mtProgram);
  const authorityPda = pda([Buffer.from("message_transmitter_authority"), tmmProgram.toBuffer()], mtProgram);
  const usedNonce = pda([Buffer.from("used_nonce"), nonce], mtProgram);
  const mtEventAuthority = pda([Buffer.from("__event_authority")], mtProgram);

  const tokenMessenger = pda([Buffer.from("token_messenger")], tmmProgram);
  const remoteTokenMessenger = pda([Buffer.from("remote_token_messenger"), Buffer.from(domainStr)], tmmProgram);
  const tokenMinter = pda([Buffer.from("token_minter")], tmmProgram);
  const localToken = pda([Buffer.from("local_token"), usdcMint.toBuffer()], tmmProgram);
  const tokenPair = pda([Buffer.from("token_pair"), Buffer.from(domainStr), burnToken], tmmProgram);
  const custody = pda([Buffer.from("custody"), usdcMint.toBuffer()], tmmProgram);
  const tmEventAuthority = pda([Buffer.from("__event_authority")], tmmProgram);

  const keys = [
    { pubkey: p.payer, isSigner: true, isWritable: true },
    { pubkey: p.payer, isSigner: true, isWritable: false }, // caller
    { pubkey: authorityPda, isSigner: false, isWritable: false },
    { pubkey: messageTransmitter, isSigner: false, isWritable: false },
    { pubkey: usedNonce, isSigner: false, isWritable: true },
    { pubkey: tmmProgram, isSigner: false, isWritable: false }, // receiver
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: mtEventAuthority, isSigner: false, isWritable: false },
    { pubkey: mtProgram, isSigner: false, isWritable: false },
    // remaining accounts → TokenMessengerMinterV2 handle_receive_*_message
    { pubkey: tokenMessenger, isSigner: false, isWritable: false },
    { pubkey: remoteTokenMessenger, isSigner: false, isWritable: false },
    { pubkey: tokenMinter, isSigner: false, isWritable: true },
    { pubkey: localToken, isSigner: false, isWritable: true },
    { pubkey: tokenPair, isSigner: false, isWritable: false },
    { pubkey: p.feeRecipientAta, isSigner: false, isWritable: true },
    { pubkey: mintRecipientAta, isSigner: false, isWritable: true },
    { pubkey: custody, isSigner: false, isWritable: true },
    { pubkey: splTokenProgram, isSigner: false, isWritable: false },
    { pubkey: tmEventAuthority, isSigner: false, isWritable: false },
    { pubkey: tmmProgram, isSigner: false, isWritable: false },
  ];

  const attBytes = Buffer.from(p.attestationHex.replace(/^0x/, ""), "hex");
  const lenLE = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const discriminator = createHash("sha256").update("global:receive_message").digest().subarray(0, 8);
  const data = Buffer.concat([discriminator, lenLE(msgBytes.length), msgBytes, lenLE(attBytes.length), attBytes]);

  return new TransactionInstruction({ programId: mtProgram, keys, data });
}
