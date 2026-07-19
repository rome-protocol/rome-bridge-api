import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { makeSponsorHooks } from "../../src/sponsor/hooks";

const FIX = join(__dirname, "..", "fixtures", "cctp-v2");
const burn = JSON.parse(readFileSync(join(FIX, "monad-burn-01.json"), "utf8"));
const cfg = JSON.parse(readFileSync(join(FIX, "token-messenger-config-01.json"), "utf8"));

const V1_PROGRAMS = {
  messageTransmitterProgram: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
  tokenMessengerMinterProgram: "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
  splTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};
const V2_PROGRAMS = {
  ...V1_PROGRAMS,
  messageTransmitterProgram: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
  tokenMessengerMinterProgram: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
};
const signer = Keypair.generate();
const RECIPIENT_ATA = new PublicKey(burn.decodedMessage.decodedMessageBody.mintRecipient).toBase58();

function makeConnection() {
  const sent: Array<{ ixs: Array<{ programId: string }> }> = [];
  const connection = {
    getAccountInfo: vi.fn(async () => ({ data: Buffer.from(cfg.dataBase64, "base64") })),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: "9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oGXpEjkgQCiJf", lastValidBlockHeight: 1 })),
    sendRawTransaction: vi.fn(async () => "sigFromStub"),
    confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
  };
  return { connection, sent };
}

describe("makeSponsorHooks — version-keyed production wiring", () => {
  it("V2 receive: single receive_message ix, NO inline ATA create, NO ComputeBudget prefix (1264 > 1232 with it — live-measured), fee ATA from on-chain config", async () => {
    const { connection } = makeConnection();
    const captureIxs = vi.fn(async (_c, _s, ixs: Array<{ programId: PublicKey }>, opts?: { computeBudget?: boolean }) => {
      expect(ixs).toHaveLength(1); // 1338B > 1232B with an inline create — ensure-ata is its own step
      expect(ixs[0]!.programId.toBase58()).toBe(V2_PROGRAMS.messageTransmitterProgram);
      expect(opts?.computeBudget).toBe(false); // receive-only ≈181K CU fits the default; the prefix overflows the tx
      return "sigV2";
    });
    const hooks = makeSponsorHooks({ connection: connection as never, signAndSend: captureIxs as never });
    const sig = await hooks.buildAndSendReceiveMessage({
      message: burn.message, attestation: burn.attestation,
      programs: V2_PROGRAMS, recipientAta: RECIPIENT_ATA,
      recipientPdaOwner: signer.publicKey.toBase58(),
      cctpVersion: 2, signer,
    });
    expect(sig).toBe("sigV2");
    expect(connection.getAccountInfo).toHaveBeenCalled(); // token_messenger config read for the fee ATA
    expect(captureIxs).toHaveBeenCalledTimes(1);
  });

  it("V1 receive keeps the inline idempotent ATA create (2 ixs, V1 program)", async () => {
    const { connection } = makeConnection();
    const captureIxs = vi.fn(async (_c, _s, ixs: Array<{ programId: PublicKey }>) => {
      expect(ixs).toHaveLength(2);
      expect(ixs[0]!.programId.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
      expect(ixs[1]!.programId.toBase58()).toBe(V1_PROGRAMS.messageTransmitterProgram);
      return "sigV1";
    });
    const hooks = makeSponsorHooks({ connection: connection as never, signAndSend: captureIxs as never });
    // A 248-byte V1-shaped message is enough for the builder's parser.
    const v1Message = "0x" + "00".repeat(248);
    const sig = await hooks.buildAndSendReceiveMessage({
      message: v1Message as `0x${string}`, attestation: ("0x" + "22".repeat(65)) as `0x${string}`,
      programs: V1_PROGRAMS, recipientAta: RECIPIENT_ATA,
      recipientPdaOwner: signer.publicKey.toBase58(),
      cctpVersion: 1, signer,
    });
    expect(sig).toBe("sigV1");
  });

  it("ensure-ata hook: one idempotent ATA create for the stamped recipient", async () => {
    const { connection } = makeConnection();
    const captureIxs = vi.fn(async (_c, _s, ixs: Array<{ programId: PublicKey }>) => {
      expect(ixs).toHaveLength(1);
      expect(ixs[0]!.programId.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
      return "sigAta";
    });
    const hooks = makeSponsorHooks({ connection: connection as never, signAndSend: captureIxs as never });
    const sig = await hooks.buildAndSendEnsureAta({
      recipientAta: RECIPIENT_ATA,
      recipientPdaOwner: signer.publicKey.toBase58(),
      mint: V1_PROGRAMS.usdcMint,
      splTokenProgram: V1_PROGRAMS.splTokenProgram,
      signer,
    });
    expect(sig).toBe("sigAta");
  });
});
