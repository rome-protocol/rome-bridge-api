import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { bytesToHex, decodeFunctionData, parseAbi } from "viem";
import { buildSolSolanaOutboundQuote } from "../../src/route-builders/sol-solana-outbound";

import { USDC_DEVNET_MINT, WSOL_MINT_B58, ROME_BRIDGE_WITHDRAW, syntheticChain } from "../helpers/chains";

const WSOL_WRAPPER = "0x1234567890abcdef1234567890abcdef12345678";
const RECIPIENT_B58 = "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA";
const RECIPIENT_BYTES32 = bytesToHex(new PublicKey(RECIPIENT_B58).toBytes());
const WSOL_BYTES32 = bytesToHex(new PublicKey(WSOL_MINT_B58).toBytes());
const ROME_PROGRAM_ID = "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8";
const WITHDRAW_PRECOMPILE = "0x4200000000000000000000000000000000000016";
const SENDER = "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562";

const WITHDRAW_ABI = parseAbi(["function withdrawal(bytes32 recipient)"]);
// Corrected egress: mint-explicit 3-arg on RomeBridgeWithdraw (NOT the cached
// ERC20-SPL wrapper, which has no egress selectors).
const BRIDGE_EGRESS_ABI = parseAbi([
  "function ensureRecipientAta(bytes32 solanaRecipient, bytes32 mint)",
  "function bridgeOutToSolana(bytes32 solanaRecipient, uint256 amount, bytes32 mint)",
]);

// SOL-gas chain whose registry gasToken DRIFTED to USDC. wSOL wrapper present.
const DRIFTED_SOL_GAS_CHAIN = syntheticChain({
  chainId: "888888",
  gasMintId: USDC_DEVNET_MINT,
  tokens: [{ kind: "spl_wrapper", assetRef: "sol", symbol: "wSOL", address: WSOL_WRAPPER, mintId: WSOL_MINT_B58 }],
});
// USDC-gas chain (Hadrian): SOL is a plain wrapper here.
const USDC_GAS_CHAIN = syntheticChain({
  chainId: "121301",
  gasMintId: USDC_DEVNET_MINT,
  tokens: [{ kind: "spl_wrapper", assetRef: "sol", symbol: "wSOL", address: WSOL_WRAPPER, mintId: WSOL_MINT_B58 }],
});

describe("buildSolSolanaOutboundQuote — on-chain gas-relative routing", () => {
  it("on-chain OwnerInfo (SOL=gas) → native withdrawal, EVEN when the registry drifted to USDC", () => {
    const q = buildSolSolanaOutboundQuote({
      amount: "1000000000", // 1 SOL (9-dec)
      sender: { rome: SENDER }, recipient: RECIPIENT_B58,
      chain: DRIFTED_SOL_GAS_CHAIN, programId: ROME_PROGRAM_ID,
      onchainGasMint: WSOL_MINT_B58, // on-chain truth: SOL IS gas
    });
    const tx = (q.steps[0] as any).unsignedTxs[0];
    expect(tx.to.toLowerCase()).toBe(WITHDRAW_PRECOMPILE);
    expect(BigInt(tx.value)).toBe(10n ** 18n); // 1 SOL → 1 * 10^(18-9) wei
    const { functionName, args } = decodeFunctionData({ abi: WITHDRAW_ABI, data: tx.data });
    expect(functionName).toBe("withdrawal");
    expect((args[0] as string).toLowerCase()).toBe(RECIPIENT_BYTES32.toLowerCase());
  });

  it("on-chain OwnerInfo (gas ≠ SOL) → RomeBridgeWithdraw 3-arg ensureRecipientAta + bridgeOutToSolana(recipient, amount, wSOLmint)", () => {
    const q = buildSolSolanaOutboundQuote({
      amount: "1000000000",
      sender: { rome: SENDER }, recipient: RECIPIENT_B58,
      chain: USDC_GAS_CHAIN, programId: ROME_PROGRAM_ID,
      onchainGasMint: USDC_DEVNET_MINT, // gas is USDC → wSOL rides the wrapper egress
    });
    const txs = (q.steps[0] as any).unsignedTxs;
    expect(txs.length).toBe(2);
    // Egress is RomeBridgeWithdraw, NOT the ERC20-SPL wrapper (cached wrappers have no egress).
    expect(txs.every((t: any) => t.to.toLowerCase() === ROME_BRIDGE_WITHDRAW.toLowerCase())).toBe(true);
    const ensure = decodeFunctionData({ abi: BRIDGE_EGRESS_ABI, data: txs[0].data });
    expect(ensure.functionName).toBe("ensureRecipientAta");
    expect((ensure.args[0] as string).toLowerCase()).toBe(RECIPIENT_BYTES32.toLowerCase());
    expect((ensure.args[1] as string).toLowerCase()).toBe(WSOL_BYTES32.toLowerCase()); // mint bound
    const burn = decodeFunctionData({ abi: BRIDGE_EGRESS_ABI, data: txs[1].data });
    expect(burn.functionName).toBe("bridgeOutToSolana");
    expect((burn.args[0] as string).toLowerCase()).toBe(RECIPIENT_BYTES32.toLowerCase());
    expect(burn.args[1]).toBe(1000000000n);
    expect((burn.args[2] as string).toLowerCase()).toBe(WSOL_BYTES32.toLowerCase()); // mint-explicit
  });

  it("falls back to the registry mirror when on-chain gas mint is unresolved", () => {
    const q = buildSolSolanaOutboundQuote({
      amount: "1000000000",
      sender: { rome: SENDER }, recipient: RECIPIENT_B58,
      chain: syntheticChain({ chainId: "888888", gasMintId: WSOL_MINT_B58 }),
      programId: ROME_PROGRAM_ID, // onchainGasMint omitted → registry says gas=wSOL → withdrawal
    });
    const tx = (q.steps[0] as any).unsignedTxs[0];
    expect(tx.to.toLowerCase()).toBe(WITHDRAW_PRECOMPILE);
  });

  it("wrapper path rejects when RomeBridgeWithdraw egress is not configured", () => {
    const noWithdraw = syntheticChain({ chainId: "121301", gasMintId: USDC_DEVNET_MINT, withdrawAddress: null });
    expect(() => buildSolSolanaOutboundQuote({
      amount: "1000000000", sender: { rome: SENDER }, recipient: RECIPIENT_B58,
      chain: noWithdraw, programId: ROME_PROGRAM_ID, onchainGasMint: USDC_DEVNET_MINT,
    })).toThrow(/RomeBridgeWithdraw/);
  });

  it("rejects missing sender.rome", () => {
    expect(() => buildSolSolanaOutboundQuote({
      amount: "1000000000", sender: {}, recipient: RECIPIENT_B58,
      chain: USDC_GAS_CHAIN, programId: ROME_PROGRAM_ID, onchainGasMint: USDC_DEVNET_MINT,
    })).toThrow(/sender.rome/);
  });

  it("rejects invalid Solana recipient", () => {
    expect(() => buildSolSolanaOutboundQuote({
      amount: "1000000000", sender: { rome: SENDER }, recipient: "not-base58!@#$",
      chain: USDC_GAS_CHAIN, programId: ROME_PROGRAM_ID, onchainGasMint: USDC_DEVNET_MINT,
    })).toThrow(/recipient/);
  });
});
