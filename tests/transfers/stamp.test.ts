import { describe, it, expect } from "vitest";
import { stampFromChainConfig } from "../../src/transfers/stamp";
import { backfillRecordDefaults } from "../../src/transfers/store";
import { loadFixtureChain } from "../helpers/chains";
import type { TransferRecordT } from "../../src/transfers/types";

const hadrian = await loadFixtureChain("200010");

describe("stampFromChainConfig — the full resolved tuple, frozen at registration", () => {
  it("V1 (pinned pre-V2-quote): resolves the real V1 Sepolia contracts + /v1 iris base", () => {
    const stamp = stampFromChainConfig(hadrian, { cctpVersion: 1 });
    expect(stamp).toEqual({
      sourceChainId: 11155111,
      cctpVersion: 1,
      cctpDomain: 0,
      irisBase: "https://iris-api-sandbox.circle.com/v1",
      cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
      cctpMessageTransmitter: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD",
      burnToken: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    });
  });

  it("V2: resolves version-keyed addresses + root iris base (Monad source)", () => {
    const stamp = stampFromChainConfig(hadrian, { cctpVersion: 2, sourceChainId: 10143 });
    expect(stamp.sourceChainId).toBe(10143);
    expect(stamp.cctpVersion).toBe(2);
    expect(stamp.cctpDomain).toBe(15);
    expect(stamp.irisBase).toBe("https://iris-api-sandbox.circle.com");
    expect(stamp.cctpTokenMessenger).toBe("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA");
    expect(stamp.cctpMessageTransmitter).toBe("0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275");
    expect(stamp.burnToken).toBe("0x534b2f3A21130d7a60830c2Df862319e593943A3");
  });

  it("unknown source chain fails closed", () => {
    expect(() => stampFromChainConfig(hadrian, { cctpVersion: 2, sourceChainId: 424242 })).toThrow(/source/i);
  });
});

describe("backfillRecordDefaults — pre-stamp records drain as V1 Sepolia", () => {
  it("a record without a stamp reads back with legacy V1 defaults; reserved trustless-settle fields default null", () => {
    const legacy = {
      id: "txf_legacy", route: "usdc-cctp-to-rome", direction: "to-rome",
      amountIn: "1", amountOut: "1", sender: {}, recipient: "0xabc",
      outcome: "pending", steps: [], createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z",
    } as unknown as TransferRecordT;
    const filled = backfillRecordDefaults(legacy, { legacyIrisBase: "https://iris-api-sandbox.circle.com/v1" });
    expect(filled.stamp).toEqual({
      sourceChainId: 11155111,
      cctpVersion: 1,
      cctpDomain: 0,
      irisBase: "https://iris-api-sandbox.circle.com/v1",
    });
    expect(filled.userSettleSig).toBeNull();
    expect(filled.settleDeadline).toBeNull();
  });

  it("a stamped record is returned untouched", () => {
    const stamped = {
      id: "txf_new", route: "usdc-cctp-to-rome", direction: "to-rome",
      amountIn: "1", amountOut: "1", sender: {}, recipient: "0xabc",
      outcome: "pending", steps: [], createdAt: "2026-07-04T00:00:00Z", updatedAt: "2026-07-04T00:00:00Z",
      stamp: { sourceChainId: 10143, cctpVersion: 2, cctpDomain: 15, irisBase: "https://iris-api-sandbox.circle.com" },
      userSettleSig: null, settleDeadline: null,
    } as unknown as TransferRecordT;
    const filled = backfillRecordDefaults(stamped, { legacyIrisBase: "https://x/v1" });
    expect(filled.stamp?.cctpVersion).toBe(2);
    expect(filled.stamp?.sourceChainId).toBe(10143);
  });
});
