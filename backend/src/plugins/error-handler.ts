import type { FastifyError, FastifyInstance } from "fastify";
import { AppError } from "@ai-platform/shared";
import { randomUUID } from "node:crypto";

/**
 * Central error mapping — docs/15_API_ARCHITECTURE.md's response shape.
 * Handlers throw typed AppError subclasses; this is the only place that turns
 * them into an HTTP response, so the shape is consistent everywhere.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, request, reply) => {
    const requestId = randomUUID();

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

    request.log.error({ err, requestId }, "unhandled error");
    reply.status(500).send({
      error: { code: "INTERNAL_ERROR", message: "Something went wrong.", requestId },
    });
  });
}
