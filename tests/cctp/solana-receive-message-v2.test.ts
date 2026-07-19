import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  buildReceiveMessageV2Instruction,
  decodeFeeRecipientTokenAccount,
} from "../../src/cctp/solana-receive-message-v2";
import { buildUsdcCctpInboundQuote } from "../../src/route-builders/usdc-cctp-inbound";
import { loadFixtureChain } from "../helpers/chains";

const FIX = join(__dirname, "..", "fixtures", "cctp-v2");
const burn = JSON.parse(readFileSync(join(FIX, "monad-burn-01.json"), "utf8"));
const cfg = JSON.parse(readFileSync(join(FIX, "token-messenger-config-01.json"), "utf8"));

const MT_V2 = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";
const TMM_V2 = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PAYER = new PublicKey("5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA");

const pda = (seeds: (Buffer | Uint8Array)[], programId: string) =>
  PublicKey.findProgramAddressSync(seeds, new PublicKey(programId))[0];

describe("decodeFeeRecipientTokenAccount — captured token_messenger config", () => {
  it("reads the fee-recipient pubkey at offset 109 and derives its USDC ATA", () => {
    const data = Buffer.from(cfg.dataBase64, "base64");
    const ata = decodeFeeRecipientTokenAccount(data, new PublicKey(USDC));
    // Independently derive: fee recipient = data[109..141]
    const feeRecipient = new PublicKey(data.subarray(109, 141));
    const { getAssociatedTokenAddressSync } = require("@solana/spl-token");
    expect(ata.toBase58()).toBe(getAssociatedTokenAddressSync(new PublicKey(USDC), feeRecipient, true).toBase58());
  });

  it("refuses a config account shorter than the pinned layout", () => {
    expect(() => decodeFeeRecipientTokenAccount(Buffer.alloc(100), new PublicKey(USDC))).toThrow(/too short/);
  });
});

describe("buildReceiveMessageV2Instruction — captured Monad burn (domain 15)", () => {
  const feeAta = decodeFeeRecipientTokenAccount(Buffer.from(cfg.dataBase64, "base64"), new PublicKey(USDC));
  const ix = buildReceiveMessageV2Instruction({
    payer: PAYER,
    messageHex: burn.message,
    attestationHex: burn.attestation,
    feeRecipientAta: feeAta,
    usdcMint: USDC,
    programs: { messageTransmitterProgram: MT_V2, tokenMessengerMinterProgram: TMM_V2 },
  });

  it("targets MessageTransmitterV2 with the anchor receive_message discriminator + len-prefixed message/attestation", () => {
    expect(ix.programId.toBase58()).toBe(MT_V2);
    const disc = createHash("sha256").update("global:receive_message").digest().subarray(0, 8);
    expect(Buffer.from(ix.data.subarray(0, 8))).toEqual(disc);
    const msgBytes = Buffer.from(burn.message.slice(2), "hex");
    expect(ix.data.readUInt32LE(8)).toBe(msgBytes.length);
    expect(Buffer.from(ix.data.subarray(12, 12 + msgBytes.length))).toEqual(msgBytes);
  });

  it("derives the V2 PDA set: per-nonce used_nonce, domain-string remote_token_messenger/token_pair", () => {
    const keys = ix.keys.map((k) => k.pubkey.toBase58());
    expect(keys).toHaveLength(20);
    const nonce = Buffer.from(burn.decodedMessage.nonce.slice(2), "hex");
    expect(keys[4]).toBe(pda([Buffer.from("used_nonce"), nonce], MT_V2).toBase58());        // ONE PDA PER NONCE — no V1 bucketing
    expect(keys[10]).toBe(pda([Buffer.from("remote_token_messenger"), Buffer.from("15")], TMM_V2).toBase58()); // source domain as decimal STRING from the message
    // token_pair is seeded by the FULL 32-byte remote-token field (left-padded EVM address)
    const burnToken32 = Buffer.concat([Buffer.alloc(12), Buffer.from(burn.decodedMessage.decodedMessageBody.burnToken.slice(2), "hex")]);
    expect(keys[13]).toBe(pda([Buffer.from("token_pair"), Buffer.from("15"), burnToken32], TMM_V2).toBase58());
    expect(keys[14]).toBe(feeAta.toBase58());
    expect(keys[15]).toBe(new PublicKey(burn.decodedMessage.decodedMessageBody.mintRecipient).toBase58()); // mintRecipient ATA from the message
    expect(keys[17]).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  });

  it("used_nonce is writable; payer signs twice (payer + caller)", () => {
    expect(ix.keys[0]!.isSigner && ix.keys[0]!.isWritable).toBe(true);
    expect(ix.keys[1]!.isSigner).toBe(true);
    expect(ix.keys[4]!.isWritable).toBe(true);
  });
});

describe("V2 quote step plan — ensure-ata precedes receive (its own tx; 1338B > 1232B inline)", () => {
  it("gas mode: burn → ensure-ata → receive → settle, with correct gates", async () => {
    const HADRIAN = await loadFixtureChain("200010");
    const q = buildUsdcCctpInboundQuote({
      amount: "1000000",
      sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: HADRIAN, programId: HADRIAN.romeEvmProgramId!, intent: "gas",
    });
    expect(q.steps.map((s) => s.kind)).toEqual([
      "cctp-approve-and-deposit", "ensure-ata", "cctp-receive-message", "settle-inbound-bridge-sponsored",
    ]);
    const [, ensure, receive, settle] = q.steps;
    expect(ensure!.n).toBe(2);
    expect(ensure!.blockedBy).toEqual(["step-1"]);
    expect(ensure!.recipientAta).toBe(receive!.recipientAta);
    expect(receive!.n).toBe(3);
    expect(receive!.blockedBy).toEqual(["step-1", "step-2", "circle-attestation"]);
    expect(settle!.n).toBe(4);
    expect(settle!.blockedBy).toEqual(["step-3"]);
    expect(ensure!.userSigns).toBe(false);
    expect(ensure!.sponsorPaysFees).toBe(true);
  });

  it("V1 chains keep the 3-step plan (no ensure-ata — V1 receive carries the inline ATA create)", async () => {
    const { syntheticChain, USDC_DEVNET_MINT } = await import("../helpers/chains");
    const v1Chain = syntheticChain({
      chainId: "121301", gasMintId: USDC_DEVNET_MINT,
      bridge: {
        cctpIrisApiBase: "https://iris-api-sandbox.circle.com",
        sourceEvm: { chainId: 11155111, cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5" },
        solana: { cctpDomain: 5 },
        assets: [{ symbol: "USDC", solanaMint: USDC_DEVNET_MINT, sourceEvm: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", protocol: "cctp" } }],
      },
    });
    const q = buildUsdcCctpInboundQuote({
      amount: "1000000",
      sender: { ethereum: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: v1Chain, programId: "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8", intent: "gas",
    });
    expect(q.steps.map((s) => s.kind)).toEqual([
      "cctp-approve-and-deposit", "cctp-receive-message", "settle-inbound-bridge-sponsored",
    ]);
  });
});
