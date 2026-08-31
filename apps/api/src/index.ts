import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentEngine } from "@ai-platform/agent-core";
import {
  createDb,
  runMigrations,
  SqliteConversationRepository,
  SqliteMessageRepository,
  SqliteTaskNodeRepository,
  SqliteTaskRepository,
  SqliteTaskTransitionRepository,
} from "@ai-platform/database";
import { AnthropicProvider } from "@ai-platform/llm-anthropic";
import { GoogleProvider } from "@ai-platform/llm-google";
import { MockLLMProvider } from "@ai-platform/llm-mock";
import { OpenAIProvider } from "@ai-platform/llm-openai";
import { connectMcpServer } from "@ai-platform/mcp";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import { createCodingTools, createFilesystemTools, createTerminalTools, ToolRegistry } from "@ai-platform/tools";
import { loadConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { buildServer } from "./server.js";

async function main() {
  const config = loadConfig();

  const db = createDb(config.DATABASE_FILE);
  await runMigrations(db);

  const registry = new ModelRegistry();

  // Real adapters register only when their API key is present (docs/26_DECISIONS.md
  // ADR-010); each has been fixture-tested, not live-tested (ADR-023) — the mock
  // registers unconditionally as both the zero-credential default and a safety net.
  if (config.ANTHROPIC_API_KEY) {
    registry.register(new AnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY }));
  }
  if (config.OPENAI_API_KEY) {
    registry.register(
      new OpenAIProvider({
        apiKey: config.OPENAI_API_KEY,
        organizationId: config.OPENAI_ORG_ID,
        projectId: config.OPENAI_PROJECT_ID,
      })
    );
  }
  const googleApiKey = config.GOOGLE_API_KEY ?? config.GEMINI_API_KEY;
  if (googleApiKey) {
    registry.register(new GoogleProvider({ apiKey: googleApiKey }));
  }

  const hasRealProvider = Boolean(config.ANTHROPIC_API_KEY || config.OPENAI_API_KEY || googleApiKey);
  registry.register(new MockLLMProvider(), { asDefault: !hasRealProvider });

  const sandboxRoot = resolve(config.SANDBOX_ROOT);
  mkdirSync(sandboxRoot, { recursive: true });
  const toolRegistry = new ToolRegistry();
  for (const { definition, handler } of [
    ...createFilesystemTools(sandboxRoot),
    ...createTerminalTools(sandboxRoot),
    ...createCodingTools(sandboxRoot),
  ]) {
    toolRegistry.register(definition, handler);
  }

  // Real external MCP server connection (docs/10_TOOL_AND_MCP_ARCHITECTURE.md §2/§3.2) —
  // the official reference filesystem server, scoped to the same sandbox root as our
  // native fs tools. Best-effort: if it fails to start, log and continue rather than
  // block the whole platform on one optional integration.
  try {
    const serverEntry = fileURLToPath(
      import.meta.resolve("@modelcontextprotocol/server-filesystem/dist/index.js")
    );
    const mcp = await connectMcpServer(toolRegistry, {
      id: "reference-filesystem",
      command: process.execPath,
      args: [serverEntry, sandboxRoot],
      cwd: sandboxRoot,
    });
    console.log(
      `Connected MCP server "${mcp.serverId}" — discovered ${mcp.toolIds.length} tool(s), ` +
        `registered disabled pending explicit enable: ${mcp.toolIds.join(", ")}`
    );
  } catch (err) {
    console.warn("MCP reference server connection failed (continuing without it):", err);
  }

  const tasks = new SqliteTaskRepository(db);
  const taskNodes = new SqliteTaskNodeRepository(db);
  const taskTransitions = new SqliteTaskTransitionRepository(db);
  const modelRouter = new ModelRouter(registry);

  const engine = new AgentEngine({
    taskRepo: tasks,
    nodeRepo: taskNodes,
    transitionRepo: taskTransitions,
    toolRegistry,
    modelRouter,
  });

  // Crash recovery (docs/11_AGENT_LOOP.md §4.2) — reconcile any task/node left in a
  // non-terminal or in-flight state by a previous process before serving new requests.
  await engine.resumeAll();

  const ctx: AppContext = {
    router: modelRouter,
    conversations: new SqliteConversationRepository(db),
    messages: new SqliteMessageRepository(db),
    corsOrigin: config.CORS_ORIGIN,
    engine,
    tasks,
    taskNodes,
    toolRegistry,
  };

  const app = await buildServer(config, ctx);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
