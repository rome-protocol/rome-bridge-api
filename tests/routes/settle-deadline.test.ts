import { describe, it, expect } from "vitest";
import { settleDeadlineSec } from "../../src/routes/quote";

/**
 * the signed settle deadline must outlast the transfer's own
 * ETA, or the authorization expires before the attestation is even available.
 * Standard-tier CCTP inbound eta is ~1100s (~18min); the historic 5-min floor
 * (300s) produced authorizations that were expired-on-arrival.
 */
describe("settleDeadlineSec — floors the settle deadline above the transfer ETA", () => {
  it("lifts a too-short requested deadline above the ETA (standard CCTP ~18min)", () => {
    expect(settleDeadlineSec(300, 1100)).toBeGreaterThanOrEqual(1100);
  });

  it("keeps a generous requested deadline unchanged", () => {
    expect(settleDeadlineSec(7200, 1100)).toBe(7200);
  });

  it("clamps to the 24h maximum", () => {
    expect(settleDeadlineSec(999_999, 1100)).toBe(86_400);
  });

  it("defaults to 1h when nothing is requested and the ETA is small (fast tier)", () => {
    expect(settleDeadlineSec(undefined, 40)).toBe(3600);
  });

  it("never returns below the 5-min minimum", () => {
    expect(settleDeadlineSec(1, 1)).toBeGreaterThanOrEqual(300);
  });
});
