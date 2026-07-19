import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { settleAuthorizationDigest, SETTLE_AUTHORIZATION_TYPEHASH } from "../../src/cctp/eip712-settle";
import { buildSettleInboundBridgeV2Instruction, SETTLE_INBOUND_BRIDGE_V2_IX_ID } from "../../src/cctp/solana-settle-v2";

/**
 * Golden fixture shared with the Rome EVM's Rust unit tests
 * (settle_inbound_bridge_v2.rs) — both sides MUST produce this digest, or the
 * program rejects a bridge-api-built settle. Generated 2026-07-04 via viem.
 */
const PROGRAM_ID = "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEST_CHAIN = 200010n;
const AMOUNT = 1000000n;
const SOURCE_CHAIN = 11155111n;
const SOURCE_EVM_CHAIN = 11155111n;
const DEADLINE = 1751630000n;
const SOURCE_TX = "0x" + "ab".repeat(32);
const GOLDEN_DIGEST = "0x0237b5760e2d135e1d9d2049e365d73023bfed0a49f8392a1bf8ecbef0d9996e";
const GOLDEN_TYPEHASH = "0xcc0b6054aab1503241e0113fa29f2884671758182841fc8d81143b128671d6b4";

describe("EIP-712 SettleAuthorization digest — cross-language golden vector", () => {
  it("typeHash matches the spec's locked constant", () => {
    expect(SETTLE_AUTHORIZATION_TYPEHASH).toBe(GOLDEN_TYPEHASH);
  });

  it("digest matches the Rust program's eip712_digest byte-for-byte", () => {
    const digest = settleAuthorizationDigest({
      romeEvmProgramId: new PublicKey(PROGRAM_ID),
      sourceEvmChainId: SOURCE_EVM_CHAIN,
      destinationChainId: DEST_CHAIN,
      mint: new PublicKey(MINT),
      amount: AMOUNT,
      sourceChain: SOURCE_CHAIN,
      sourceTxHash: SOURCE_TX,
      deadline: DEADLINE,
    });
    expect(digest).toBe(GOLDEN_DIGEST);
  });

  it("any field change moves the digest (the binding that makes redirect un-signable)", () => {
    const base = {
      romeEvmProgramId: new PublicKey(PROGRAM_ID), sourceEvmChainId: SOURCE_EVM_CHAIN,
      destinationChainId: DEST_CHAIN, mint: new PublicKey(MINT), amount: AMOUNT,
      sourceChain: SOURCE_CHAIN, sourceTxHash: SOURCE_TX, deadline: DEADLINE,
    };
    expect(settleAuthorizationDigest({ ...base, destinationChainId: DEST_CHAIN + 1n })).not.toBe(GOLDEN_DIGEST);
    expect(settleAuthorizationDigest({ ...base, amount: AMOUNT + 1n })).not.toBe(GOLDEN_DIGEST);
  });
});

describe("v2 settle instruction builder", () => {
  const base = {
    chainId: DEST_CHAIN,
    submitter: new PublicKey("5Qx7AANCDsZRgxgVMmYZcCs5bRjGNXa7AzVf4UqB2TqA"),
    user: Uint8Array.from(Buffer.from("f39fd6e51aad88f6f4ce6ab8827279cfffb92266", "hex")),
    bridgedAmount: AMOUNT,
    sourceChain: SOURCE_CHAIN,
    sourceTxHash: Uint8Array.from(Buffer.from(SOURCE_TX.slice(2), "hex")),
    deadline: DEADLINE,
    sourceEvmChainId: SOURCE_EVM_CHAIN,
    sigR: Uint8Array.from(Buffer.from("497895150e6d4bd0399b353f49bc4332080bcdd1dba36806338d8e0c30753707", "hex")),
    sigS: Uint8Array.from(Buffer.from("7f63f6c03f40fa8570e68ec29492d1dca619c0f87be30d83ae057a9b125babc1", "hex")),
    sigV: 27,
    rollupProgramId: new PublicKey(PROGRAM_ID),
    mintAddress: new PublicKey(MINT),
  };

  it("emits slot-21 opcode + the 157-byte data layout matching the Rust args() parser", () => {
    const ix = buildSettleInboundBridgeV2Instruction(base);
    expect(ix.data[0]).toBe(SETTLE_INBOUND_BRIDGE_V2_IX_ID);
    expect(ix.data.length).toBe(1 + 157); // opcode + args
    // spot-check the sig tail: last byte is v, preceded by s, preceded by r
    expect(ix.data[ix.data.length - 1]).toBe(27);
    expect(Buffer.from(ix.data.subarray(ix.data.length - 65, ix.data.length - 33)).toString("hex")).toBe(
      "497895150e6d4bd0399b353f49bc4332080bcdd1dba36806338d8e0c30753707",
    );
  });

  it("the submitter is the ONLY signer — no bridge_settler_key (any caller submits)", () => {
    const ix = buildSettleInboundBridgeV2Instruction(base);
    const signers = ix.keys.filter((k) => k.isSigner);
    expect(signers).toHaveLength(1);
    expect(signers[0]!.pubkey.toBase58()).toBe(base.submitter.toBase58());
  });

  it("rejects malformed sig components", () => {
    expect(() => buildSettleInboundBridgeV2Instruction({ ...base, sigR: new Uint8Array(31) })).toThrow(/sigR/);
    expect(() => buildSettleInboundBridgeV2Instruction({ ...base, sigV: 26 })).toThrow(/sigV/);
    expect(() => buildSettleInboundBridgeV2Instruction({ ...base, sigV: 29 })).toThrow(/sigV/);
  });
});
