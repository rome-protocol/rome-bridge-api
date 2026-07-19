import { describe, it, expect } from "vitest";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  buildSettleInboundBridgeInstruction,
  SETTLE_INBOUND_BRIDGE_IX_ID,
  findExternalAuthPda,
  findOwnerInfoPda,
  findSolWalletPda,
  findBalancePda,
  findBridgeProcessedPda,
} from "../../src/cctp/solana-settle.js";

const ROLLUP_PROGRAM = new PublicKey("RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf"); // Hadrian secondary
const MINT          = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // devnet USDC
const SIGNER        = new PublicKey("DzFNF2Y7p6F1pVuvHB9axyW6L7Y9ksSjUMt8B5cMGNkM");
const USER          = new Uint8Array(Buffer.from("3403e0De09Bc76Ca7d74762F264e4F6B649A0562", "hex"));
const SOURCE_TX_HASH = new Uint8Array(32).fill(0xcd);

const baseParams = {
  chainId: 200010n,
  signer: SIGNER,
  user: USER,
  bridgedAmount: 1_000_000n,
  sourceChain: 11_155_111n, // Sepolia
  sourceTxHash: SOURCE_TX_HASH,
  rollupProgramId: ROLLUP_PROGRAM,
  mintAddress: MINT,
};

describe("buildSettleInboundBridgeInstruction", () => {
  it("targets the rome-evm program id from the chain config", () => {
    const ix = buildSettleInboundBridgeInstruction(baseParams);
    expect(ix.programId.equals(ROLLUP_PROGRAM)).toBe(true);
  });

  it("encodes 77 bytes of instruction data with the documented layout", () => {
    const ix = buildSettleInboundBridgeInstruction(baseParams);
    const data = Buffer.from(ix.data);
    expect(data.length).toBe(77);

    expect(data.readUInt8(0)).toBe(SETTLE_INBOUND_BRIDGE_IX_ID);
    expect(data.readBigUInt64LE(1)).toBe(200010n);                  // chain_id
    expect(Buffer.from(data.subarray(9, 29)).toString("hex"))
      .toBe(Buffer.from(USER).toString("hex"));                     // user 20B
    expect(data.readBigUInt64LE(29)).toBe(1_000_000n);              // bridged_amount
    expect(data.readBigUInt64LE(37)).toBe(11_155_111n);             // source_chain
    expect(Buffer.from(data.subarray(45, 77)).toString("hex"))
      .toBe(Buffer.from(SOURCE_TX_HASH).toString("hex"));           // source_tx_hash 32B
  });

  it("emits 11 keys in the order the on-chain instruction expects", () => {
    const ix = buildSettleInboundBridgeInstruction(baseParams);
    expect(ix.keys).toHaveLength(11);

    // 0. system program (read-only)
    expect(ix.keys[0].pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(false);
    expect(ix.keys[0].isWritable).toBe(false);

    // 1. signer (writable + signer)
    expect(ix.keys[1].pubkey.equals(SIGNER)).toBe(true);
    expect(ix.keys[1].isSigner).toBe(true);
    expect(ix.keys[1].isWritable).toBe(true);

    // 2. OwnerInfo
    expect(ix.keys[2].pubkey.equals(findOwnerInfoPda(ROLLUP_PROGRAM))).toBe(true);
    expect(ix.keys[2].isWritable).toBe(false);

    // 3. BridgeProcessed (writable)
    expect(ix.keys[3].pubkey.equals(findBridgeProcessedPda(
      200010n, 11_155_111n, SOURCE_TX_HASH, ROLLUP_PROGRAM,
    ))).toBe(true);
    expect(ix.keys[3].isWritable).toBe(true);

    // 4. Balance (writable)
    expect(ix.keys[4].pubkey.equals(findBalancePda(200010n, USER, ROLLUP_PROGRAM))).toBe(true);
    expect(ix.keys[4].isWritable).toBe(true);

    // 5. user_pda (external_auth)
    const userPda = findExternalAuthPda(USER, ROLLUP_PROGRAM);
    expect(ix.keys[5].pubkey.equals(userPda)).toBe(true);
    expect(ix.keys[5].isWritable).toBe(false);

    // 6. user ATA (writable)
    const userAta = getAssociatedTokenAddressSync(MINT, userPda, true, TOKEN_PROGRAM_ID);
    expect(ix.keys[6].pubkey.equals(userAta)).toBe(true);
    expect(ix.keys[6].isWritable).toBe(true);

    // 7. sol_wallet PDA
    const solWalletPda = findSolWalletPda(200010n, ROLLUP_PROGRAM);
    expect(ix.keys[7].pubkey.equals(solWalletPda)).toBe(true);
    expect(ix.keys[7].isWritable).toBe(false);

    // 8. sol_wallet ATA (writable)
    const solWalletAta = getAssociatedTokenAddressSync(MINT, solWalletPda, true, TOKEN_PROGRAM_ID);
    expect(ix.keys[8].pubkey.equals(solWalletAta)).toBe(true);
    expect(ix.keys[8].isWritable).toBe(true);

    // 9. mint
    expect(ix.keys[9].pubkey.equals(MINT)).toBe(true);
    expect(ix.keys[9].isWritable).toBe(false);

    // 10. spl token program (default = TOKEN_PROGRAM_ID)
    expect(ix.keys[10].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.keys[10].isWritable).toBe(false);
  });

  it("rejects a user that isn't exactly 20 bytes", () => {
    expect(() => buildSettleInboundBridgeInstruction({ ...baseParams, user: new Uint8Array(19) }))
      .toThrow(/20 bytes/);
    expect(() => buildSettleInboundBridgeInstruction({ ...baseParams, user: new Uint8Array(21) }))
      .toThrow(/20 bytes/);
  });

  it("rejects a sourceTxHash that isn't exactly 32 bytes", () => {
    expect(() => buildSettleInboundBridgeInstruction({ ...baseParams, sourceTxHash: new Uint8Array(31) }))
      .toThrow(/32 bytes/);
  });

  it("rejects bridgedAmount <= 0 (on-chain rejects 0 with Custom; surface the same intent client-side)", () => {
    expect(() => buildSettleInboundBridgeInstruction({ ...baseParams, bridgedAmount: 0n }))
      .toThrow(/bridgedAmount/);
  });

  it("uses the caller-provided SPL token program when overridden (e.g. Token-2022 mainnet)", () => {
    const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    const ix = buildSettleInboundBridgeInstruction({ ...baseParams, splTokenProgram: TOKEN_2022 });

    // Index 10 = SPL program slot
    expect(ix.keys[10].pubkey.equals(TOKEN_2022)).toBe(true);
    // The ATAs at indices 6 and 8 must also be derived against the same SPL program
    const userPda = findExternalAuthPda(USER, ROLLUP_PROGRAM);
    const expectedUserAta = getAssociatedTokenAddressSync(MINT, userPda, true, TOKEN_2022);
    expect(ix.keys[6].pubkey.equals(expectedUserAta)).toBe(true);
  });

  it("the BridgeProcessed PDA replay key changes with source_chain and source_tx_hash", () => {
    const pdaA = findBridgeProcessedPda(200010n, 11_155_111n, new Uint8Array(32).fill(1), ROLLUP_PROGRAM);
    const pdaB = findBridgeProcessedPda(200010n, 11_155_111n, new Uint8Array(32).fill(2), ROLLUP_PROGRAM);
    const pdaC = findBridgeProcessedPda(200010n,           1n, new Uint8Array(32).fill(1), ROLLUP_PROGRAM);

    expect(pdaA.equals(pdaB)).toBe(false);
    expect(pdaA.equals(pdaC)).toBe(false);
  });

  it("findExternalAuthPda is NOT chain-scoped (per architecture pin) — same EVM address → same PDA across rome-evm chains", () => {
    // External-authority PDA is keyed by (b"EXTERNAL_AUTHORITY", evm_addr) under the rome-evm program ID,
    // NOT (chain_id, evm_addr). Two chains hosted by the same program ID share the user PDA.
    const pdaSameProgram = findExternalAuthPda(USER, ROLLUP_PROGRAM);
    const pdaCheck      = findExternalAuthPda(USER, ROLLUP_PROGRAM);
    expect(pdaSameProgram.equals(pdaCheck)).toBe(true);
  });
});
