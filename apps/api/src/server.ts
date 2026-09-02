import Fastify from "fastify";
import cors from "@fastify/cors";
import type { AppConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerAgentRoutes } from "./routes/v1/agent.js";
import { registerChatRoute } from "./routes/v1/chat.js";
import { registerImageRoutes } from "./routes/v1/images.js";
import { registerRagRoutes } from "./routes/v1/rag.js";
import { registerVideoRoutes } from "./routes/v1/videos.js";

export async function buildServer(config: AppConfig, ctx: AppContext) {
  const app = Fastify({ logger: true });

  // @fastify/cors defaults `methods` to "GET,HEAD,POST" only — DELETE (used by
  // /api/v1/memory/:id) and PUT/PATCH would otherwise fail preflight in any real browser,
  // a real bug found only by actual browser-driven UI testing (docs/25 Phase 10), never by
  // curl (which doesn't enforce CORS at all) or by unit/integration tests.
  await app.register(cors, { origin: config.CORS_ORIGIN, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] });

  registerErrorHandler(app);
  registerHealthRoute(app);
  registerChatRoute(app, ctx);
  registerAgentRoutes(app, ctx);
  registerRagRoutes(app, ctx);
  registerImageRoutes(app, ctx);
  registerVideoRoutes(app, ctx);

  return app;
}
