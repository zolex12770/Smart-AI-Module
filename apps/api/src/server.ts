import Fastify, { type FastifyBaseLogger } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Logger } from "@ai-platform/observability";
import type { AppConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerAgentRoutes } from "./routes/v1/agent.js";
import { registerChatRoute } from "./routes/v1/chat.js";
import { registerImageRoutes } from "./routes/v1/images.js";
import { registerRagRoutes } from "./routes/v1/rag.js";
import { registerUsageRoute } from "./routes/v1/usage.js";
import { registerVideoRoutes } from "./routes/v1/videos.js";

export async function buildServer(config: AppConfig, ctx: AppContext, logger: Logger) {
  // docs/20_OBSERVABILITY.md §1.1 — a pre-built, shared Pino instance (not `logger: true`,
  // which would make Fastify construct its own, separate from the one job workers use) so
  // every structured log line in this process — HTTP request/response and job/provider-call
  // alike — shares the same redaction config and JSON shape. The cast is real Fastify/Pino
  // TypeScript friction, not a runtime concern: a Pino `Logger` implements everything
  // `FastifyBaseLogger` requires (Fastify's own default logger *is* a Pino instance), the
  // types just don't structurally line up on an optional `msgPrefix` field.
  const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });

  // @fastify/cors defaults `methods` to "GET,HEAD,POST" only — DELETE (used by
  // /api/v1/memory/:id) and PUT/PATCH would otherwise fail preflight in any real browser,
  // a real bug found only by actual browser-driven UI testing (docs/25 Phase 10), never by
  // curl (which doesn't enforce CORS at all) or by unit/integration tests.
  await app.register(cors, { origin: config.CORS_ORIGIN, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] });

  // docs/13_SECURITY_ARCHITECTURE.md §4 "Layer 1 — edge/API rate limiting". A generous
  // global default (real requests aren't expensive; this exists to blunt a runaway client
  // or script, not to throttle normal use) plus stricter per-route overrides on the
  // genuinely expensive endpoints (image/video generation, agent task creation) — see
  // routes/v1/{images,videos,agent}.ts's `config.rateLimit`. In-memory store: correct for
  // this single-instance deployment (ADR-025/027's same reasoning for not adding Redis
  // before it's actually needed) — revisit if/when the API ever runs as more than one
  // instance behind a shared load balancer.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    // @fastify/rate-limit's default error has a `statusCode` but no `code` property, so the
    // central error handler's generic fallback ("BAD_REQUEST") reported an accurate status
    // with a misleading label — this keeps the response shape consistent with every other
    // endpoint's typed error codes.
    errorResponseBuilder: (_req, context) => ({
      statusCode: context.statusCode,
      code: "RATE_LIMITED",
      message: `Rate limit exceeded, retry in ${context.after}.`,
    }),
  });

  registerErrorHandler(app);
  registerHealthRoute(app);
  registerChatRoute(app, ctx);
  registerAgentRoutes(app, ctx);
  registerRagRoutes(app, ctx);
  registerImageRoutes(app, ctx);
  registerVideoRoutes(app, ctx);
  registerUsageRoute(app, ctx);

  return app;
}
