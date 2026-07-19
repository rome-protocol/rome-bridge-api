import { withTimeout } from "../lib/fetch-timeout.js";
export type CircleAttestationStatus = "complete" | "pending" | "failed";
export interface CircleAttestationResult {
  status: CircleAttestationStatus;
  attestation?: string;
}

export interface CircleClientOpts {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class CircleAttestationClient {
  private fetchFn: typeof fetch;
  constructor(private opts: CircleClientOpts) {
    this.fetchFn = withTimeout(opts.fetch ?? globalThis.fetch, opts.timeoutMs ?? 10_000);
  }

  async fetch(messageHash: string): Promise<CircleAttestationResult> {
    const res = await this.fetchFn(`${this.opts.baseUrl}/attestations/${messageHash}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw Object.assign(new Error(`Iris ${res.status}`), { upstreamAnswered: true });
    const body = (await res.json()) as { status: string; attestation?: string };
    if (body.status === "complete" && body.attestation) return { status: "complete", attestation: body.attestation };
    if (body.status === "pending_confirmations" || body.status === "pending") return { status: "pending" };
    return { status: "failed" };
  }
}
