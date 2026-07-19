import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { bytesToHex, decodeFunctionData, parseAbi } from "viem";
import { buildUsdcSolanaOutboundQuote } from "../../src/route-builders/usdc-solana-outbound";

import { USDC_DEVNET_MINT, WSOL_MINT_B58, syntheticChain } from "../helpers/chains";

const WUSDC_WRAPPER = "0xabcdef0123456789abcdef0123456789abcdef01";
const RECIPIENT_B58 = "5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA"; // Solana WALLET (not an ATA)
const RECIPIENT_BYTES32 = bytesToHex(new PublicKey(RECIPIENT_B58).toBytes());
const ROME_PROGRAM_ID = "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8";
const WITHDRAW_PRECOMPILE = "0x4200000000000000000000000000000000000016";
const SENDER = "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562";

const WITHDRAW_ABI = parseAbi(["function withdrawal(bytes32 recipient)"]);
const WRAPPER_ABI = parseAbi([
  "function ensureRecipientAta(bytes32 solanaRecipient)",
  "function bridgeOutToSolana(bytes32 solanaRecipient, uint256 value)",
]);

// A chain whose registry gasToken has DRIFTED (says wSOL) — the wUSDC wrapper
// row is present. Proves the builder trusts on-chain OwnerInfo over the registry.
const DRIFTED_CHAIN = syntheticChain({
  chainId: "121301",
  gasMintId: WSOL_MINT_B58, // registry says gas = wSOL (WRONG / drifted)
  tokens: [{ kind: "spl_wrapper", assetRef: "usdc", symbol: "wUSDC", address: WUSDC_WRAPPER, mintId: USDC_DEVNET_MINT }],
});
// A chain whose registry gasToken says USDC (used for the fallback case).
const USDC_GAS_CHAIN = syntheticChain({
  chainId: "121301",
  gasMintId: USDC_DEVNET_MINT,
  tokens: [{ kind: "spl_wrapper", assetRef: "usdc", symbol: "wUSDC", address: WUSDC_WRAPPER, mintId: USDC_DEVNET_MINT }],
});

describe("buildUsdcSolanaOutboundQuote — on-chain gas-relative routing", () => {
  it("on-chain OwnerInfo (USDC=gas) → native withdrawal, EVEN when the registry drifted to wSOL", () => {
    const q = buildUsdcSolanaOutboundQuote({
      amount: "100000000", // 100 USDC (6-dec)
      sender: { rome: SENDER }, recipient: RECIPIENT_B58,
      chain: DRIFTED_CHAIN, programId: ROME_PROGRAM_ID,
      onchainGasMint: USDC_DEVNET_MINT, // on-chain truth: USDC IS gas
    });
    expect(q.route).toBe("usdc-solana-from-rome");
    const tx = (q.steps[0] as any).unsignedTxs[0];
    expect(tx.to.toLowerCase()).toBe(WITHDRAW_PRECOMPILE);
    expect(BigInt(tx.value)).toBe(10n ** 20n); // 100 USDC → 100 * 10^(18-6) wei
    const { functionName, args } = decodeFunctionData({ abi: WITHDRAW_ABI, data: tx.data });
    expect(functionName).toBe("withdrawal");
    expect((args[0] as string).toLowerCase()).toBe(RECIPIENT_BYTES32.toLowerCase()); // WALLET, not ATA
  });

  it("on-chain OwnerInfo (gas ≠ USDC) → wrapper ensureRecipientAta + bridgeOutToSolana(wallet, amount)", () => {
    const q = buildUsdcSolanaOutboundQuote({
      amount: "100000000",
      sender: { rome: SENDER }, recipient: RECIPIENT_B58,
      chain: USDC_GAS_CHAIN, programId: ROME_PROGRAM_ID,
      onchainGasMint: WSOL_MINT_B58, // on-chain says gas is wSOL → USDC is a plain wrapper
    });
    const txs = (q.steps[0] as any).unsignedTxs;
    expect(txs.length).toBe(2);
    expect(txs.every((t: any) => t.to.toLowerCase() === WUSDC_WRAPPER.toLowerCase())).toBe(true);
    expect(txs.every((t: any) => BigInt(t.value) === 0n)).toBe(true);
    const ensure = decodeFunctionData({ abi: WRAPPER_ABI, data: txs[0].data });
    expect(ensure.functionName).toBe("ensureRecipientAta");
    expect((ensure.args[0] as string).toLowerCase()).toBe(RECIPIENT_BYTES32.toLowerCase());
    const burn = decodeFunctionData({ abi: WRAPPER_ABI, data: txs[1].data });
    expect(burn.functionName).toBe("bridgeOutToSolana");
    expect((burn.args[0] as string).toLowerCase()).toBe(RECIPIENT_BYTES32.toLowerCase()); // (recipient, amount) order
    expect(burn.args[1]).toBe(100000000n);
  });

  it("falls back to the registry mirror when on-chain gas mint is unresolved", () => {
    const q = buildUsdcSolanaOutboundQuote({
      amount: "100000000",
      sender: { rome: SENDER }, recipient: RECIPIENT_B58,
      chain: USDC_GAS_CHAIN, programId: ROME_PROGRAM_ID,
      // onchainGasMint omitted → falls back to chain.gasToken.mintId (USDC) → withdrawal
    });
    const tx = (q.steps[0] as any).unsignedTxs[0];
    expect(tx.to.toLowerCase()).toBe(WITHDRAW_PRECOMPILE);
  });

  it("rejects missing sender.rome", () => {
    expect(() => buildUsdcSolanaOutboundQuote({
      amount: "100000000", sender: {}, recipient: RECIPIENT_B58,
      chain: USDC_GAS_CHAIN, programId: ROME_PROGRAM_ID, onchainGasMint: USDC_DEVNET_MINT,
    })).toThrow(/sender.rome/);
  });

  it("rejects invalid Solana recipient", () => {
    expect(() => buildUsdcSolanaOutboundQuote({
      amount: "100000000", sender: { rome: SENDER }, recipient: "not-base58!@#$",
      chain: USDC_GAS_CHAIN, programId: ROME_PROGRAM_ID, onchainGasMint: USDC_DEVNET_MINT,
    })).toThrow(/recipient/);
  });
});
