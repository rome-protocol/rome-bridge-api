import { describe, it, expect } from "vitest";
import { caip2ForEvm, caip2ForSolanaCluster, chainRefForStep, parseSourceChainInput } from "../../src/lib/caip2";

describe("CAIP-2 identity", () => {
  it("formats EVM chains as eip155:<id>", () => {
    expect(caip2ForEvm(11155111)).toBe("eip155:11155111");
    expect(caip2ForEvm("200010")).toBe("eip155:200010");
  });

  it("maps Solana clusters to the well-known genesis-hash prefixes", () => {
    expect(caip2ForSolanaCluster("devnet")).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(caip2ForSolanaCluster("mainnet-beta")).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    expect(caip2ForSolanaCluster("unknown-cluster")).toBeUndefined();
  });

  it("chainRefForStep translates legacy step labels", () => {
    expect(chainRefForStep("ethereum", { defaultEvmChainId: 11155111, solanaCluster: "devnet" })).toBe("eip155:11155111");
    expect(chainRefForStep("evm-10143", { defaultEvmChainId: 11155111, solanaCluster: "devnet" })).toBe("eip155:10143");
    expect(chainRefForStep("solana", { defaultEvmChainId: 11155111, solanaCluster: "devnet" })).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(chainRefForStep("rome-200010", { defaultEvmChainId: 11155111, solanaCluster: "devnet" })).toBe("eip155:200010");
  });
});

describe("parseSourceChainInput — dual-accept with conflict detection", () => {
  it("symbolic rails pass through (Sunset-window compatibility)", () => {
    expect(parseSourceChainInput({ sourceChain: "ethereum" })).toEqual({ rail: "ethereum", symbolicUsed: true });
    expect(parseSourceChainInput({ sourceChain: "solana" })).toEqual({ rail: "solana", symbolicUsed: true });
  });

  it("CAIP-2 eip155 source implies the ethereum rail + a sourceChainId", () => {
    expect(parseSourceChainInput({ sourceChain: "eip155:10143" })).toEqual({ rail: "ethereum", sourceChainId: 10143, symbolicUsed: false });
  });

  it("CAIP-2 solana source implies the solana rail", () => {
    expect(parseSourceChainInput({ sourceChain: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" })).toEqual({ rail: "solana", symbolicUsed: false });
  });

  it("explicit sourceChainId must agree with a CAIP-2 sourceChain", () => {
    expect(() => parseSourceChainInput({ sourceChain: "eip155:10143", sourceChainId: 84532 })).toThrow(/conflict/i);
    expect(parseSourceChainInput({ sourceChain: "eip155:10143", sourceChainId: 10143 })).toEqual({ rail: "ethereum", sourceChainId: 10143, symbolicUsed: false });
  });

  it("unknown namespaces are refused", () => {
    expect(() => parseSourceChainInput({ sourceChain: "cosmos:hub-4" })).toThrow(/unsupported/i);
  });
});
