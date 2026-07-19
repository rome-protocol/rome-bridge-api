import { describe, it, expect } from "vitest";
import { bridgeError, BRIDGE_ERROR_CODES } from "../src/errors";

describe("bridgeError", () => {
  it("produces an RFC 7807 problem+json shape", () => {
    const err = bridgeError("rome.bridge.asset-not-supported", "USDC not supported on chain 999", { chainId: "999" });
    expect(err).toMatchObject({
      type: "https://bridge.romeprotocol.xyz/errors/rome.bridge.asset-not-supported",
      title: "Asset not supported",
      status: 400,
      detail: "USDC not supported on chain 999",
      code: "rome.bridge.asset-not-supported",
      meta: { chainId: "999" },
    });
  });

  it("rejects unknown codes at compile time but also at runtime if bypassed", () => {
    // @ts-expect-error - unknown code
    expect(() => bridgeError("rome.bridge.unknown-code", "x")).toThrow();
  });

  it("exposes all 8+ canonical error codes", () => {
    expect(BRIDGE_ERROR_CODES).toContain("rome.bridge.asset-not-supported");
    expect(BRIDGE_ERROR_CODES).toContain("rome.bridge.attestation-not-ready");
    expect(BRIDGE_ERROR_CODES).toContain("rome.bridge.source-tx-mismatch");
    expect(BRIDGE_ERROR_CODES).toContain("rome.bridge.amount-out-of-range");
    expect(BRIDGE_ERROR_CODES).toContain("rome.bridge.rate-limited");
    expect(BRIDGE_ERROR_CODES).toContain("rome.bridge.quote-expired");
    expect(BRIDGE_ERROR_CODES).toContain("rome.bridge.source-tx-not-found");
    expect(BRIDGE_ERROR_CODES).toContain("rome.bridge.sender-incomplete");
    expect(BRIDGE_ERROR_CODES).toContain("rome.bridge.step-not-ready");
    expect(BRIDGE_ERROR_CODES).toContain("rome.bridge.step-tx-mismatch");
    expect(BRIDGE_ERROR_CODES).toContain("rome.bridge.step-expired");
  });

  it("request-invalid covers malformed request bodies/params (schema failures are not recipient errors)", () => {
    const err = bridgeError("rome.bridge.request-invalid", "direction: Required");
    expect(err.title).toBe("Request invalid");
    expect(err.status).toBe(400);
    expect(err.type).toBe("https://bridge.romeprotocol.xyz/errors/rome.bridge.request-invalid");
  });
});
