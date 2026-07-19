/**
 * settleAfterReceive — focused unit tests for the post-receive settle helper.
 *
 * Mirrors the entry-point shape of the Rome app's settleAfterReceive (same outcome
 * enum, same gate semantics). bridge-api keeps Solana-side construction behind
 * the injected `buildAndSendSettle` hook because the API process holds no keys.
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { settleAfterReceive, type SettleStepInput } from "../../src/sponsor/settle-after-receive.js";

const HADRIAN_PROGRAM = new PublicKey("RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf");
const USDC_DEVNET     = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const USDT_DEVNET     = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

const baseStep: SettleStepInput = {
  chainId:        "200010",
  user:           "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
  bridgedAmount:  "1000000",
  sourceChain:    "11155111",
  sourceTxHash:   "0x" + "cd".repeat(32) as `0x${string}`,
  rollupProgramId: HADRIAN_PROGRAM.toBase58(),
  mintAddress:    USDC_DEVNET.toBase58(),
};

describe("settleAfterReceive", () => {
  it("happy path: gate passes, hook returns sig -> outcome:'all-gas' + settleTxHash", async () => {
    const signer = Keypair.generate();
    const buildAndSendSettle = vi.fn().mockResolvedValue("5qSETTLE_SIG");
    const getMintForChain = vi.fn().mockResolvedValue(USDC_DEVNET);

    const result = await settleAfterReceive({
      step: baseStep,
      signer,
      buildAndSendSettle,
      getMintForChain,
    });

    expect(result.outcome).toBe("all-gas");
    expect(result.settleTxHash).toBe("5qSETTLE_SIG");
    expect(result.reason).toBeUndefined();
    expect(getMintForChain).toHaveBeenCalledWith(200010n, expect.any(PublicKey));
    expect(buildAndSendSettle).toHaveBeenCalledWith(expect.objectContaining({
      chainId: baseStep.chainId,
      user: baseStep.user,
      bridgedAmount: baseStep.bridgedAmount,
      sourceChain: baseStep.sourceChain,
      sourceTxHash: baseStep.sourceTxHash,
      rollupProgramId: baseStep.rollupProgramId,
      mintAddress: baseStep.mintAddress,
      signer,
    }));
  });

  it("gate refusal: OwnerInfo returns null -> outcome:'wrapper-only' + reason cites OwnerInfo", async () => {
    const buildAndSendSettle = vi.fn();
    const getMintForChain = vi.fn().mockResolvedValue(null);

    const result = await settleAfterReceive({
      step: baseStep,
      signer: Keypair.generate(),
      buildAndSendSettle,
      getMintForChain,
    });

    expect(result.outcome).toBe("wrapper-only");
    expect(result.reason).toMatch(/OwnerInfo did not return/i);
    expect(result.settleTxHash).toBeUndefined();
    expect(buildAndSendSettle).not.toHaveBeenCalled();
  });

  it("gate refusal: OwnerInfo mint differs from step mint -> outcome:'wrapper-only' + reason cites mismatch", async () => {
    const buildAndSendSettle = vi.fn();
    const getMintForChain = vi.fn().mockResolvedValue(USDT_DEVNET);  // on-chain says USDT

    const result = await settleAfterReceive({
      step: { ...baseStep, mintAddress: USDC_DEVNET.toBase58() },  // step claims USDC
      signer: Keypair.generate(),
      buildAndSendSettle,
      getMintForChain,
    });

    expect(result.outcome).toBe("wrapper-only");
    expect(result.reason).toMatch(/OwnerInfo mint .* != step.mintAddress/);
    expect(result.reason).toContain(USDT_DEVNET.toBase58());
    expect(result.reason).toContain(USDC_DEVNET.toBase58());
    expect(buildAndSendSettle).not.toHaveBeenCalled();
  });

  it("no getMintForChain provided: gate is skipped, settle proceeds (legacy fallthrough)", async () => {
    const buildAndSendSettle = vi.fn().mockResolvedValue("5qNO_GATE_SIG");

    const result = await settleAfterReceive({
      step: baseStep,
      signer: Keypair.generate(),
      buildAndSendSettle,
      // no getMintForChain
    });

    expect(result.outcome).toBe("all-gas");
    expect(result.settleTxHash).toBe("5qNO_GATE_SIG");
    expect(buildAndSendSettle).toHaveBeenCalledTimes(1);
  });

  it("send failure: gate passes but buildAndSendSettle throws -> outcome:'settle-skipped' + reason cites send", async () => {
    const buildAndSendSettle = vi.fn().mockRejectedValue(new Error("rpc rejected"));
    const getMintForChain = vi.fn().mockResolvedValue(USDC_DEVNET);

    const result = await settleAfterReceive({
      step: baseStep,
      signer: Keypair.generate(),
      buildAndSendSettle,
      getMintForChain,
    });

    expect(result.outcome).toBe("settle-skipped");
    expect(result.reason).toMatch(/settle send failed: rpc rejected/);
    expect(result.settleTxHash).toBeUndefined();
  });
});
