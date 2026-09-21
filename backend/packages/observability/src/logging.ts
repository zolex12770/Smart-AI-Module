/**
 * Structured-logging conventions per docs/20_OBSERVABILITY.md §1 — field names, redaction,
 * and cross-process correlation helpers shared by backend's routes, job workers, and the
 * agent-core/model-router call sites that log provider calls.
 */

/**
 * Pino `redact` paths (docs/20 §1.4: never log raw secrets, defense-in-depth even though no
 * current call site logs one directly).
 *
 * A real, found-by-testing correction (docs/26_DECISIONS.md ADR-035): a wildcard path like
 * `*.apiKey` does **not** mean "match `apiKey` at any depth" — `fast-redact` (Pino's redaction
 * engine) treats `*` as "any key at exactly this one depth", so `*.apiKey` only matches a
 * *nested* field (`{ x: { apiKey } }`) and silently does nothing for a top-level one
 * (`{ apiKey }`), which a real test caught passing straight through unredacted. There is no
 * fast-redact syntax for "this key at any depth" — each secret-shaped field name is therefore
 * listed explicitly at both the top level and one level of nesting (the only depths any real
 * call site in this codebase actually produces: flat log objects, or Fastify's own
 * `req.headers.*` shape).
 */
/**
 * Every name that looks like a secret, at both depths — docs/26_DECISIONS.md ADR-155.
 *
 * The list below was maintained by hand and had drifted behind `config.ts`: seven live
 * secret-shaped fields (`LLM_API_KEY`, `VIDEO_API_TOKEN`, `IMAGE_API_KEY`, `SPEECH_API_KEY`,
 * `EMBEDDING_API_KEY`, `BOOTSTRAP_ADMIN_PASSWORD`, `DATABASE_URL`) were not in it, and its test
 * asserted the names it already had, so a config field added later could never be caught. The
 * composition root passes its own schema's secret-shaped keys through `createLogger` now; this
 * turns a list of names into the paths pino needs.
 */
export function redactPathsFor(names: readonly string[]): string[] {
  return names.flatMap((name) => [name, `*.${name}`]);
}

export const LOG_REDACT_PATHS = [
  "apiKey",
  "*.apiKey",
  "api_key",
  "*.api_key",
  "password",
  "*.password",
  "authorization",
  "*.authorization",
  "req.headers.authorization",
  "ANTHROPIC_API_KEY",
  "*.ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "*.OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "*.GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "*.GEMINI_API_KEY",
  // A session cookie is a bearer credential exactly like a key is.
  "cookie",
  "*.cookie",
  "req.headers.cookie",
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
