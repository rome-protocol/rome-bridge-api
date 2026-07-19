import { Registry, Counter, Histogram, Gauge } from "prom-client";

export const registry = new Registry();

export const httpRequestsTotal = new Counter({
  name: "rome_bridge_api_http_requests_total",
  help: "Total HTTP requests by route + status",
  labelNames: ["route", "status"] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: "rome_bridge_api_http_request_duration_seconds",
  help: "HTTP request latency by route",
  labelNames: ["route"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const bridgeErrorsTotal = new Counter({
  name: "rome_bridge_api_errors_total",
  help: "Bridge-specific errors by code",
  labelNames: ["code"] as const,
  registers: [registry],
});

export const attestationPollerLagSeconds = new Gauge({
  name: "rome_bridge_api_attestation_poller_lag_seconds",
  help: "Seconds since last successful poll from vendor attestation API",
  labelNames: ["vendor"] as const,
  registers: [registry],
});

export const transferOutcomeTotal = new Counter({
  name: "rome_bridge_api_transfer_outcome_total",
  help: "Transfer outcomes by route + outcome",
  labelNames: ["route", "outcome"] as const,
  registers: [registry],
});

// Histogram tracking the wall-clock duration of the poller's redis.keys()
// scan over all transfer records. flagged the O(N) scan; at v1.0
// single-digit-transfer volume it's noise, but the cost grows linearly with
// total transfers ever created. Watch p99 in prod; if it crosses ~100ms,
// switch to a pending-transfers Redis SET index. Buckets sized for that
// transition point.
export const pollerKeysScanDurationSeconds = new Histogram({
  name: "rome_bridge_api_poller_keys_scan_duration_seconds",
  help: "Duration of the AttestationPoller's redis.keys() scan over all transfers",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

// Age of the oldest sponsor-waiting pending transfer (user-paced claims are
// excluded by the reaper). THE "something is stalling" alert signal — a
// healthy server keeps this bounded by attestation latency (minutes); growth
// past the expiry TTL means records are dying.
export const pendingOldestAgeSeconds = new Gauge({
  name: "rome_bridge_api_pending_oldest_age_seconds",
  help: "Age in seconds of the oldest pending transfer awaiting sponsor progress",
  registers: [registry],
});
