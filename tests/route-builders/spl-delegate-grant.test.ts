import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { bytesToHex, decodeFunctionData, getAddress, parseAbi, toFunctionSelector } from "viem";
import { HELPER_PROGRAM, buildSplDelegateGrantTx } from "../../src/route-builders/spl-delegate-grant";

// RomeBridgeWithdraw v10 moves the user's SPL as that user's SPL DELEGATE
// (external_auth(bridge) signs; SPL Token accepts owner OR delegate). The grant
// is the user's own tx straight to HelperProgram 0xff..09:
//   approve_spl(address spender, uint64 amount, bytes32 mint) — selector 0xabf6f675
// It must be the FIRST tx of step 1; the burn stays LAST (registration binds the
// last unsignedTx of step 1).
const HELPER_ABI = parseAbi(["function approve_spl(address spender, uint64 amount, bytes32 mint)"]);
const BRIDGE = "0x9975fe4b721bf52f2a5bcc795fa2e29edc50de8b";
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

describe("buildSplDelegateGrantTx", () => {
  it("targets HelperProgram with approve_spl(bridge, amount, mint) — selector 0xabf6f675", () => {
    const tx = buildSplDelegateGrantTx({ bridge: BRIDGE, amount: 1_000_000n, mint: USDC_MINT, symbol: "wUSDC" });
    expect(tx.to).toBe(HELPER_PROGRAM);
    expect(HELPER_PROGRAM).toBe("0xff00000000000000000000000000000000000009");
    expect(tx.data.slice(0, 10)).toBe(toFunctionSelector("function approve_spl(address,uint64,bytes32)"));
    expect(tx.data.slice(0, 10)).toBe("0xabf6f675");
    const { functionName, args } = decodeFunctionData({ abi: HELPER_ABI, data: tx.data });
    expect(functionName).toBe("approve_spl");
    expect(getAddress(args[0] as string)).toBe(getAddress(BRIDGE));
    expect(args[1]).toBe(1_000_000n);
    expect((args[2] as string).toLowerCase()).toBe(bytesToHex(new PublicKey(USDC_MINT).toBytes()).toLowerCase());
    expect(tx.value).toBe("0");
    expect(tx.description).toMatch(/wUSDC/);
    expect(tx.description).toMatch(/delegate/i);
  });

  it("refuses an amount that does not fit uint64 (the on-chain approve is u64)", () => {
    expect(() => buildSplDelegateGrantTx({ bridge: BRIDGE, amount: 2n ** 64n, mint: USDC_MINT, symbol: "wUSDC" }))
      .toThrow(/uint64|amount/);
  });

  it("refuses a mint that is not a Solana pubkey", () => {
    expect(() => buildSplDelegateGrantTx({ bridge: BRIDGE, amount: 1n, mint: "not-a-mint", symbol: "X" }))
      .toThrow(/mint/);
  });
});
