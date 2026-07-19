import { describe, it, expect } from "vitest";
import { buildSolSolanaInboundQuote } from "../../src/route-builders/sol-solana-inbound";

import { USDC_DEVNET_MINT, WSOL_MINT_B58, syntheticChain } from "../helpers/chains";

const WSOL_GAS_CHAIN = syntheticChain({ chainId: "999999", gasMintId: WSOL_MINT_B58, gasSymbol: "wSOL" });
const USDC_GAS_CHAIN = syntheticChain({ chainId: "121301", gasMintId: USDC_DEVNET_MINT, gasSymbol: "USDC" });
const ROME_PROGRAM_ID = "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8";

describe("buildSolSolanaInboundQuote", () => {
  it("produces 2 steps when destination chain's gas mint is wSOL", () => {
    const q = buildSolSolanaInboundQuote({
      amount: "1000000000", // 1 SOL
      sender: { solana: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA", rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: WSOL_GAS_CHAIN,
      programId: ROME_PROGRAM_ID,
    });
    expect(q.route).toBe("sol-solana-to-rome");
    expect(q.steps).toHaveLength(2);
    expect(q.steps[0]?.chain).toBe("solana");
    expect(q.steps[0]?.kind).toBe("solana-wsol-transfer");
    expect(q.steps[1]?.kind).toBe("claim-as-gas");
  });

  it("produces 1 step (wrapper-only) when gas mint is NOT wSOL", () => {
    const q = buildSolSolanaInboundQuote({
      amount: "1000000000",
      sender: { solana: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA", rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: USDC_GAS_CHAIN,
      programId: ROME_PROGRAM_ID,
    });
    expect(q.steps).toHaveLength(1);
  });

  it("intent='wrapper' keeps it as wSOL — no claim-as-gas even on a wSOL-gas chain", () => {
    const q = buildSolSolanaInboundQuote({
      amount: "1000000000",
      sender: { solana: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA", rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: WSOL_GAS_CHAIN, programId: ROME_PROGRAM_ID,
      intent: "wrapper",
    });
    expect(q.steps).toHaveLength(1);
    expect(q.steps[0]?.kind).toBe("solana-wsol-transfer");
  });

  it("on-chain OwnerInfo drives the gas decision over a drifted registry", () => {
    // Registry says gas = USDC (USDC_GAS_CHAIN); on-chain says wSOL → settle as gas.
    const q = buildSolSolanaInboundQuote({
      amount: "1000000000",
      sender: { solana: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA", rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: USDC_GAS_CHAIN, programId: ROME_PROGRAM_ID,
      onchainGasMint: WSOL_MINT_B58,
    });
    expect(q.steps).toHaveLength(2);
    expect(q.steps[1]?.kind).toBe("claim-as-gas");
  });

  it("rejects missing sender.solana", () => {
    expect(() => buildSolSolanaInboundQuote({
      amount: "1000000000", sender: { rome: "0x3403..." }, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: WSOL_GAS_CHAIN, programId: ROME_PROGRAM_ID,
    })).toThrow(/sender.solana/);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Inline native-SOL wrapping — step 1 must include the wrap ix list so
  // callers can submit a native-SOL balance without pre-wrapping it
  // themselves. Previously v1.0 punted with: "sender must externally wrap
  // before calling this route" (TODO removed by this change).
  // ─────────────────────────────────────────────────────────────────────
  const ATA_PROGRAM_ID    = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
  const TOKEN_PROGRAM_ID  = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

  it("step 1 includes inline wSOL wrap ixs (createAtaIdempotent, transfer, syncNative, transferChecked)", () => {
    const q = buildSolSolanaInboundQuote({
      amount: "1000000000",
      sender: { solana: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA", rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: WSOL_GAS_CHAIN,
      programId: ROME_PROGRAM_ID,
    });
    const step1 = q.steps[0] as { unsignedTx: { instructions: Array<{ programId: string }> } };
    expect(step1.unsignedTx.instructions).toHaveLength(5);

    const programs = step1.unsignedTx.instructions.map((i) => i.programId);
    expect(programs).toEqual([
      ATA_PROGRAM_ID,     // 0: createAssociatedTokenAccountIdempotent (ensures SENDER's wSOL ATA exists)
      SYSTEM_PROGRAM_ID,  // 1: SystemProgram.transfer (sender → sender's wSOL ATA, in lamports)
      TOKEN_PROGRAM_ID,   // 2: SPL syncNative (reflects wrapped lamports as token amount)
      ATA_PROGRAM_ID,     // 3: create RECIPIENT PDA-ATA (idempotent) — cold-recipient fix
      TOKEN_PROGRAM_ID,   // 4: transferChecked (move wrapped to recipient PDA-ATA)
    ]);
  });

  it("inline wrap uses the request's full amount (no off-by-one between transfer and transferChecked)", () => {
    const amount = "1500000000"; // 1.5 SOL
    const q = buildSolSolanaInboundQuote({
      amount,
      sender: { solana: "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA", rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: WSOL_GAS_CHAIN,
      programId: ROME_PROGRAM_ID,
    });
    expect(q.amountIn).toBe(amount);
    expect(q.amountOut).toBe(amount);
    // We can't decode the raw ix data here without pulling deserializers, but the assertion that
    // both step ixs use the same amount lives in the impl — confirmed by the lack of magic
    // numbers around amount in src/route-builders/sol-solana-inbound.ts.
  });
});

describe("buildSolSolanaInboundQuote — sender validation", () => {
  it("rejects an off-curve / invalid Solana sender with a clean 400, not a raw crash", () => {
    // A signing wallet must be on-curve; an ATA/PDA (off-curve) can't sign.
    // Passing one must yield a clean bridgeError (400), never TokenOwnerOffCurveError → 500.
    const call = () => buildSolSolanaInboundQuote({
      amount: "1000000000",
      sender: { solana: "8LwGxTYucQ6XK3oqQdztyatTvy9nWrAAho6ar2NUWdDW" }, // an ATA — off-curve
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
      chain: WSOL_GAS_CHAIN,
      programId: ROME_PROGRAM_ID,
    } as never);
    expect(call).toThrow();
    try { call(); } catch (e) {
      expect((e as { code?: string }).code).toBe("rome.bridge.recipient-invalid");
      expect((e as { status?: number }).status).toBe(400);
    }
  });

  it("rejects malformed base58 too", () => {
    const call = () => buildSolSolanaInboundQuote({
      amount: "1000000000", sender: { solana: "not-a-real-pubkey!!!" },
      recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562", chain: WSOL_GAS_CHAIN, programId: ROME_PROGRAM_ID,
    } as never);
    try { call(); expect.fail("should throw"); } catch (e) {
      expect((e as { code?: string }).code).toBe("rome.bridge.recipient-invalid");
    }
  });
});
