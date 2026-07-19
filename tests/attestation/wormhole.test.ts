import { describe, it, expect, vi } from "vitest";
import { WormholeAttestationClient } from "../../src/attestation/wormhole";

describe("WormholeAttestationClient.fetch", () => {
  it("returns the VAA when Guardians have signed it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: { vaa: "AQAAAAQNAg... (base64)" } }),
    });
    const client = new WormholeAttestationClient({ baseUrl: "https://wh.example", fetch: fetchMock as unknown as typeof fetch });
    const r = await client.fetch(10002, "0x000000000000000000000000DB5492265f6038831E89f495670FF909aDe94bd9", 42n);
    expect(r.status).toBe("complete");
    expect(r.vaa).toBe("AQAAAAQNAg... (base64)");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://wh.example/api/v1/vaas/10002/0x000000000000000000000000DB5492265f6038831E89f495670FF909aDe94bd9/42",
      expect.any(Object),
    );
  });

  it("returns pending status on 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const client = new WormholeAttestationClient({ baseUrl: "https://wh.example", fetch: fetchMock as unknown as typeof fetch });
    const r = await client.fetch(10002, "0xemit", 1n);
    expect(r.status).toBe("pending");
  });

  it("throws on 5xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const client = new WormholeAttestationClient({ baseUrl: "https://wh.example", fetch: fetchMock as unknown as typeof fetch });
    await expect(client.fetch(10002, "0xemit", 1n)).rejects.toThrow(/503/);
  });
});

describe("WormholeAttestationClient.fetchByTxHash — from-rome VAA lookup", () => {
  // From-rome burns emit the Wormhole message on SOLANA; the only handle the
  // record holds is the Rome burn tx → resolved Solana sig. Wormholescan
  // supports lookup by txHash — no emitter/sequence parsing needed.
  const okJson = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("GETs /api/v1/vaas?txHash= and returns the VAA when signed", async () => {
    const fetchMock = vi.fn(async () => okJson({ data: [{ vaa: "AQAAAA==" }] }));
    const client = new WormholeAttestationClient({ baseUrl: "https://scan.example", fetch: fetchMock as never });
    const r = await client.fetchByTxHash("5sig11111111111111111111111111111111111111111");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://scan.example/api/v1/vaas?txHash=5sig11111111111111111111111111111111111111111");
    expect(r).toEqual({ status: "complete", vaa: "AQAAAA==" });
  });

  it("pending when wormholescan has no VAA yet (404 or empty data)", async () => {
    const client404 = new WormholeAttestationClient({ baseUrl: "https://scan.example", fetch: vi.fn(async () => new Response("", { status: 404 })) as never });
    expect(await client404.fetchByTxHash("sig")).toEqual({ status: "pending" });
    const clientEmpty = new WormholeAttestationClient({ baseUrl: "https://scan.example", fetch: vi.fn(async () => okJson({ data: [] })) as never });
    expect(await clientEmpty.fetchByTxHash("sig")).toEqual({ status: "pending" });
  });
});
