/**
 * Iris V2 messages client.
 *
 * `GET {irisBase}/v2/messages/{sourceDomain}?transactionHash={tx}` returns the
 * message AND its attestation together (direction-agnostic); `status:
 * "complete"` gates advance. The base URL + domain come from the CALLER (the
 * transfer record's stamp) — never module state — so in-flight records drain
 * against exactly the iris they were quoted with.
 */
import { withTimeout } from "../lib/fetch-timeout.js";

export type CircleV2Status = "complete" | "pending" | "not-found" | "failed";

export interface CircleV2Result {
  status: CircleV2Status;
  /** 0x-hex wire message (148B header + body) — present when complete. */
  message?: string;
  /** 0x-hex attestation — present when complete. */
  attestation?: string;
  eventNonce?: string;
}

export interface CircleV2ClientOpts {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface IrisV2Message {
  status?: string;
  message?: string;
  attestation?: string;
  eventNonce?: string;
}

export class CircleV2AttestationClient {
  private fetchFn: typeof fetch;

  constructor(opts: CircleV2ClientOpts = {}) {
    this.fetchFn = withTimeout(opts.fetch ?? globalThis.fetch, opts.timeoutMs ?? 10_000);
  }

  fetchByTxHash(irisBase: string, sourceDomain: number, txHash: string): Promise<CircleV2Result> {
    return this.fetchMessages(`${irisBase}/v2/messages/${sourceDomain}?transactionHash=${txHash}`);
  }

  /** Outbound leg: iris keys the Solana-source message by nonce. */
  fetchByNonce(irisBase: string, sourceDomain: number, nonce: string): Promise<CircleV2Result> {
    return this.fetchMessages(`${irisBase}/v2/messages/${sourceDomain}?nonce=${nonce}`);
  }

  private async fetchMessages(url: string): Promise<CircleV2Result> {
    const res = await this.fetchFn(url, { headers: { accept: "application/json" } });
    if (res.status === 404) return { status: "not-found" };
    if (!res.ok) throw Object.assign(new Error(`Iris v2 ${res.status}`), { upstreamAnswered: true });
    let body: { messages?: IrisV2Message[] };
    try {
      body = (await res.json()) as { messages?: IrisV2Message[] };
    } catch {
      return { status: "failed" };
    }
    if (!Array.isArray(body.messages)) return { status: "failed" };
    const msg = body.messages[0];
    if (!msg) return { status: "not-found" };
    if (msg.status === "complete" && msg.message && msg.attestation) {
      const out: CircleV2Result = { status: "complete", message: msg.message, attestation: msg.attestation };
      if (msg.eventNonce) out.eventNonce = msg.eventNonce;
      return out;
    }
    if (msg.status === "pending_confirmations" || msg.status === "pending") return { status: "pending" };
    return { status: "failed" };
  }
}
