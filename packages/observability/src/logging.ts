/**
 * Structured-logging conventions per docs/20_OBSERVABILITY.md §1 — field names, redaction,
 * and cross-process correlation helpers shared by apps/api's routes, job workers, and the
 * agent-core/model-router call sites that log provider calls.
 */

/** Pino `redact` paths (docs/20 §1.4: never log raw secrets, defense-in-depth even though no
 * current call site logs one directly). Matches by field name wherever it appears in a log
 * object, not just at these exact paths — Pino's redact supports wildcard paths for this. */
export const LOG_REDACT_PATHS = [
  "*.apiKey",
  "*.api_key",
  "*.password",
  "*.authorization",
  "req.headers.authorization",
  "*.ANTHROPIC_API_KEY",
  "*.OPENAI_API_KEY",
  "*.GOOGLE_API_KEY",
  "*.GEMINI_API_KEY",
];

/**
 * The canonical cross-process correlation id (docs/20 §1.2 `request_id`). Deliberately a
 * distinct field name from Fastify's own built-in `reqId` (its automatic per-request/response
 * log lines use that name and there's no clean way to rename it without replacing Fastify's
 * child-logger factory) — this is the id explicitly threaded through job payloads and worker
 * logs by application code, everywhere this package's helpers are used.
 */
export interface CorrelationFields {
  request_id?: string;
  task_id?: string;
  job_id?: string;
}

/** Fields for a provider/model call log line (docs/20 §1.2). */
export interface ProviderCallFields extends CorrelationFields {
  provider: string;
  model: string;
  latency_ms: number;
  tokens_input?: number;
  tokens_output?: number;
  status: "success" | "error";
}

/** Fields for a tool-call log line (docs/20 §1.2 / §3.3). */
export interface ToolCallFields extends CorrelationFields {
  tool_name: string;
  mcp_server_id?: string;
  status: "success" | "error";
  latency_ms: number;
}
