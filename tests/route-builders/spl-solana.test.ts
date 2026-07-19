import { describe, it, expect } from "vitest";
import { buildSplSolanaInboundQuote } from "../../src/route-builders/spl-solana-inbound";
import { buildSplSolanaOutboundQuote } from "../../src/route-builders/spl-solana-outbound";
import type { QuoteInput } from "../../src/route-builders/usdc-cctp-inbound";
import type { ChainConfig } from "../../src/registry/types";

// mSOL — canonical devnet==mainnet mint, decimals 9. Proves the rail carries an
// arbitrary Solana mint the registry has NEVER been configured for.
const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const HELPER = "0x0000000000000000000000000000000000000009";
const PROGRAM = "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf";

const chain = {
  chainId: "200010",
  contracts: [{ name: "RomeBridgeWithdraw", versions: [{ version: "6.0.0", status: "live", address: "0x9975fe4b721bf52f2a5bcc795fa2e29edc50de8b" }] }],
} as unknown as ChainConfig;

const base: Omit<QuoteInput, "sender" | "recipient"> = {
  amount: "100000000", // 0.1 mSOL @ 9 decimals
  chain,
  programId: PROGRAM,
  splAsset: { mint: MSOL, decimals: 9, symbol: "mSOL" },
};

describe("asset-agnostic SPL rail (mSOL)", () => {
  it("inbound: no native-wrap, transferChecked into recipient PDA-ATA, no claim-as-gas", () => {
    const q = buildSplSolanaInboundQuote({
      ...base,
      sender: { solana: "32WnBgKWVBWH1LZjUtq6gqz9kGzBpaphNL2xZ6kUfDyd" },
      recipient: "0x1f4946Be340F06c46A50E65084790968aBcc48F6",
    });
    expect(q.route).toBe("spl-solana-to-rome");
    expect(q.steps).toHaveLength(1); // no claim-as-gas — LST is never a gas mint
    const ixs = (q.steps[0]!.unsignedTx as any).instructions;
    // Exactly 2 ixs: idempotent recipient-ATA create + transferChecked. No wrap trio.
    expect(ixs).toHaveLength(2);
    // transferChecked is the SPL Token program (last ix), carrying decimals.
    expect(ixs[1].programId).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  });

  it("outbound: RomeBridgeWithdraw 3-arg egress, mint bound, two-step", () => {
    const q = buildSplSolanaOutboundQuote({
      ...base,
      sender: { rome: "0x1f4946Be340F06c46A50E65084790968aBcc48F6" },
      recipient: "32WnBgKWVBWH1LZjUtq6gqz9kGzBpaphNL2xZ6kUfDyd",
    });
    expect(q.route).toBe("spl-solana-from-rome");
    expect(q.steps[0]!.kind).toBe("spl-erc20-bridge-out");
    const txs = q.steps[0]!.unsignedTxs!;
    expect(txs).toHaveLength(2);
    // Both target the live RomeBridgeWithdraw, not a per-mint wrapper.
    expect(txs[0]!.to.toLowerCase()).toBe("0x9975fe4b721bf52f2a5bcc795fa2e29edc50de8b");
    expect(txs[1]!.to.toLowerCase()).toBe("0x9975fe4b721bf52f2a5bcc795fa2e29edc50de8b");
    // 3-arg selectors: ensureRecipientAta=0xeeaed29d, bridgeOutToSolana=0x8efe5df8.
    expect(txs[0]!.data.slice(0, 10)).toBe("0xeeaed29d");
    expect(txs[1]!.data.slice(0, 10)).toBe("0x8efe5df8");
  });

  it("rejects when splAsset.mint is absent (rail requires an explicit mint)", () => {
    expect(() => buildSplSolanaOutboundQuote({
      ...base, splAsset: undefined,
      sender: { rome: "0x1f4946Be340F06c46A50E65084790968aBcc48F6" },
      recipient: "32WnBgKWVBWH1LZjUtq6gqz9kGzBpaphNL2xZ6kUfDyd",
    })).toThrow(/splAsset\.mint/);
  });
});
