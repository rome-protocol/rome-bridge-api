import { describe, it, expect } from "vitest";
import { buildUsdcSolanaInboundQuote } from "../../src/route-builders/usdc-solana-inbound";
import { USDC_DEVNET_MINT, WSOL_MINT_B58, syntheticChain } from "../helpers/chains";

const HADRIAN_USDC_GAS = syntheticChain({ chainId: "121301", gasMintId: USDC_DEVNET_MINT, gasSymbol: "USDC" });
const NON_USDC_GAS_CHAIN = syntheticChain({ chainId: "999999", gasMintId: WSOL_MINT_B58, gasSymbol: "wSOL" });
const ROME_PROGRAM_ID = "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8";

describe("buildUsdcSolanaInboundQuote", () => {
  it("produces 2 steps when destination chain's gas mint is USDC", () => {
    const q = buildUsdcSolanaInboundQuote({
      amount: "100000000",
      sender: { solana: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA", rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: HADRIAN_USDC_GAS,
      programId: ROME_PROGRAM_ID,
    });
    expect(q.route).toBe("usdc-solana-to-rome");
    expect(q.steps).toHaveLength(2);
    expect(q.steps[0]?.chain).toBe("solana");
    expect(q.steps[0]?.kind).toBe("solana-spl-transfer");
    expect(q.steps[1]?.chain).toBe("rome-121301");
    expect(q.steps[1]?.kind).toBe("claim-as-gas");
  });

  it("produces 1 step when destination chain's gas mint is NOT USDC (wrap-token only)", () => {
    const q = buildUsdcSolanaInboundQuote({
      amount: "100000000",
      sender: { solana: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA", rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: NON_USDC_GAS_CHAIN,
      programId: ROME_PROGRAM_ID,
    });
    expect(q.steps).toHaveLength(1);
    expect(q.steps[0]?.kind).toBe("solana-spl-transfer");
  });

  it("intent='wrapper' keeps it as wUSDC — no claim-as-gas even on a USDC-gas chain", () => {
    const q = buildUsdcSolanaInboundQuote({
      amount: "100000000",
      sender: { solana: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA", rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: HADRIAN_USDC_GAS, programId: ROME_PROGRAM_ID,
      intent: "wrapper",
    });
    expect(q.steps).toHaveLength(1);
    expect(q.steps[0]?.kind).toBe("solana-spl-transfer");
  });

  it("on-chain OwnerInfo drives the gas decision over a drifted registry", () => {
    // Registry says gas = wSOL (NON_USDC_GAS_CHAIN); on-chain says USDC → settle as gas.
    const q = buildUsdcSolanaInboundQuote({
      amount: "100000000",
      sender: { solana: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA", rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: NON_USDC_GAS_CHAIN, programId: ROME_PROGRAM_ID,
      onchainGasMint: USDC_DEVNET_MINT,
    });
    expect(q.steps).toHaveLength(2);
    expect(q.steps[1]?.kind).toBe("claim-as-gas");
  });

  it("rejects missing sender.solana", () => {
    expect(() => buildUsdcSolanaInboundQuote({
      amount: "100000000", sender: { rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: HADRIAN_USDC_GAS, programId: ROME_PROGRAM_ID,
    })).toThrow(/sender.solana/);
  });

  // Cold-recipient fix: a first-time recipient's Rome PDA-ATA does not
  // exist yet; step 1 must create it (idempotent) BEFORE transferChecked, or
  // the transfer fails on a brand-new recipient.
  it("step 1 creates the recipient PDA-ATA before transferring (cold path)", () => {
    const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
    const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const q = buildUsdcSolanaInboundQuote({
      amount: "100000000",
      sender: { solana: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA", rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: HADRIAN_USDC_GAS, programId: ROME_PROGRAM_ID,
    });
    const step1 = q.steps[0] as { unsignedTx: { instructions: Array<{ programId: string }> } };
    expect(step1.unsignedTx.instructions.map((i) => i.programId)).toEqual([
      ATA_PROGRAM_ID,   // 0: create recipient PDA-ATA (idempotent)
      TOKEN_PROGRAM_ID, // 1: transferChecked → recipient PDA-ATA
    ]);
  });
});
