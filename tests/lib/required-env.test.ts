/**
 * requireEnv — fail-closed env access for endpoints that must NEVER silently
 * fall back to a public default. The live gap this closes: the sponsor worker
 * defaulted SOLANA_RPC_URL to the public rate-limited devnet endpoint when the
 * env was unset — flaky RPC presented as a broken bridge.
 */
import { describe, it, expect, afterEach } from "vitest";
import { requireEnv } from "../../src/lib/required-env.js";

afterEach(() => { delete process.env.__REQ_ENV_TEST; });

describe("requireEnv", () => {
  it("returns the value when set", () => {
    process.env.__REQ_ENV_TEST = "https://internal.example";
    expect(requireEnv("__REQ_ENV_TEST")).toBe("https://internal.example");
  });

  it("throws (never defaults) when unset", () => {
    expect(() => requireEnv("__REQ_ENV_TEST")).toThrow(/__REQ_ENV_TEST/);
  });

  it("throws on empty string (an empty env var is a misconfiguration, not a value)", () => {
    process.env.__REQ_ENV_TEST = "";
    expect(() => requireEnv("__REQ_ENV_TEST")).toThrow(/__REQ_ENV_TEST/);
  });
});
