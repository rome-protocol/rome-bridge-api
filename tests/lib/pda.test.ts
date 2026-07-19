import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { deriveExternalAuthorityPda } from "../../src/lib/pda";
import { deriveUserPdaAta } from "../../src/lib/ata";
import { evmAddressToBytes32, bytes32ToEvmAddress } from "../../src/lib/encoding";

const HADRIAN_PROGRAM_ID = new PublicKey("romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8");
const SAMPLE_EVM = "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562";
const USDC_DEVNET_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

describe("deriveExternalAuthorityPda", () => {
  it("derives a deterministic PDA for an EVM address against the Hadrian program", () => {
    const [pda, bump] = deriveExternalAuthorityPda(SAMPLE_EVM, HADRIAN_PROGRAM_ID);
    expect(pda).toBeInstanceOf(PublicKey);
    expect(typeof bump).toBe("number");
    const [pda2] = deriveExternalAuthorityPda(SAMPLE_EVM, HADRIAN_PROGRAM_ID);
    expect(pda2.equals(pda)).toBe(true);
  });

  it("normalizes case-insensitive evm input", () => {
    const [pdaLower] = deriveExternalAuthorityPda(SAMPLE_EVM.toLowerCase(), HADRIAN_PROGRAM_ID);
    const [pdaUpper] = deriveExternalAuthorityPda(SAMPLE_EVM.toUpperCase().replace("0X", "0x"), HADRIAN_PROGRAM_ID);
    expect(pdaLower.equals(pdaUpper)).toBe(true);
  });
});

describe("deriveUserPdaAta", () => {
  it("derives the SPL ATA owned by the user's external_authority PDA", () => {
    const [pda] = deriveExternalAuthorityPda(SAMPLE_EVM, HADRIAN_PROGRAM_ID);
    const ata = deriveUserPdaAta(pda, USDC_DEVNET_MINT);
    expect(ata).toBeInstanceOf(PublicKey);
  });
});

describe("encoding helpers", () => {
  it("evmAddressToBytes32 left-pads with zeros", () => {
    const b = evmAddressToBytes32(SAMPLE_EVM);
    expect(b).toMatch(/^0x0{24}3403e0de09bc76ca7d74762f264e4f6b649a0562$/i);
  });
  it("round-trips evm address through bytes32", () => {
    const b = evmAddressToBytes32(SAMPLE_EVM);
    expect(bytes32ToEvmAddress(b).toLowerCase()).toBe(SAMPLE_EVM.toLowerCase());
  });
});
