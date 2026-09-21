import pino, { type Logger } from "pino";
import { LOG_REDACT_PATHS, redactPathsFor } from "./logging.js";

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
  };
  // `destination` exists so tests can capture real log output (see logger.test.ts) — Pino
  // writes to stdout by default when omitted, which is what every real call site wants.
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
