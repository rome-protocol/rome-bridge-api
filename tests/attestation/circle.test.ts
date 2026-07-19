import { describe, it, expect, vi } from "vitest";
import { CircleAttestationClient } from "../../src/attestation/circle";

describe("CircleAttestationClient.fetch", () => {
  it("returns the attestation when Iris status is complete", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ status: "complete", attestation: "0xdeadbeef" }),
    });
    const client = new CircleAttestationClient({ baseUrl: "https://iris.example", fetch: fetchMock as unknown as typeof fetch });
    const r = await client.fetch("0xmessagehash");
    expect(r.status).toBe("complete");
    expect(r.attestation).toBe("0xdeadbeef");
    expect(fetchMock).toHaveBeenCalledWith("https://iris.example/attestations/0xmessagehash", expect.any(Object));
  });

  it("returns pending status when Iris status is pending_confirmations", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ status: "pending_confirmations" }),
    });
    const client = new CircleAttestationClient({ baseUrl: "https://iris.example", fetch: fetchMock as unknown as typeof fetch });
    const r = await client.fetch("0xmessagehash");
    expect(r.status).toBe("pending");
  });

  it("throws on 5xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const client = new CircleAttestationClient({ baseUrl: "https://iris.example", fetch: fetchMock as unknown as typeof fetch });
    await expect(client.fetch("0xmessagehash")).rejects.toThrow(/503/);
  });
});
