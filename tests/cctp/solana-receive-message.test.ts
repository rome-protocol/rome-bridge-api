import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { buildReceiveMessageInstruction, CCTP_DOMAIN_SOLANA } from "../../src/cctp/solana-receive-message.js";
import { parseCctpMessage } from "../../src/cctp/message.js";

// Real Circle CCTP devnet program / mint ids — public constants, used here
// purely to construct syntactically-valid 32-byte base58 pubkeys for PDA
// derivation. The test verifies the builder's logic, not on-chain landing.
const MT_PROGRAM   = "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd";
const TMM_PROGRAM  = "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3";
const SPL_TOKEN    = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const USDC_MINT    = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const PAYER          = new PublicKey("DzFNF2Y7p6F1pVuvHB9axyW6L7Y9ksSjUMt8B5cMGNkM");
const MINT_RECIPIENT = new PublicKey("AAdcgRhJgRD9SncbtwYrxLZpdmsBV5L4ahgcuJVE3CnT");
const SEPOLIA_USDC_PADDED_HEX = "0000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c7238";

function buildMessage(opts: { sourceDomain: number; nonce: bigint; amount: bigint }): Uint8Array {
  const buf = Buffer.alloc(248);
  buf.writeUInt32BE(0, 0);                     // version
  buf.writeUInt32BE(opts.sourceDomain, 4);
  buf.writeUInt32BE(CCTP_DOMAIN_SOLANA, 8);    // destDomain = Solana = 5
  buf.writeBigUInt64BE(opts.nonce, 12);
  // sender/recipient/destCaller stay zero (uninteresting for these tests)
  buf.writeUInt32BE(0, 116);                   // body version
  buf.set(Buffer.from(SEPOLIA_USDC_PADDED_HEX, "hex"), 120);   // burnToken
  buf.set(MINT_RECIPIENT.toBytes(), 152);                       // mintRecipient
  const amtHex = opts.amount.toString(16).padStart(64, "0");
  buf.set(Buffer.from(amtHex, "hex"), 184);                     // amount
  return new Uint8Array(buf);
}

const PROGRAMS = {
  messageTransmitterProgram: MT_PROGRAM,
  tokenMessengerMinterProgram: TMM_PROGRAM,
  splTokenProgram: SPL_TOKEN,
  usdcMint: USDC_MINT,
};

const ATTESTATION = new Uint8Array(Buffer.from(
  "9".repeat(130), // 65-byte fake signature
  "hex",
));

describe("buildReceiveMessageInstruction", () => {
  it("returns an instruction targeting the MessageTransmitter program", () => {
    const message = buildMessage({ sourceDomain: 0, nonce: 12345n, amount: 1_000_000n });
    const ix = buildReceiveMessageInstruction({
      payer: PAYER, message, attestation: ATTESTATION, programs: PROGRAMS,
    });
    expect(ix.programId.toBase58()).toBe(MT_PROGRAM);
  });

  it("emits 19 keys in the documented order with correct signer/writable flags", () => {
    const message = buildMessage({ sourceDomain: 0, nonce: 1n, amount: 1n });
    const ix = buildReceiveMessageInstruction({
      payer: PAYER, message, attestation: ATTESTATION, programs: PROGRAMS,
    });

    expect(ix.keys).toHaveLength(19);

    // payer appears twice: 0 (writable+signer) and 1 (signer-only — Circle's `caller`)
    expect(ix.keys[0]).toEqual({ pubkey: PAYER, isSigner: true,  isWritable: true });
    expect(ix.keys[1]).toEqual({ pubkey: PAYER, isSigner: true,  isWritable: false });

    // system_program at index 6
    expect(ix.keys[6].pubkey.equals(SystemProgram.programId)).toBe(true);

    // recipient_token_account at index 14 = parsed mintRecipient
    expect(ix.keys[14].pubkey.equals(MINT_RECIPIENT)).toBe(true);
    expect(ix.keys[14].isWritable).toBe(true);
    expect(ix.keys[14].isSigner).toBe(false);

    // spl_token_program at index 16
    expect(ix.keys[16].pubkey.toBase58()).toBe(SPL_TOKEN);
  });

  it("derives the documented MessageTransmitter PDAs", () => {
    const message = buildMessage({ sourceDomain: 0, nonce: 1n, amount: 1n });
    const ix = buildReceiveMessageInstruction({
      payer: PAYER, message, attestation: ATTESTATION, programs: PROGRAMS,
    });
    const mtPid = new PublicKey(MT_PROGRAM);
    const [messageTransmitter] = PublicKey.findProgramAddressSync(
      [Buffer.from("message_transmitter")], mtPid,
    );
    const [mtEventAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")], mtPid,
    );

    expect(ix.keys[3].pubkey.equals(messageTransmitter)).toBe(true);
    expect(ix.keys[7].pubkey.equals(mtEventAuthority)).toBe(true);
    expect(ix.keys[8].pubkey.equals(mtPid)).toBe(true);
  });

  it("derives the used_nonces PDA from sourceDomain + nonce-bucket (small domain has no delimiter)", () => {
    // Domain < 11 ⇒ no "-" between domain and bucket start. Bucket start =
    // ((nonce - 1) / 6400) * 6400 + 1. For nonce = 12345 ⇒ bucket start = 12801? Let me work it:
    // (12345 - 1) / 6400 = 1 (integer division) ⇒ 1*6400+1 = 6401
    const nonce = 12345n;
    const message = buildMessage({ sourceDomain: 0, nonce, amount: 1n });
    const ix = buildReceiveMessageInstruction({
      payer: PAYER, message, attestation: ATTESTATION, programs: PROGRAMS,
    });
    const mtPid = new PublicKey(MT_PROGRAM);
    const bucketStart = 6401n;
    const [usedNonces] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("used_nonces"),
        Buffer.from(String(0)),    // sourceDomain
        Buffer.alloc(0),           // no delimiter for domain < 11
        Buffer.from(bucketStart.toString()),
      ],
      mtPid,
    );
    expect(ix.keys[4].pubkey.equals(usedNonces)).toBe(true);
    expect(ix.keys[4].isWritable).toBe(true);
  });

  it("derives the TokenMessengerMinter PDAs (token_messenger, token_minter, local_token, token_pair, custody, event_authority)", () => {
    const message = buildMessage({ sourceDomain: 0, nonce: 1n, amount: 1n });
    const ix = buildReceiveMessageInstruction({
      payer: PAYER, message, attestation: ATTESTATION, programs: PROGRAMS,
    });
    const tmmPid = new PublicKey(TMM_PROGRAM);
    const usdcMintPk = new PublicKey(USDC_MINT);
    const sourceDomain = 0;

    const [tokenMessenger] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_messenger")], tmmPid,
    );
    const [remoteTokenMessenger] = PublicKey.findProgramAddressSync(
      [Buffer.from("remote_token_messenger"), Buffer.from(String(sourceDomain))], tmmPid,
    );
    const [tokenMinter] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_minter")], tmmPid,
    );
    const [localToken] = PublicKey.findProgramAddressSync(
      [Buffer.from("local_token"), usdcMintPk.toBuffer()], tmmPid,
    );
    const burnToken32 = Buffer.from(SEPOLIA_USDC_PADDED_HEX, "hex");
    const [tokenPair] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_pair"), Buffer.from(String(sourceDomain)), burnToken32], tmmPid,
    );
    const [custody] = PublicKey.findProgramAddressSync(
      [Buffer.from("custody"), usdcMintPk.toBuffer()], tmmPid,
    );
    const [tmEventAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")], tmmPid,
    );

    expect(ix.keys[9].pubkey.equals(tokenMessenger)).toBe(true);
    expect(ix.keys[10].pubkey.equals(remoteTokenMessenger)).toBe(true);
    expect(ix.keys[11].pubkey.equals(tokenMinter)).toBe(true);
    expect(ix.keys[11].isWritable).toBe(true);
    expect(ix.keys[12].pubkey.equals(localToken)).toBe(true);
    expect(ix.keys[12].isWritable).toBe(true);
    expect(ix.keys[13].pubkey.equals(tokenPair)).toBe(true);
    expect(ix.keys[15].pubkey.equals(custody)).toBe(true);
    expect(ix.keys[15].isWritable).toBe(true);
    expect(ix.keys[17].pubkey.equals(tmEventAuthority)).toBe(true);
    expect(ix.keys[5].pubkey.equals(tmmPid)).toBe(true);
    expect(ix.keys[18].pubkey.equals(tmmPid)).toBe(true);
  });

  it("encodes the receive_message anchor discriminator + Vec<u8> message + Vec<u8> attestation", () => {
    const message = buildMessage({ sourceDomain: 0, nonce: 1n, amount: 1n });
    const ix = buildReceiveMessageInstruction({
      payer: PAYER, message, attestation: ATTESTATION, programs: PROGRAMS,
    });

    const expectedDisc = crypto.createHash("sha256")
      .update("global:receive_message").digest().subarray(0, 8);
    expect(Buffer.from(ix.data.subarray(0, 8)).equals(expectedDisc)).toBe(true);

    // After disc, we expect u32-LE-length-prefixed Vec<u8>s.
    const data = Buffer.from(ix.data);
    const msgLen = data.readUInt32LE(8);
    expect(msgLen).toBe(message.length);
    const messageSlice = data.subarray(12, 12 + msgLen);
    expect(Buffer.from(messageSlice).equals(Buffer.from(message))).toBe(true);

    const attLenOffset = 12 + msgLen;
    const attLen = data.readUInt32LE(attLenOffset);
    expect(attLen).toBe(ATTESTATION.length);
    const attSlice = data.subarray(attLenOffset + 4, attLenOffset + 4 + attLen);
    expect(Buffer.from(attSlice).equals(Buffer.from(ATTESTATION))).toBe(true);

    // No trailing bytes
    expect(data.length).toBe(8 + 4 + msgLen + 4 + attLen);
  });

  it("inserts a '-' delimiter into used_nonces seeds when sourceDomain >= 11", () => {
    const domain = 11;
    const nonce = 100n;
    const message = buildMessage({ sourceDomain: domain, nonce, amount: 1n });
    const ix = buildReceiveMessageInstruction({
      payer: PAYER, message, attestation: ATTESTATION, programs: PROGRAMS,
    });
    const mtPid = new PublicKey(MT_PROGRAM);
    const bucketStart = 1n;  // (100-1)/6400 = 0 → 0*6400+1 = 1
    const [withDelim] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("used_nonces"),
        Buffer.from(String(domain)),
        Buffer.from("-"),
        Buffer.from(bucketStart.toString()),
      ],
      mtPid,
    );
    expect(ix.keys[4].pubkey.equals(withDelim)).toBe(true);
  });

  it("the parsed message lines up with the test-fixture amount field", () => {
    // Sanity that the test helper agrees with the production parser.
    const message = buildMessage({ sourceDomain: 0, nonce: 1n, amount: 42n });
    const parsed = parseCctpMessage(message);
    expect(parsed.amount).toBe(42n);
    expect(parsed.destDomain).toBe(CCTP_DOMAIN_SOLANA);
  });
});
