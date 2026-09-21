import pino, { type Logger } from "pino";
import { LOG_REDACT_PATHS, redactPathsFor } from "./logging.js";
import { currentTraceContext } from "./tracing.js";

/**
 * One shared, structured Pino logger for the whole `backend` process (docs/20 §1.1) — used
 * both as Fastify's own `loggerInstance` (so every HTTP request/response log is structured
 * JSON with Fastify's built-in `reqId`) and directly by job workers (which run outside any
 * HTTP request and have no Fastify request object to log through). Sharing one instance
 * keeps output format identical across both, and keeps redaction configured in exactly one
 * place rather than duplicated between a Fastify `logger` option and a separate worker logger.
 */
export function createLogger(
  name: string,
  destination?: NodeJS.WritableStream,
  /**
   * Extra field names to redact, at the top level and one level down — ADR-155.
   *
   * The composition root derives these from its own config schema, so a secret-shaped variable
   * added to `config.ts` is redacted without anyone remembering to edit a list in this package.
   */
  extraRedactNames: readonly string[] = []
): Logger {
  const options = {
    name,
    level: process.env.LOG_LEVEL ?? "info",
    // `Set` because pino throws on a duplicate path, and a derived list can overlap the base.
    redact: {
      paths: [...new Set([...LOG_REDACT_PATHS, ...redactPathsFor(extraRedactNames)])],
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime, // docs/20 §1.2: ISO 8601, UTC
    /**
     * Every line carries the span it was written inside — docs/26_DECISIONS.md ADR-155.
     *
     * `currentTraceContext` existed with no production caller at all: a grep returned its own
     * definition and two uses inside a test. So docs/20's `trace_id` correlation was a field
     * name that appeared in no log line anywhere, and an operator holding a trace had no way to
     * find the logs for it — which is the entire point of emitting both.
     *
     * A `mixin` rather than a child-logger binding, because it covers the job workers and the
     * agent engine too: those run outside any request and have no Fastify logger to inherit
     * from, and the active span is on the async context either way.
     */
    mixin: () => currentTraceContext() ?? {},
  };
  // `destination` exists so tests can capture real log output (see logger.test.ts) — Pino
  // writes to stdout by default when omitted, which is what every real call site wants.
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
