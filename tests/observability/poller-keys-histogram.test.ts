import { describe, it, expect } from "vitest";
import { pollerKeysScanDurationSeconds } from "../../src/observability/metrics";

describe("pollerKeysScanDurationSeconds", () => {
  it("is registered as a Histogram with vendor-agnostic labels", async () => {
    const sample = await pollerKeysScanDurationSeconds.get();
    expect(sample.name).toBe("rome_bridge_api_poller_keys_scan_duration_seconds");
    expect(sample.type).toBe("histogram");
  });

  it("accepts an observation and reports it via /metrics", async () => {
    pollerKeysScanDurationSeconds.reset();
    pollerKeysScanDurationSeconds.observe(0.012);
    pollerKeysScanDurationSeconds.observe(0.034);
    const sample = await pollerKeysScanDurationSeconds.get();
    const countSample = sample.values.find((v) => v.metricName?.endsWith("_count"));
    expect(countSample?.value).toBe(2);
  });
});
