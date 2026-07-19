/**
 * executeWormholeReceiveFlow — orchestrates the full 3-stage Wormhole
 * Solana receive flow. Tests pin the sequencing + error-context contract.
 *
 * The Wormhole SDK helpers are injectable; tests stub them so the
 * sequencing logic is testable without spinning up a real Solana node.
 * Empirical end-to-end verification lives at a live trace.
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair, PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { executeWormholeReceiveFlow, type WormholeReceiveHelpers } from "../../src/wormhole/execute-receive-flow.js";

const TOKEN_BRIDGE = new PublicKey("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
const CORE_BRIDGE  = new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
const WRAPPED_MINT = new PublicKey("6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs");
const SPL_TOKEN    = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const RECIPIENT_ATA = new PublicKey("HTt1t24QmDwGX3Z55cZfFvEb59JqksL2QQcFvmqNGXZf");
const RECIPIENT_OWNER = new PublicKey("937xewFZSHPRQTXKQhLKAGQRFdoQQo4YqiGEq28R45Xt");

function syntheticVaaBytes(): Uint8Array {
  // Minimum body the SDK's TokenBridge:Transfer deserializer accepts.
  const bodyPrefix =
    "12345678" + "00000001" + "2712" +
    "00".repeat(12) + "db5492265f6038831e89f495670ff909ade94bd9" +
    "0000000000000064" + "00";
  const payload =
    "01" +
    "00".repeat(24) + "00000000000186a0" +
    "00".repeat(12) + "eef12a83ee5b7161d3873317c8e0e7b76e0b5d9c" +
    "2712" +
    "f49dc65f2a9d4c1a234698c6112facb251e1450cce0686c068a44b5bcf5619c6" +
    "0001" +
    "00".repeat(32);
  const hex = "01" + "00000000" + "00" + bodyPrefix + payload;
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function makeIx(label: string): TransactionInstruction {
  // Synthetic ix — real PublicKey not used by orchestrator tests
  return {
    programId: new PublicKey("11111111111111111111111111111111"),
    keys: [],
    data: Buffer.from(label, "utf8"),
  } as unknown as TransactionInstruction;
}

function makeHelpers(verifyPairsCount: number): {
  helpers: Partial<WormholeReceiveHelpers>;
  sentTxs: Array<{ ixsLabels: string[]; computeBudget: boolean }>;
} {
  const sentTxs: Array<{ ixsLabels: string[]; computeBudget: boolean }> = [];
  let nextSig = 0;
  const verifyIxs: TransactionInstruction[] = [];
  for (let i = 0; i < verifyPairsCount; i++) {
    verifyIxs.push(makeIx(`verify-secp-${i}`));
    verifyIxs.push(makeIx(`verify-wh-${i}`));
  }
  const helpers: Partial<WormholeReceiveHelpers> = {
    buildVerifyIxs: vi.fn(async () => verifyIxs),
    buildPostIx: vi.fn(() => makeIx("post")),
    buildCompleteIx: vi.fn(async () => makeIx("complete")),
    sendTx: vi.fn(async (_conn, _payer, _signers, ixs, opts) => {
      sentTxs.push({
        ixsLabels: ixs.map((i) => Buffer.from(i.data as Buffer).toString("utf8")),
        computeBudget: !!opts.computeBudget,
      });
      return `sig_${nextSig++}`;
    }),
  };
  return { helpers, sentTxs };
}

const stubConn = {} as Connection;

describe("executeWormholeReceiveFlow", () => {
  it("runs verifySignatures (no CB) → postVaa (CB) → createATA+complete (CB) in order; returns final sig", async () => {
    const { helpers, sentTxs } = makeHelpers(1);  // 1 verify pair = 1 tx

    const sig = await executeWormholeReceiveFlow({
      connection: stubConn,
      payer: Keypair.generate(),
      vaaBytes: syntheticVaaBytes(),
      tokenBridgePid: TOKEN_BRIDGE,
      wormholeCorePid: CORE_BRIDGE,
      recipientAta: RECIPIENT_ATA,
      recipientPdaOwner: RECIPIENT_OWNER,
      wrappedMint: WRAPPED_MINT,
      splTokenProgram: SPL_TOKEN,
      helpers,
    });

    // 3 txs total: verify batch, post, complete
    expect(sentTxs).toHaveLength(3);

    // 1: verify pair, no compute budget (Secp256k1 sysvar index is sacred)
    expect(sentTxs[0]?.ixsLabels).toEqual(["verify-secp-0", "verify-wh-0"]);
    expect(sentTxs[0]?.computeBudget).toBe(false);

    // 2: postVaa with compute budget
    expect(sentTxs[1]?.ixsLabels).toEqual(["post"]);
    expect(sentTxs[1]?.computeBudget).toBe(true);

    // 3: createATA + complete in one tx, compute budget
    expect(sentTxs[2]?.ixsLabels[1]).toBe("complete");
    expect(sentTxs[2]?.computeBudget).toBe(true);

    // Returns the completeTransfer sig (3rd tx's sig = sig_2)
    expect(sig).toBe("sig_2");
  });

  it("batches multiple verify pairs into separate txs when the SDK returns N pairs", async () => {
    const { helpers, sentTxs } = makeHelpers(3);  // 3 verify pairs = 3 verify txs + post + complete = 5 total

    await executeWormholeReceiveFlow({
      connection: stubConn,
      payer: Keypair.generate(),
      vaaBytes: syntheticVaaBytes(),
      tokenBridgePid: TOKEN_BRIDGE,
      wormholeCorePid: CORE_BRIDGE,
      recipientAta: RECIPIENT_ATA,
      recipientPdaOwner: RECIPIENT_OWNER,
      wrappedMint: WRAPPED_MINT,
      splTokenProgram: SPL_TOKEN,
      helpers,
    });

    expect(sentTxs).toHaveLength(5);
    expect(sentTxs.slice(0, 3).every((t) => !t.computeBudget)).toBe(true);
  });

  it("wraps verify-stage send failure with stage label in the error message", async () => {
    const { helpers } = makeHelpers(1);
    let nthSend = 0;
    (helpers.sendTx as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (nthSend++ === 0) throw new Error("rpc rejected");
      return "sig_x";
    });

    await expect(executeWormholeReceiveFlow({
      connection: stubConn,
      payer: Keypair.generate(),
      vaaBytes: syntheticVaaBytes(),
      tokenBridgePid: TOKEN_BRIDGE,
      wormholeCorePid: CORE_BRIDGE,
      recipientAta: RECIPIENT_ATA,
      recipientPdaOwner: RECIPIENT_OWNER,
      wrappedMint: WRAPPED_MINT,
      splTokenProgram: SPL_TOKEN,
      helpers,
    })).rejects.toThrow(/verifySignatures.*rpc rejected/i);
  });

  it("wraps postVaa-stage failure with stage label", async () => {
    const { helpers } = makeHelpers(1);
    let nthSend = 0;
    (helpers.sendTx as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (nthSend++ === 1) throw new Error("post failed");
      return "sig_x";
    });

    await expect(executeWormholeReceiveFlow({
      connection: stubConn,
      payer: Keypair.generate(),
      vaaBytes: syntheticVaaBytes(),
      tokenBridgePid: TOKEN_BRIDGE,
      wormholeCorePid: CORE_BRIDGE,
      recipientAta: RECIPIENT_ATA,
      recipientPdaOwner: RECIPIENT_OWNER,
      wrappedMint: WRAPPED_MINT,
      splTokenProgram: SPL_TOKEN,
      helpers,
    })).rejects.toThrow(/postVaa.*post failed/i);
  });

  it("wraps completeTransferWrapped-stage failure with stage label", async () => {
    const { helpers } = makeHelpers(1);
    let nthSend = 0;
    (helpers.sendTx as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (nthSend++ === 2) throw new Error("InvalidAccountData");
      return "sig_x";
    });

    await expect(executeWormholeReceiveFlow({
      connection: stubConn,
      payer: Keypair.generate(),
      vaaBytes: syntheticVaaBytes(),
      tokenBridgePid: TOKEN_BRIDGE,
      wormholeCorePid: CORE_BRIDGE,
      recipientAta: RECIPIENT_ATA,
      recipientPdaOwner: RECIPIENT_OWNER,
      wrappedMint: WRAPPED_MINT,
      splTokenProgram: SPL_TOKEN,
      helpers,
    })).rejects.toThrow(/completeTransferWrapped.*InvalidAccountData/i);
  });
});

describe("executeWormholeReceiveFlow — PostedVAA resume guard (audit T2#8)", () => {
  // The stall this closes: a blip AFTER postVaa re-ran the whole flow on the
  // next retry with a FRESH signatureSet; the second postVaa on the same
  // PostedVAA account fails ("already in use") — permanent strand + sponsor
  // SOL drained on re-verifies. When the VAA is already posted, skip straight
  // to the complete stage.
  const base = () => ({
    connection: stubConn,
    payer: Keypair.generate(),
    vaaBytes: syntheticVaaBytes(),
    tokenBridgePid: TOKEN_BRIDGE,
    wormholeCorePid: CORE_BRIDGE,
    recipientAta: RECIPIENT_ATA,
    recipientPdaOwner: RECIPIENT_OWNER,
    wrappedMint: WRAPPED_MINT,
    splTokenProgram: SPL_TOKEN,
  });

  it("skips verify + postVaa when the VAA is already posted (retry after a post-stage blip)", async () => {
    const { helpers, sentTxs } = makeHelpers(2);
    helpers.isVaaPosted = vi.fn(async () => true);

    const sig = await executeWormholeReceiveFlow({ ...base(), helpers });

    expect(sentTxs).toHaveLength(1); // ONLY createATA+complete
    expect(sentTxs[0]?.ixsLabels[1]).toBe("complete");
    expect(helpers.buildVerifyIxs).not.toHaveBeenCalled();
    expect(helpers.buildPostIx).not.toHaveBeenCalled();
    expect(sig).toBe("sig_0");
  });

  it("runs the full 3-stage flow when the VAA is not yet posted", async () => {
    const { helpers, sentTxs } = makeHelpers(1);
    helpers.isVaaPosted = vi.fn(async () => false);
    await executeWormholeReceiveFlow({ ...base(), helpers });
    expect(sentTxs).toHaveLength(3);
  });

  it("fails OPEN to the full flow when the posted-check itself errors (guard is best-effort)", async () => {
    const { helpers, sentTxs } = makeHelpers(1);
    helpers.isVaaPosted = vi.fn(async () => { throw new Error("rpc blip"); });
    await executeWormholeReceiveFlow({ ...base(), helpers });
    expect(sentTxs).toHaveLength(3);
  });
});
