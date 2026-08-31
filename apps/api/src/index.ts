import { createDb, runMigrations, SqliteConversationRepository, SqliteMessageRepository } from "@ai-platform/database";
import { MockLLMProvider } from "@ai-platform/llm-mock";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import { loadConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { buildServer } from "./server.js";

async function main() {
  const config = loadConfig();

  const db = createDb(config.DATABASE_FILE);
  await runMigrations(db);

  const registry = new ModelRegistry();
  // Phase 2 registers real adapters here when their API key is present
  // (docs/26_DECISIONS.md ADR-010); Phase 1 always has the mock as a safety net.
  registry.register(new MockLLMProvider(), { asDefault: true });

  const ctx: AppContext = {
    router: new ModelRouter(registry),
    conversations: new SqliteConversationRepository(db),
    messages: new SqliteMessageRepository(db),
    corsOrigin: config.CORS_ORIGIN,
  };

  const app = await buildServer(config, ctx);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
