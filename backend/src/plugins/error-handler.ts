import type { FastifyError, FastifyInstance } from "fastify";
import { AppError } from "@ai-platform/shared";

/**
 * Central error mapping — docs/15_API_ARCHITECTURE.md's response shape.
 * Handlers throw typed AppError subclasses; this is the only place that turns
 * them into an HTTP response, so the shape is consistent everywhere.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, request, reply) => {
    // The REQUEST's id, not a fresh one (ADR-098). This minted its own UUID, so the id handed
    // to the caller appeared in exactly one log line and could not be used to find the rest of
    // that request's trail. `genReqId` now makes `request.id` a UUID, so it is both unique
    // across replicas and the same value the logger already tags every line with.
    const requestId = request.id;

    if (err instanceof AppError) {
      request.log.warn({ err, requestId }, err.code);
      reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, requestId },
      });
      return;
    }

    // Fastify itself (or a plugin, e.g. its body parser) throws plain errors carrying
    // their own 4xx statusCode — those are the client's fault, not ours, and their
    // messages are safe, descriptive validation text (never a stack trace or secret).
    // Collapsing them to a generic 500 here was a real bug: a malformed request body
    // was reported to the client as "the server is broken" instead of "fix your request".
    const statusCode = "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      request.log.warn({ err, requestId }, "client error");
      reply.status(statusCode).send({
        error: { code: "code" in err ? String(err.code) : "BAD_REQUEST", message: err.message, requestId },
      });
      return;
    }

    // The database could not be reached — DL-23. That is an outage the caller may retry, not a
    // defect in the request or the code: 503, and nothing about the host in the message.
    if (isDatabaseUnreachable(err)) {
      request.log.error({ err, requestId }, "database unreachable");
      reply.status(503).header("Retry-After", "5").send({
        error: { code: "DATABASE_UNAVAILABLE", message: "The database is unavailable. Try again shortly.", requestId },
      });
      return;
    }

    request.log.error({ err, requestId }, "unhandled error");
    reply.status(500).send({
      error: { code: "INTERNAL_ERROR", message: "Something went wrong.", requestId },
    });
  });
}

/** Network-level failures to reach a server, and Postgres' "connection exception" class (08). */
const CONNECTION_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "EPIPE", "57P01", "57P03"]);

/**
 * Whether `err` is a query that failed because the database could not be reached.
 *
 * Only errors raised by a QUERY qualify (drizzle's `DrizzleQueryError` carries the `query`): an
 * unreachable model runtime fails with the same socket codes, and must not be reported as a
 * database outage. The socket error itself is somewhere down the `cause` chain.
 */
export function isDatabaseUnreachable(err: unknown): boolean {
  if (!err || typeof err !== "object" || !("query" in err)) return false;
  let current: unknown = err;
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && (CONNECTION_CODES.has(code) || code.startsWith("08"))) return true;
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && /Connection terminated|connect ECONNREFUSED|getaddrinfo (ENOTFOUND|EAI_AGAIN)/.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
