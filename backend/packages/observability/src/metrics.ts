import { metrics, type Attributes } from "@opentelemetry/api";
import { PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, MetricReader, type ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/**
 * Metrics — docs/20_OBSERVABILITY.md §2.1, docs/26_DECISIONS.md ADR-082.
 *
 * docs/20 specifies a full metrics table: request rate and duration, provider latency and error
 * rate, token and cost counters, queue depth and dead letters, agent iterations, tool failures,
 * media job duration. None of it existed. The platform had structured logs and real trace spans
 * (ADR-073) and no metrics at all — which is the gap that matters operationally, because a trace
 * answers "what happened in THIS request" and only a metric answers "is the error rate climbing".
 *
 * WHY PULL, NOT PUSH. The obvious implementation is a `PeriodicExportingMetricReader` pushing
 * OTLP to a Collector. This platform has no Collector — the same constraint ADR-036 recorded for
 * tracing — and a push exporter aimed at nothing drops every data point silently. A pull reader
 * serialised to Prometheus text is scrapeable by anything, needs no external service, and can be
 * verified by looking at it, which is the property that matters for a claim nobody has checked.
 *
 * WHY NOT ITS OWN PORT. `PrometheusExporter` starts an HTTP server on :9464 with no
 * authentication. Metrics carry tenant-labelled cost and token counters, so that would publish
 * per-project spend on an unauthenticated port. This reader is collected on demand and served
 * from the API's own system-admin-only `/api/v1/admin/metrics` instead — one port, one auth
 * model, no new exposure.
 */

/**
 * A `MetricReader` that does nothing on its own schedule and produces a Prometheus text
 * exposition when asked.
 *
 * The SDK has no built-in on-demand reader: every shipped one is periodic or owns a server. This
 * is the smallest possible subclass — `collect()` is already protected-but-available on the base
 * class, so all that is needed is to satisfy the abstract lifecycle hooks and expose a scrape.
 */
class OnDemandMetricReader extends MetricReader {
  private readonly serializer = new PrometheusSerializer();

  protected async onForceFlush(): Promise<void> {
    /* Nothing is buffered: collection happens synchronously inside `scrape`. */
  }

  protected async onShutdown(): Promise<void> {
    /* The reader owns no socket and no timer, so there is nothing to release. */
  }

  /** The current values, in Prometheus text exposition format. */
  async scrape(): Promise<string> {
    const { resourceMetrics, errors } = await this.collect();
    if (errors.length > 0) {
      // Surfaced rather than swallowed: a collection error means some instrument is silently
      // missing from the output, and an operator reading a gap in a dashboard would otherwise
      // have no way to tell "nothing happened" from "the metric did not collect".
      throw new Error(`Metric collection reported ${errors.length} error(s): ${errors.map(String).join("; ")}`);
    }
    return this.serializer.serialize(resourceMetrics as ResourceMetrics);
  }
}

let reader: OnDemandMetricReader | null = null;
let provider: MeterProvider | null = null;

/**
 * Installs the global meter provider. Idempotent, like `initTracing` — the API process and its
 * job workers share one, and a second provider would silently split the counters in two.
 */
export function initMetrics(serviceName: string): void {
  if (provider) return;
  reader = new OnDemandMetricReader();
  provider = new MeterProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    readers: [reader],
  });
  metrics.setGlobalMeterProvider(provider);
}

/**
 * The current metrics in Prometheus text format, or null when metrics were never initialised.
 *
 * Null rather than an empty string: a process that never called `initMetrics` and one that has
 * recorded nothing yet are different states, and only the first is a wiring bug.
 */
export async function scrapeMetrics(): Promise<string | null> {
  if (!reader) return null;
  return reader.scrape();
}

export async function shutdownMetrics(): Promise<void> {
  await provider?.shutdown();
  provider = null;
  reader = null;
  /**
   * The instrument cache MUST be cleared with the provider.
   *
   * Every cached instrument holds a reference to the meter that created it. Leaving them behind
   * means a later `initMetrics` installs a fresh provider while every recorder keeps writing to
   * the dead one — recording nothing, forever, with no error, and a scrape that reports "no
   * registered metrics" while the code looks like it is working. Found by a test that shut the
   * provider down and re-initialised it, which is exactly what a worker restart does.
   */
  instruments.clear();
  observableGauges.clear();
  /**
   * And the GLOBAL registration has to be released too.
   *
   * `metrics.setGlobalMeterProvider` is a no-op once a global is already set — the OTel API logs
   * a warning and keeps the first one. So without this, a shutdown followed by a re-init leaves
   * the dead provider installed and every recorder writes into it: the scrape then reports "no
   * registered metrics" while the code reads as if it works. Exactly the class of silent failure
   * this module's lazy-instrument comment already warns about, one level up.
   */
  metrics.disable();
}

/**
 * Instruments are created lazily and cached.
 *
 * `metrics.getMeter()` before a provider is registered returns a no-op meter and CACHES it, so
 * creating instruments at module load would permanently bind every one of them to the no-op —
 * recording nothing, forever, with no error. Resolving on first use instead means the order of
 * `initMetrics` and the first `record...` call cannot silently break metrics.
 */
const instruments = new Map<string, unknown>();
/** Observable instruments, tracked separately because they are registered, not recorded into. */
const observableGauges = new Map<string, ReturnType<ReturnType<typeof metrics.getMeter>["createObservableGauge"]>>();

function counter(name: string, description: string, unit?: string) {
  const key = `c:${name}`;
  if (!instruments.has(key)) {
    instruments.set(key, metrics.getMeter("ai-platform").createCounter(name, { description, unit }));
  }
  return instruments.get(key) as ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
}

function histogram(name: string, description: string, unit?: string) {
  const key = `h:${name}`;
  if (!instruments.has(key)) {
    instruments.set(key, metrics.getMeter("ai-platform").createHistogram(name, { description, unit }));
  }
  return instruments.get(key) as ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]>;
}

/**
 * The recorders below are the whole public surface.
 *
 * Named functions rather than exported instruments so a call site cannot invent a label set: the
 * cardinality of a metric is a property of the system, and a stray high-cardinality label (a
 * request id, a user id, a raw error message) is the classic way to take down a metrics backend.
 * Every label here is bounded by construction.
 *
 * `project_id` is deliberately ABSENT from all of them. docs/20's table labels cost metrics by
 * `org_id`, and even that is a judgement call; per-project labels would make cardinality grow
 * with the tenant count without bound. Per-tenant spend is already answerable exactly from the
 * `usage_records` ledger (ADR-046), which is the right tool for a number that has to be correct
 * rather than approximate.
 */

/** RED-method rate and errors, plus duration. Route is the Fastify route PATTERN, not the URL. */
export function recordHttpRequest(attrs: {
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
}): void {
  // The pattern (`/api/v1/files/:id`), never the resolved path: labelling by URL would create a
  // new time series per document id.
  const labels: Attributes = {
    route: attrs.route,
    method: attrs.method,
    status_code: String(attrs.statusCode),
  };
  counter("http_requests_total", "API requests by route, method and status").add(1, labels);
  histogram("http_request_duration_seconds", "API request latency", "s").record(attrs.durationMs / 1000, labels);
}

/** Provider volume, latency and error segmentation — docs/20 §2.1's alerting priority 1. */
export function recordProviderCall(attrs: {
  provider: string;
  model: string;
  /**
   * `cancelled` really is one of these — docs/26_DECISIONS.md ADR-155.
   *
   * `ProviderCallOutcome.status` is a three-way union and the composition root flattened it
   * with `call.status === "error" ? "error" : "success"`, directly under a comment saying a
   * cancelled call "is left out entirely so it does not inflate the success rate". It did the
   * opposite: every user who pressed Stop, and every abandoned SSE stream, counted as a
   * successful provider call. Given that the platform's own cancellation work (ADR-119, ADR-146)
   * makes abandonment routine, that is a success rate measuring something else.
   *
   * It is accepted here and dropped from the COUNTER rather than rejected at the call site, so
   * the latency histogram still sees it: the call did happen and it did take time.
   */
  status: "success" | "error" | "timeout" | "cancelled";
  durationMs: number;
  /** Bounded category, never the raw message — `rate_limit`, `auth`, `server`, `timeout`. */
  errorType?: string;
}): void {
  const labels: Attributes = { provider: attrs.provider, model: attrs.model, status: attrs.status };
  if (attrs.status !== "cancelled") {
    counter("provider_request_count", "Model provider calls by provider, model and outcome").add(1, labels);
  }
  histogram("provider_latency_ms", "Model provider call latency", "ms").record(attrs.durationMs, {
    provider: attrs.provider,
    model: attrs.model,
  });
  if (attrs.errorType) {
    counter("provider_error_count", "Provider errors segmented by type").add(1, {
      provider: attrs.provider,
      model: attrs.model,
      error_type: attrs.errorType,
    });
  }
}

/** Times a provider fell back to another — the signal that an adapter or upstream is degraded. */
export function recordProviderFallback(attrs: { from: string; to: string }): void {
  counter("provider_fallback_count", "Times the router fell back from one provider to another").add(1, {
    from: attrs.from,
    to: attrs.to,
  });
}

export function recordTokenUsage(attrs: {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd?: number | null;
}): void {
  const base = { provider: attrs.provider, model: attrs.model };
  const tokens = counter("token_usage_total", "Tokens consumed", "1");
  tokens.add(attrs.inputTokens, { ...base, direction: "input" });
  tokens.add(attrs.outputTokens, { ...base, direction: "output" });
  // Only when a real price exists. Adding 0 for an unpriced model would make a dashboard read
  // "this model is free" rather than "this model's price is unknown" (ADR-046's rule).
  if (attrs.estimatedCostUsd !== null && attrs.estimatedCostUsd !== undefined) {
    counter("cost_estimate_usd_total", "Running estimated spend", "USD").add(attrs.estimatedCostUsd, base);
  }
}

export function recordJobProcessed(attrs: {
  queue: string;
  outcome: "success" | "failure";
  durationMs: number;
  retryCount?: number;
}): void {
  counter("job_processed_total", "Jobs processed by queue and outcome").add(1, {
    queue: attrs.queue,
    outcome: attrs.outcome,
  });
  histogram("job_duration_seconds", "Job processing duration", "s").record(attrs.durationMs / 1000, {
    queue: attrs.queue,
  });
  if (attrs.retryCount && attrs.retryCount > 0) {
    counter("job_retry_total", "Job retries by queue").add(1, { queue: attrs.queue });
  }
}

/** A job that exhausted its retries and was dead-lettered (ADR-072) — always worth alerting on. */
export function recordDeadLetter(attrs: { queue: string }): void {
  counter("job_dead_letter_total", "Jobs that exhausted their retries").add(1, { queue: attrs.queue });
}

export function recordAgentRun(attrs: {
  outcome: "success" | "failed" | "cancelled" | "max_iterations" | "awaiting_approval";
  durationMs: number;
  stepCount: number;
}): void {
  const labels: Attributes = { outcome: attrs.outcome };
  histogram("agent_run_duration_seconds", "Full agent run duration", "s").record(attrs.durationMs / 1000, labels);
  // A rising step count is an early warning of a looping planner — cheaper to catch here than on
  // the bill (docs/20 §2.1).
  histogram("agent_step_count", "Steps per agent run", "1").record(attrs.stepCount, labels);
}

export function recordToolCall(attrs: { tool: string; outcome: string }): void {
  counter("tool_call_count", "Tool invocations by tool and outcome").add(1, {
    tool_name: attrs.tool,
    status: attrs.outcome,
  });
}

/** Media generation end to end — image or video, success or failure. */
export function recordMediaJob(attrs: {
  mediaType: "image" | "video" | "audio";
  provider: string;
  outcome: "success" | "failure";
  durationMs: number;
}): void {
  histogram("generation_duration_seconds", "Media generation duration", "s").record(attrs.durationMs / 1000, {
    media_type: attrs.mediaType,
    provider: attrs.provider,
  });
  counter("generation_total", "Media generations by type, provider and outcome").add(1, {
    media_type: attrs.mediaType,
    provider: attrs.provider,
    outcome: attrs.outcome,
  });
}

/**
 * Queue depth, as an observable gauge.
 *
 * A gauge is registered with a CALLBACK rather than set imperatively because depth is a property
 * of the queue at scrape time, not an event: setting it on every enqueue would report the depth
 * as of the last write, which is exactly wrong for the metric an operator uses to decide whether
 * workers are keeping up.
 */
export function observeQueueDepth(callback: () => Promise<Record<string, number>>): void {
  // One gauge per provider lifetime. Registering a second callback on the same instrument would
  // make every scrape observe the queue twice and report the last write to win, rather than
  // failing visibly.
  const existing = observableGauges.get("queue_depth");
  const gauge =
    existing ??
    metrics.getMeter("ai-platform").createObservableGauge("queue_depth", {
      description: "Jobs waiting per queue",
    });
  observableGauges.set("queue_depth", gauge);
  gauge.addCallback(async (result) => {
    try {
      const depths = await callback();
      for (const [queue, depth] of Object.entries(depths)) {
        result.observe(depth, { queue });
      }
    } catch {
      // A failed observation must not fail the whole scrape and take every other metric with it.
      // The gap in the series is itself the signal that the queue could not be read.
    }
  });
}
