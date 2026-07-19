import { withTimeout } from "../lib/fetch-timeout.js";
export type WormholeAttestationStatus = "complete" | "pending" | "failed";
export interface WormholeAttestationResult {
  status: WormholeAttestationStatus;
  vaa?: string;
}

export interface WormholeClientOpts {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class WormholeAttestationClient {
  private fetchFn: typeof fetch;
  constructor(private opts: WormholeClientOpts) {
    this.fetchFn = withTimeout(opts.fetch ?? globalThis.fetch, opts.timeoutMs ?? 10_000);
  }

  async fetch(emitterChainId: number, emitterAddress: string, sequence: bigint): Promise<WormholeAttestationResult> {
    const url = `${this.opts.baseUrl}/api/v1/vaas/${emitterChainId}/${emitterAddress}/${sequence}`;
    const res = await this.fetchFn(url, { headers: { accept: "application/json" } });
    if (res.status === 404) return { status: "pending" };
    if (!res.ok) throw Object.assign(new Error(`Wormholescan ${res.status}`), { upstreamAnswered: true });
    const body = (await res.json()) as { data?: { vaa?: string } };
    if (body.data?.vaa) return { status: "complete", vaa: body.data.vaa };
    return { status: "failed" };
  }

  /**
   * VAA lookup by source tx hash (from-rome: the resolved SOLANA sig of the
   * Rome burn). Avoids emitter/sequence parsing entirely — wormholescan
   * indexes VAAs by the emitting tx.
   */
  async fetchByTxHash(txHash: string): Promise<WormholeAttestationResult> {
    const url = `${this.opts.baseUrl}/api/v1/vaas?txHash=${encodeURIComponent(txHash)}`;
    const res = await this.fetchFn(url, { headers: { accept: "application/json" } });
    if (res.status === 404) return { status: "pending" };
    if (!res.ok) throw Object.assign(new Error(`Wormholescan ${res.status}`), { upstreamAnswered: true });
    const body = (await res.json()) as { data?: Array<{ vaa?: string }> };
    const vaa = body.data?.[0]?.vaa;
    if (vaa) return { status: "complete", vaa };
    return { status: "pending" }; // indexed-but-unsigned or not yet indexed — retry
  }
}
