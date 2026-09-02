import pino, { type Logger } from "pino";
import { LOG_REDACT_PATHS } from "./logging.js";

/**
 * One shared, structured Pino logger for the whole `apps/api` process (docs/20 §1.1) — used
 * both as Fastify's own `loggerInstance` (so every HTTP request/response log is structured
 * JSON with Fastify's built-in `reqId`) and directly by job workers (which run outside any
 * HTTP request and have no Fastify request object to log through). Sharing one instance
 * keeps output format identical across both, and keeps redaction configured in exactly one
 * place rather than duplicated between a Fastify `logger` option and a separate worker logger.
 */
export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: LOG_REDACT_PATHS, censor: "[REDACTED]" },
    timestamp: pino.stdTimeFunctions.isoTime, // docs/20 §1.2: ISO 8601, UTC
  });
}

export type { Logger };
