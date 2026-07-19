import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { privateKeyToAccount } from "viem/accounts";
import { buildSettleAuthorizationRequest, verifySettleAuthorization } from "../../src/cctp/settle-auth";

const PROGRAM_ID = new PublicKey("RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf");
const MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const ACCOUNT = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // hardhat #0
const DEADLINE = 1751630000n;
const BURN_TX = "0x" + "ab".repeat(32);

const common = {
  romeEvmProgramId: PROGRAM_ID,
  sourceEvmChainId: 11155111n,
  destinationChainId: 200010n,
  mint: MINT,
  amount: 1000000n,
  sourceChain: 11155111n,
  deadline: DEADLINE,
};

describe("buildSettleAuthorizationRequest — quote-time typed-data template", () => {
  it("emits an EIP-712 request with the sourceTxHash field marked client-filled (burn happens after signing template)", () => {
    const req = buildSettleAuthorizationRequest(common);
    expect(req.kind).toBe("settle-authorization-eip712");
    expect(req.fillFromBurn).toBe("sourceTxHash");
    expect(req.typedData.primaryType).toBe("SettleAuthorization");
    expect(req.typedData.domain.chainId).toBe(11155111); // numeric — string chainId broke the on-chain digest (SignerNotUser)
    expect(req.typedData.message.deadline).toBe(DEADLINE.toString());
    // template carries a zero placeholder until the client fills the burn hash
    expect(req.typedData.message.sourceTxHash).toBe("0x" + "00".repeat(32));
  });
});

describe("verifySettleAuthorization — API-side re-check before storing the sig", () => {
  async function sign(over: Partial<typeof common> & { sourceTxHash: string }) {
    const { hashTypedData } = await import("viem");
    const { settleAuthorizationTypedData } = await import("../../src/cctp/eip712-settle");
    const td = settleAuthorizationTypedData({ ...common, ...over });
    const digest = hashTypedData({ ...td, message: { ...td.message, sourceTxHash: over.sourceTxHash } } as never);
    return ACCOUNT.sign({ hash: digest });
  }

  it("accepts a signature that recovers to the expected recipient over the completed struct", async () => {
    const sig = await sign({ sourceTxHash: BURN_TX });
    const res = verifySettleAuthorization({ ...common, sourceTxHash: BURN_TX, recipient: ACCOUNT.address, signature: sig });
    expect(res.ok).toBe(true);
  });

  it("rejects a sig that recovers to a different address (not the recipient)", async () => {
    const sig = await sign({ sourceTxHash: BURN_TX });
    const res = verifySettleAuthorization({ ...common, sourceTxHash: BURN_TX, recipient: "0x1111111111111111111111111111111111111111", signature: sig });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/recover/i);
  });

  it("rejects when the burn hash the sig was made over differs from the reported one (binding)", async () => {
    const sig = await sign({ sourceTxHash: "0x" + "cd".repeat(32) }); // signed over a DIFFERENT burn
    const res = verifySettleAuthorization({ ...common, sourceTxHash: BURN_TX, recipient: ACCOUNT.address, signature: sig });
    expect(res.ok).toBe(false);
  });

  it("rejects malformed signatures (length / v)", () => {
    expect(verifySettleAuthorization({ ...common, sourceTxHash: BURN_TX, recipient: ACCOUNT.address, signature: "0xdead" }).ok).toBe(false);
  });

  it("splitSignature exposes r/s/v for the on-chain ix", async () => {
    const sig = await sign({ sourceTxHash: BURN_TX });
    const res = verifySettleAuthorization({ ...common, sourceTxHash: BURN_TX, recipient: ACCOUNT.address, signature: sig });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.r).toHaveLength(32);
      expect(res.s).toHaveLength(32);
      expect([27, 28]).toContain(res.v);
    }
  });

  it("rejects a high-s (non-canonical, EIP-2) signature the way the program does", async () => {
    // viem signs low-s. Malleate to s' = n - s (+ flip v): it recovers to the
    // SAME address, so only an explicit low-s check can reject it — mirroring
    // settle_inbound_bridge_v2.rs (NonCanonicalSignature). Without this, a
    // high-s sig passes the API's early-reject but fails on-chain.
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const sig = await sign({ sourceTxHash: BURN_TX });
    const h = sig.slice(2);
    const r = h.slice(0, 64);
    const s = BigInt("0x" + h.slice(64, 128));
    const v = parseInt(h.slice(128, 130), 16);
    const highS = "0x" + r + (N - s).toString(16).padStart(64, "0") + (v === 27 ? 28 : 27).toString(16).padStart(2, "0");
    const res = verifySettleAuthorization({ ...common, sourceTxHash: BURN_TX, recipient: ACCOUNT.address, signature: highS });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/non-canonical|high-s|malleab/i);
  });
});
