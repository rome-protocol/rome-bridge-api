export const BRIDGE_ERROR_CODES = [
  "rome.bridge.asset-not-supported",
  "rome.bridge.attestation-not-ready",
  "rome.bridge.source-tx-mismatch",
  "rome.bridge.source-tx-not-found",
  "rome.bridge.amount-out-of-range",
  "rome.bridge.rate-limited",
  "rome.bridge.quote-expired",
  "rome.bridge.sender-incomplete",
  "rome.bridge.step-not-ready",
  "rome.bridge.step-tx-mismatch",
  "rome.bridge.step-expired",
  "rome.bridge.recipient-invalid",
  "rome.bridge.request-invalid",
  "rome.bridge.chain-id-ambiguous",
  "rome.bridge.program-id-unknown",
  "rome.bridge.chain-misconfigured",
  "rome.bridge.v1-phased-out",
  "rome.bridge.source-chain-conflict",
  "rome.bridge.upstream-unavailable",
] as const;
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

const TITLES: Record<BridgeErrorCode, { title: string; status: number }> = {
  "rome.bridge.asset-not-supported":    { title: "Asset not supported",       status: 400 },
  "rome.bridge.attestation-not-ready":  { title: "Attestation not ready",     status: 425 },
  "rome.bridge.source-tx-mismatch":     { title: "Source tx mismatch",        status: 400 },
  "rome.bridge.source-tx-not-found":    { title: "Source tx not found",       status: 404 },
  "rome.bridge.amount-out-of-range":    { title: "Amount out of range",       status: 400 },
  "rome.bridge.rate-limited":           { title: "Rate limited",              status: 429 },
  "rome.bridge.quote-expired":          { title: "Quote expired",             status: 410 },
  "rome.bridge.sender-incomplete":      { title: "Sender address incomplete", status: 400 },
  "rome.bridge.step-not-ready":         { title: "Step not ready",            status: 409 },
  "rome.bridge.step-tx-mismatch":       { title: "Step tx mismatch",          status: 400 },
  "rome.bridge.step-expired":           { title: "Step expired",              status: 410 },
  "rome.bridge.recipient-invalid":      { title: "Recipient invalid",         status: 400 },
  "rome.bridge.request-invalid":        { title: "Request invalid",           status: 400 },
  "rome.bridge.chain-id-ambiguous":     { title: "Chain ID ambiguous across programs", status: 409 },
  "rome.bridge.program-id-unknown":     { title: "Program ID not in registry",         status: 400 },
  "rome.bridge.chain-misconfigured":    { title: "Chain misconfigured in registry",    status: 500 },
  "rome.bridge.v1-phased-out":          { title: "CCTP V1 phased out",                 status: 410 },
  "rome.bridge.source-chain-conflict":  { title: "Source chain fields conflict",       status: 400 },
  "rome.bridge.upstream-unavailable":   { title: "Upstream chain RPC unavailable",      status: 503 },
};

export interface BridgeError {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: BridgeErrorCode;
  meta?: Record<string, unknown>;
}

export function bridgeError(code: BridgeErrorCode, detail: string, meta?: Record<string, unknown>): Error & BridgeError {
  const entry = TITLES[code];
  if (!entry) throw new Error(`unknown bridge error code: ${code}`);
  const err = new Error(detail) as Error & BridgeError;
  err.type = `https://bridge.romeprotocol.xyz/errors/${code}`;
  err.title = entry.title;
  err.status = entry.status;
  err.detail = detail;
  err.code = code;
  if (meta) err.meta = meta;
  return err;
}
