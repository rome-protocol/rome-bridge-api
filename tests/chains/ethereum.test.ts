import { describe, it, expect, vi } from "vitest";
import { EthereumReader } from "../../src/chains/ethereum";

describe("EthereumReader.readTx", () => {
  it("returns {to, data, value} on success", async () => {
    const transport = vi.fn().mockResolvedValue({
      hash: "0xa1b2", to: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", input: "0xf856ddb6...", value: 0n,
    });
    const reader = new EthereumReader({ transport: transport as any });
    const tx = await reader.readTx("0xa1b2");
    expect(tx?.to.toLowerCase()).toBe("0x9f3b8679c73c2fef8b59b4f3444d4e156fb70aa5");
    expect(tx?.data).toBe("0xf856ddb6...");
    expect(tx?.value).toBe("0");
  });

  it("returns null for tx not found", async () => {
    const transport = vi.fn().mockResolvedValue(null);
    const reader = new EthereumReader({ transport: transport as any });
    expect(await reader.readTx("0xabsent")).toBeNull();
  });
});
