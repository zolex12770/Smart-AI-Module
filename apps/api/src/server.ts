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

export async function buildServer(config: AppConfig, ctx: AppContext) {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: config.CORS_ORIGIN });

  registerErrorHandler(app);
  registerHealthRoute(app);
  registerChatRoute(app, ctx);
  registerAgentRoutes(app, ctx);
  registerRagRoutes(app, ctx);
  registerImageRoutes(app, ctx);

  return app;
}
