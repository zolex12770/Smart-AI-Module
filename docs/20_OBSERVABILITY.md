# 20. Observability

This document designs structured logging, metrics, and distributed tracing for the platform's
Node.js/TypeScript services (API, worker, provider adapters, agent loop). The goal is that any
agent run, generation job, or API request can be fully reconstructed after the fact — what
happened, in what order, at what cost, and where time was spent — without needing to reproduce it.

Standard: **OpenTelemetry (OTel)** for all three signal types (logs, metrics, traces), because it
is vendor-neutral. The same instrumentation exports to Google Cloud Trace/Logging/Monitoring in
production and to a self-hosted Grafana/Loki/Tempo stack in local development, with no code
change — only the exporter configuration differs per environment. This matters given the platform
has no GCP project yet (`18_CLOUD_ARCHITECTURE.md`): building on OTel from day one means local dev
is fully observable today, and the eventual move to Cloud Trace/Logging is a config change, not a
rewrite.

## 1. Structured logging

### 1.1 Format and library

- Emit **structured JSON logs** to stdout/stderr (never plain text) — this is what makes logs
  machine-parseable by Cloud Logging automatically, and by Loki/any log aggregator locally.
- Recommended library: **Pino** (fast, low-overhead JSON logger for Node.js) with a request-scoped
  child logger pattern — bind common fields once per request/job at entry and every subsequent log
  call in that request's call stack inherits them automatically (via `AsyncLocalStorage` or the
  logger's child-binding), rather than manually threading fields through every function call.

### 1.2 Required fields

Every log line in the system should carry this baseline context (bound once via a child logger at
the point a request/job/agent-run begins):

| Field | Description |
|---|---|
| `timestamp` | ISO 8601, UTC |
| `severity` | `debug` / `info` / `warn` / `error` / `critical` |
| `request_id` | Unique per inbound HTTP request (generated at the edge, propagated via a header e.g. `x-request-id` to downstream calls) |
| `task_id` | Unique per agent run / conversation turn the request belongs to (an agent run can span multiple requests/steps; this ties them together) |
| `job_id` | Unique per queued job (Cloud Tasks task, or generic job-queue item) — set only on worker-side logs |
| `user_id` | Authenticated user, when present (omit/null for unauthenticated or system-internal logs) |
| `org_id` | Tenant/organization ID, for multi-tenant filtering and per-tenant cost/usage rollups |
| `model` | Model identifier (e.g. `gemini-2.5-pro`, `gpt-4.1`, `mock-chat-v1`) |
| `provider` | Provider adapter name (`vertex`, `openai`, `anthropic`, `mock`) |
| `latency_ms` | Duration of the operation the log line reports on |
| `tokens_input` / `tokens_output` | Token counts for the specific model call, when applicable |
| `cost_estimate_usd` | Computed from token counts × the provider's published per-token rate at call time (see §1.3) |
| `tool_name` | For tool-call logs: which tool was invoked |
| `mcp_server_id` | For MCP-routed tool calls: which registered MCP server handled it |
| `sandbox_id` | For coding-agent logs: which ephemeral sandbox executed the step (ties to the security audit trail in `13_SECURITY_ARCHITECTURE.md` §6) |
| `error.type` / `error.message` / `error.stack` | On any error-level log |

Field-naming note: these align closely with (and should adopt, where applicable) the
**OpenTelemetry GenAI semantic conventions** — `gen_ai.request.model`, `gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons` — so that log fields and trace/span
attributes use the same vocabulary and can be correlated without a translation layer. OTel's GenAI
conventions are opt-in specifically for the fields that could carry prompt/response content
(`gen_ai.input.messages`, `gen_ai.output.messages`), which is the right default for this platform
too: log token counts and cost by default, but only log full prompt/response bodies behind an
explicit, environment-gated debug flag, and never for logs that will be retained long-term or
shipped to a third-party log sink without a data-handling review (prompts and outputs can contain
PII or customer secrets).

### 1.3 Cost estimation

Maintain a small, versioned in-repo pricing table (`$ per 1M input tokens` / `$ per 1M output
tokens`, and per-image/per-second-of-video rates for media providers) per provider/model, updated
when providers change pricing. Every provider-adapter call computes `cost_estimate_usd` from this
table at call time and includes it in the log line and the corresponding trace span (§3). This is
an *estimate* for observability/budgeting purposes, not a substitute for the provider's actual
invoice — label it clearly as an estimate in any dashboard.

### 1.4 What NOT to log

- Raw API keys/secrets — redact by field-name allow-list in the logger's serializer (defense in
  depth even though secrets shouldn't be in-scope of a log call to begin with).
- Full prompt/response text by default (see §1.2 above).
- Full file contents from coding-agent file edits — log the diff summary (files touched, lines
  changed) and a content hash, not the full content, unless debug-mode is explicitly enabled.

## 2. Metrics

Use OpenTelemetry's Metrics API to emit the following, exported to Cloud Monitoring in production
and to Prometheus (scraped by the local Grafana stack, §4) in development.

### 2.1 Core metrics

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `queue_depth` | Gauge | `queue_name` | Pending jobs in Cloud Tasks/job queue; alert if sustained growth (worker can't keep up) |
| `queue_age_oldest_seconds` | Gauge | `queue_name` | Age of the oldest unprocessed job; better SLO signal than raw depth |
| `worker_active_count` | Gauge | `worker_pool` | Currently-processing jobs per worker pool |
| `worker_health` | Gauge (0/1) | `instance_id` | Liveness/readiness signal per worker instance |
| `provider_request_count` | Counter | `provider`, `model`, `status` (`success`/`error`/`timeout`) | Volume and error rate per provider/model |
| `provider_error_rate` | Derived (from the above) | `provider`, `model`, `error_type` | Alert threshold target; segmented by error type (rate-limit vs. auth vs. server error vs. timeout) so a spike is actionable |
| `provider_latency_ms` | Histogram | `provider`, `model` | Provider call latency distribution (p50/p95/p99) |
| `generation_duration_seconds` | Histogram | `provider`, `media_type` (`image`/`video`) | End-to-end media generation job duration |
| `token_usage_total` | Counter | `provider`, `model`, `direction` (`input`/`output`), `org_id` | Token consumption, rollup source for cost dashboards and per-tenant budgets |
| `cost_estimate_usd_total` | Counter | `provider`, `model`, `org_id` | Running cost estimate, mirrors `token_usage_total` but pre-computed for direct dashboarding |
| `agent_run_duration_seconds` | Histogram | `outcome` (`success`/`failed`/`max_steps_exceeded`/`human_rejected`) | How long a full agent run takes, and how it ended |
| `agent_step_count` | Histogram | `outcome` | Number of steps (LLM calls + tool calls) per agent run — a rising trend can indicate loop/planning problems worth investigating before it becomes a cost problem |
| `tool_call_count` | Counter | `tool_name`, `status`, `approval_required` (bool) | Tool usage volume and the human-approval-gate hit rate from `13_SECURITY_ARCHITECTURE.md` §7 |
| `prompt_injection_flagged_total` | Counter | `source` (`web_fetch`/`mcp`/`rag_document`/`upload`) | Times the output-side injection filter (`13_SECURITY_ARCHITECTURE.md` §9.2) fired — a security-relevant operational metric, not just a security-doc concept |
| `sandbox_active_count` / `sandbox_lifetime_seconds` | Gauge / Histogram | — | Coding-agent sandbox utilization and lifecycle |
| `http_request_duration_seconds` | Histogram | `route`, `method`, `status_code` | Standard API latency (RED-method "duration") |
| `http_requests_total` | Counter | `route`, `method`, `status_code` | Standard API request/error rate (RED-method "rate"/"errors") |

### 2.2 Alerting priorities (initial set)

1. `provider_error_rate` sustained above threshold per provider — indicates an upstream outage or
   a broken adapter; should trigger fallback-provider logic (tested per `21_TESTING_STRATEGY.md`)
   before it needs to page a human.
2. `queue_age_oldest_seconds` exceeding an SLO (e.g., a job waiting > N minutes) — worker capacity
   or a stuck worker.
3. `cost_estimate_usd_total` rate-of-change anomaly per `org_id` — catches a runaway agent loop or
   an abuse pattern before the bill arrives.
4. `worker_health` any instance reporting 0 for longer than its restart window.

## 3. Distributed tracing

### 3.1 Why tracing matters more here than in a typical CRUD app

A single user-facing chat turn or agent run fans out into many operations: the API request, one or
more LLM calls, zero or more tool calls (some of which are network calls to MCP servers or
external APIs), a queued job handed to a worker, and possibly a coding-agent sandbox execution.
Without tracing, correlating "why did this turn take 8 seconds and cost $0.40" across process
boundaries (API → queue → worker → provider) is reconstructed by hand from logs. A trace makes it
one view.

### 3.2 Instrumentation approach

- Use `@opentelemetry/sdk-node` with auto-instrumentation for HTTP, Express/Fastify, and the
  Postgres/Redis clients (covers the "free" spans: inbound HTTP, outbound HTTP, DB queries) plus
  **manual spans** for the agent-domain concepts below that no auto-instrumentation package knows
  about.
- Propagate trace context (W3C Trace Context `traceparent` header, OTel's default) across every
  process boundary: API → job queue → worker, and API/worker → any internal service call. When
  enqueueing a Cloud Tasks/queue job, serialize the current trace context into the job payload so
  the worker can continue the same trace rather than starting a disconnected one — this is the
  single most important wiring detail for making the queue hop traceable.
- Correlate trace/span IDs into every structured log line (`trace_id`, `span_id` fields) so a log
  line and a trace can be pivoted between in either direction.

### 3.3 What an "agent step" span must contain

Define a dedicated span per agent step (one LLM call + its immediate tool-call handling), nested
under a parent span for the whole agent run (`task_id`-scoped) which is itself nested under the
originating request span. Concretely:

**Parent span: `agent.run`**
- `task_id`, `user_id`, `org_id`
- `agent.run.outcome` (set on completion: success/failed/max_steps_exceeded/human_rejected)
- `agent.run.step_count` (set on completion)
- `agent.run.total_cost_estimate_usd` (set on completion)

**Per-step span: `agent.step`** (one per LLM turn in the loop)
- `agent.step.index` (0-based step number within the run)
- `gen_ai.request.model`, `gen_ai.system` (provider name — following OTel GenAI semantic
  conventions so this interoperates with any OTel-native tooling)
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
- `gen_ai.response.finish_reasons`
- `cost_estimate_usd` (this step's contribution)
- `latency_ms` (redundant with span duration but useful as an explicit attribute for
  metric-from-span pipelines)
- Child span **`gen_ai.chat` / provider call**: the actual outbound request to the model provider,
  with `provider`, `model`, HTTP status, retry count if retried, and — critically — which fallback
  provider (if any) was used, so a trace shows the full retry/fallback path rather than just the
  call that eventually succeeded.
- Child span(s) **`tool.call`** per tool invocation triggered by this step:
  - `tool_name`, `tool.permission_tier` (Tier 0/1/2 per the security doc), `approval_required`
    (bool), `approved_by` (if a human approval gate fired)
  - `mcp_server_id` if routed through MCP
  - `tool.input_summary` / `tool.output_summary` (bounded-length, redacted summaries — not full
    payloads, for the same reasons logs don't carry full content by default)
  - For coding-agent tool calls specifically: `sandbox_id`, `command` (the literal command run,
    since this is the platform's key audit surface per the security doc), `exit_code`,
    `files_changed_count`
  - `untrusted_content_in_context` (bool) — whether this tool call's motivating context included
    untrusted content (web fetch/MCP/RAG output), directly supporting the prompt-injection
    provenance tracking described in `13_SECURITY_ARCHITECTURE.md` §9.2, and making it possible to
    audit, after the fact, every tool call that was influenced by untrusted content.

This structure means a single trace view answers "what did the agent do, with what data, at what
cost, and was any of it influenced by untrusted content" for a full run — the primary debugging and
security-audit tool for the platform, not just a performance tool.

### 3.4 Sampling

Trace 100% of agent runs and tool calls initially (cost/volume is bounded by usage, not by a
high-QPS public endpoint), and revisit head-based or tail-based sampling only if trace volume
becomes a real cost/storage concern. Do not sample below 100% for runs that ended in an error,
a human-rejected action, or a flagged prompt-injection attempt — those are exactly the traces most
needed for debugging and security review, so keep an error-based override even after introducing
sampling later.

## 4. Backends: Google Cloud vs. self-hosted local dev

| Signal | Local dev (no GCP project yet) | Production (once on GCP, per `18_CLOUD_ARCHITECTURE.md`) |
|---|---|---|
| Logs | JSON to stdout, optionally shipped to **Loki** via the OTel Collector or Promtail | **Cloud Logging** (Cloud Run ships stdout/stderr automatically; structured JSON is auto-parsed into queryable fields) |
| Metrics | **Prometheus** (scraped from an OTel Collector's Prometheus exporter or the app's `/metrics` endpoint) | **Cloud Monitoring**, fed via the OTel Collector's Google Cloud Monitoring exporter |
| Traces | **Tempo** | **Cloud Trace**, fed via the OTel Collector's Google Cloud Trace exporter |
| Visualization | **Grafana** (dashboards over Loki + Prometheus + Tempo — the "LGTM" stack) | Cloud Console (Trace Explorer, Logs Explorer, Monitoring dashboards), or Grafana Cloud/self-hosted Grafana pointed at Cloud Monitoring/Trace as data sources if a unified view across environments is wanted |

**Implementation detail that keeps both paths free of app-code changes**: the application always
emits OTLP (OpenTelemetry Protocol) to a local **OpenTelemetry Collector** sidecar/service. Only
the Collector's exporter configuration changes between environments — local dev points the
Collector at Tempo/Loki/Prometheus (run via Docker Compose, see below), while GCP deployment points
the same Collector config at the Google Cloud exporters. The application itself only ever talks
OTLP to `localhost:4317` (or the Collector's service address in a container); it never has
environment-specific tracing/logging code.

**Local dev stack**: a `docker-compose.yml` running an OTel Collector + Tempo + Loki + Prometheus +
Grafana (the standard local LGTM pattern) is the recommended setup for full-fidelity local
observability. This depends on Docker being installed — per `18_CLOUD_ARCHITECTURE.md` §6, Docker
Desktop is not currently installed on the dev machine, so until it is, local development should
fall back to plain structured console logging (readable via `pino-pretty` in dev mode) without
full trace/metrics visualization; the OTel instrumentation code itself has no Docker dependency
(only the optional local visualization backend does), so tracing/metrics can still be wired up in
application code immediately, and become visible in Grafana as soon as Docker Desktop is
installed and the compose stack is started. Treat "install Docker Desktop" as a near-term setup
task, not a blocking dependency for writing the instrumentation itself.

**Migration note on the Cloud Trace exporter**: Google's original `@google-cloud/
opentelemetry-cloud-trace-exporter` package is being deprecated (archival planned after October
30, 2026); new work should target the community-maintained OTLP exporter path through the
Collector rather than the direct legacy exporter package, which also happens to be the same path
that keeps local vs. GCP configuration symmetric as described above.

## 5. Correlating the three signals

Every one of `request_id`, `task_id`, `job_id`, `trace_id`, and `span_id` should be:

1. Generated/propagated consistently across process boundaries (HTTP headers for
   request/trace context; embedded in job payloads for queue hops).
2. Present on every log line for that scope.
3. Present as span attributes on the corresponding trace span.
4. Usable as a metric label only where cardinality is safe (`request_id`/`task_id`/`trace_id` are
   far too high-cardinality for metric labels — they belong on logs and traces only; metrics use
   the bounded-cardinality labels in §2, like `provider`, `model`, `status`, `org_id`).

This gives a consistent workflow for debugging: start from a metric anomaly (e.g., a spike in
`provider_error_rate`) → find the affected traces in that time window filtered by the same labels →
open one bad trace → pivot to its correlated logs by `trace_id` for full detail, including the
literal request/response content if debug logging was enabled for that run.

## 6. Open items to revisit

- Decide the concrete OTel Collector deployment shape once GCP provisioning begins (sidecar per
  Cloud Run instance vs. a shared Collector service) — Cloud Run's request-based model makes a
  per-instance sidecar the more common pattern; this is an implementation detail to confirm against
  Cloud Run's current OTel Collector deployment guidance at that time, since agent/runtime guidance
  in this fast-moving area is a common area for defaults to shift between now and provisioning.
- Define concrete alert thresholds (numbers, not just "sustained above threshold") once real
  traffic/cost baselines exist — this document defines *what* to alert on, not the specific
  numeric SLOs, which are premature before production data exists.
