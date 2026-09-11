import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  initMetrics,
  observeQueueDepth,
  recordDeadLetter,
  recordHttpRequest,
  recordJobProcessed,
  recordProviderCall,
  recordProviderFallback,
  recordTokenUsage,
  recordToolCall,
  scrapeMetrics,
  shutdownMetrics,
} from "./metrics.js";

/**
 * docs/26_DECISIONS.md ADR-082.
 *
 * docs/20_OBSERVABILITY.md §2.1 has specified a full metrics table since the project began and
 * none of it existed — the platform had structured logs and real trace spans and no metrics at
 * all. These tests assert against the REAL Prometheus exposition the scrape endpoint serves, not
 * against the recorder functions having been called: a recorder that writes to a no-op meter
 * satisfies a spy and produces an empty scrape, which is precisely the failure mode that makes
 * metrics look present when they are not.
 */
describe("metrics", () => {
  beforeEach(() => {
    initMetrics("metrics-test");
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it("serves a real Prometheus exposition of what was recorded", async () => {
    recordHttpRequest({ route: "/api/v1/files/:id", method: "GET", statusCode: 200, durationMs: 12 });
    const text = (await scrapeMetrics()) ?? "";

    expect(text).toContain('http_requests_total{route="/api/v1/files/:id"');
    expect(text).toContain('method="GET"');
    expect(text).toContain('status_code="200"');
    // A histogram is only useful if the buckets are really there — a p95 cannot be computed
    // from a sum and a count.
    expect(text).toContain("http_request_duration_seconds_bucket");
    expect(text).toContain("http_request_duration_seconds_sum");
  });

  it("records tokens in both directions separately", async () => {
    recordTokenUsage({ provider: "local", model: "qwen2.5:1.5b", inputTokens: 32, outputTokens: 10 });
    const text = (await scrapeMetrics()) ?? "";

    expect(text).toMatch(/token_usage_total\{[^}]*direction="input"[^}]*\}\s+32/);
    expect(text).toMatch(/token_usage_total\{[^}]*direction="output"[^}]*\}\s+10/);
  });

  it("does NOT record a cost of zero for a model with no known price", async () => {
    // The rule from ADR-046, carried into metrics: an unpriced model must read as "price
    // unknown", never as "free". A zero here would make a spend dashboard silently wrong, and
    // the local self-hosted runtime — the DEFAULT provider — is exactly such a model.
    recordTokenUsage({ provider: "local", model: "qwen2.5:1.5b", inputTokens: 5, outputTokens: 5, estimatedCostUsd: null });
    expect((await scrapeMetrics()) ?? "").not.toContain("cost_estimate_usd_total");
  });

  it("records a cost when one is genuinely known", async () => {
    recordTokenUsage({ provider: "openai", model: "gpt-4o", inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.0125 });
    expect((await scrapeMetrics()) ?? "").toContain("cost_estimate_usd_total");
  });

  it("segments provider errors by type, which is what an alert threshold needs", async () => {
    recordProviderCall({ provider: "openai", model: "gpt-4o", status: "error", durationMs: 90, errorType: "rate_limit" });
    recordProviderCall({ provider: "openai", model: "gpt-4o", status: "timeout", durationMs: 30_000, errorType: "timeout" });
    const text = (await scrapeMetrics()) ?? "";

    // docs/20 §2.1 alerting priority 1: a spike is only actionable if rate-limit is
    // distinguishable from auth from server error.
    expect(text).toContain('error_type="rate_limit"');
    expect(text).toContain('error_type="timeout"');
    expect(text).toContain('status="error"');
  });

  it("counts provider fallbacks with both ends named", async () => {
    recordProviderFallback({ from: "openai", to: "local" });
    const text = (await scrapeMetrics()) ?? "";
    expect(text).toMatch(/provider_fallback_count_total\{[^}]*from="openai"[^}]*to="local"/);
  });

  it("counts jobs, retries and dead letters separately", async () => {
    recordJobProcessed({ queue: "document.ingest", outcome: "success", durationMs: 1200 });
    recordJobProcessed({ queue: "document.scan", outcome: "failure", durationMs: 400, retryCount: 2 });
    recordDeadLetter({ queue: "document.scan" });
    const text = (await scrapeMetrics()) ?? "";

    expect(text).toMatch(/job_processed_total\{[^}]*outcome="success"/);
    expect(text).toMatch(/job_processed_total\{[^}]*outcome="failure"/);
    expect(text).toContain("job_retry_total");
    // A dead letter is the one job metric that should always be worth waking someone for, so it
    // is its own series rather than a label on a failure count.
    expect(text).toContain("job_dead_letter_total");
  });

  it("records a tool call's real outcome, not just that it happened", async () => {
    recordToolCall({ tool: "fs.read_file", outcome: "error" });
    recordToolCall({ tool: "fs.read_file", outcome: "ok" });
    const text = (await scrapeMetrics()) ?? "";
    expect(text).toMatch(/tool_call_count_total\{[^}]*tool_name="fs.read_file"[^}]*status="error"/);
    expect(text).toMatch(/tool_call_count_total\{[^}]*tool_name="fs.read_file"[^}]*status="ok"/);
  });

  it("observes queue depth at scrape time rather than at write time", async () => {
    // Depth is a property of the queue NOW, not an event. The callback must run during the
    // scrape, or the value reported is the depth as of the last enqueue — exactly wrong for the
    // metric used to decide whether workers are keeping up.
    let observations = 0;
    observeQueueDepth(async () => {
      observations += 1;
      return { "document.ingest": 7 };
    });

    expect(observations).toBe(0);
    const text = (await scrapeMetrics()) ?? "";
    expect(observations).toBe(1);
    expect(text).toMatch(/queue_depth\{[^}]*queue="document.ingest"[^}]*\}\s+7/);
  });

  it("survives a queue-depth callback that throws, rather than failing the whole scrape", async () => {
    observeQueueDepth(async () => {
      throw new Error("database unreachable");
    });
    recordHttpRequest({ route: "/api/health", method: "GET", statusCode: 200, durationMs: 1 });

    // One broken observation must not take every other metric with it — the gap in that one
    // series is itself the signal.
    const text = (await scrapeMetrics()) ?? "";
    expect(text).toContain("http_requests_total");
  });

  it("reports null when metrics were never initialised", async () => {
    await shutdownMetrics();
    // Null, not an empty string: "this process never wired metrics" is a configuration bug and
    // must be distinguishable from "nothing has been recorded yet", which is normal.
    expect(await scrapeMetrics()).toBeNull();
    initMetrics("metrics-test");
  });
});
