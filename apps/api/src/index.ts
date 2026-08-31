import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentEngine } from "@ai-platform/agent-core";
import {
  createDb,
  runMigrations,
  PgConversationRepository,
  PgMessageRepository,
  PgTaskNodeRepository,
  PgTaskRepository,
  PgTaskTransitionRepository,
  PgDocumentRepository,
  PgDocumentChunkRepository,
  PgMemoryItemRepository,
  PgAssetRepository,
  PgImageGenerationRepository,
  PgVideoProjectRepository,
  PgVideoSceneRepository,
} from "@ai-platform/database";
import { HashEmbeddingProvider } from "@ai-platform/embeddings";
import { MockImageProvider } from "@ai-platform/image-mock";
import { fromPglite, JobQueue } from "@ai-platform/jobs";
import { AnthropicProvider } from "@ai-platform/llm-anthropic";
import { GoogleProvider } from "@ai-platform/llm-google";
import { MockLLMProvider } from "@ai-platform/llm-mock";
import { OpenAIProvider } from "@ai-platform/llm-openai";
import { connectMcpServer } from "@ai-platform/mcp";
import { LocalAssetStore, processImageGeneration, processVideoRender, processVideoScene } from "@ai-platform/media";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import { createRagTools, processDocumentIngestion } from "@ai-platform/rag";
import { createCodingTools, createFilesystemTools, createTerminalTools, ToolRegistry } from "@ai-platform/tools";
import { MockVideoProvider } from "@ai-platform/video-mock";
import { loadConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { buildServer } from "./server.js";

async function main() {
  const config = loadConfig();

  const db = await createDb(config.DATABASE_DIR);
  await runMigrations(db);

  const registry = new ModelRegistry();

  // Real adapters register only when their API key is present (docs/26_DECISIONS.md
  // ADR-010); each has been fixture-tested and confirmed to reach its live endpoint
  // correctly, not full-success-tested (ADR-023/024) — the mock registers
  // unconditionally as both the zero-credential default and a safety net.
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
  const assetsRoot = resolve(config.ASSETS_ROOT);
  mkdirSync(assetsRoot, { recursive: true });
  const toolRegistry = new ToolRegistry();

  const documents = new PgDocumentRepository(db);
  const documentChunks = new PgDocumentChunkRepository(db);
  const embeddings = new HashEmbeddingProvider();

  for (const { definition, handler } of [
    ...createFilesystemTools(sandboxRoot),
    ...createTerminalTools(sandboxRoot),
    ...createCodingTools(sandboxRoot),
    ...createRagTools({ chunkRepo: documentChunks, embeddings }),
  ]) {
    toolRegistry.register(definition, handler);
  }

  // Real async job queue (docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md, docs/26_DECISIONS.md
  // ADR-012/ADR-027) — pg-boss against the same PGlite instance via its native `fromPglite`
  // adapter. The worker runs in-process here rather than in a separate apps/worker process
  // because PGlite is single-connection/embedded (ADR-025) — a second OS process cannot
  // open the same database. See ADR-027 for the full reasoning and what changes once a
  // real standalone Postgres exists.
  const jobQueue = new JobQueue({ db: fromPglite(db.$client), backend: "pglite" });
  await jobQueue.start();
  await jobQueue.ensureQueue("document.ingest", { retryLimit: 2, expireInSeconds: 120 });
  await jobQueue.registerWorker<{ documentId: string }>("document.ingest", async ({ documentId }) => {
    const document = await documents.get(documentId);
    if (!document) throw new Error(`document.ingest job referenced unknown document "${documentId}".`);
    await processDocumentIngestion({ documentRepo: documents, chunkRepo: documentChunks, embeddings, sandboxRoot }, document);
  });

  // Image generation (docs/05_IMAGE_GENERATION_RESEARCH.md) — mock-only until real
  // credentials exist (docs/26_DECISIONS.md ADR-009), but genuinely runs through the same
  // async job system a real (slow) provider would need, per docs/07 §1.6's "mock-provider
  // parity" directive — never resolved inline.
  const assets = new PgAssetRepository(db);
  const assetStore = new LocalAssetStore(assetsRoot, assets);
  const imageGenerations = new PgImageGenerationRepository(db);
  const imageProvider = new MockImageProvider();
  await jobQueue.ensureQueue("image.generate", { retryLimit: 1, expireInSeconds: 60 });
  await jobQueue.registerWorker<{ generationId: string }>("image.generate", async ({ generationId }) => {
    await processImageGeneration({ generationRepo: imageGenerations, assetStore, provider: imageProvider }, generationId);
  });

  // Long-form video pipeline (docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md Part 2,
  // docs/26_DECISIONS.md ADR-030) — mock-only per the same ADR-009 policy as images.
  // `video.generate_scene` runs with bounded concurrency (docs/07 §1.6: "not all 150
  // scenes fire at once"); `video.render` shells out to a system ffmpeg if one is present.
  const videoProjects = new PgVideoProjectRepository(db);
  const videoScenes = new PgVideoSceneRepository(db);
  const videoProvider = new MockVideoProvider();
  await jobQueue.ensureQueue("video.generate_scene", { retryLimit: 1, expireInSeconds: 60 });
  await jobQueue.registerWorker<{ sceneId: string }>(
    "video.generate_scene",
    async ({ sceneId }) => {
      await processVideoScene(
        { projectRepo: videoProjects, sceneRepo: videoScenes, jobQueue, assetStore, provider: videoProvider },
        sceneId
      );
    },
    { localConcurrency: 3 }
  );
  await jobQueue.ensureQueue("video.render", { retryLimit: 1, expireInSeconds: 300 });
  await jobQueue.registerWorker<{ projectId: string }>("video.render", async ({ projectId }) => {
    await processVideoRender(
      { projectRepo: videoProjects, sceneRepo: videoScenes, assetRepo: assets, assetStore, ffmpegPath: config.FFMPEG_PATH },
      projectId
    );
  });

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

  const tasks = new PgTaskRepository(db);
  const taskNodes = new PgTaskNodeRepository(db);
  const taskTransitions = new PgTaskTransitionRepository(db);
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
    conversations: new PgConversationRepository(db),
    messages: new PgMessageRepository(db),
    corsOrigin: config.CORS_ORIGIN,
    engine,
    tasks,
    taskNodes,
    toolRegistry,
    documents,
    documentChunks,
    memoryItems: new PgMemoryItemRepository(db),
    embeddings,
    sandboxRoot,
    jobQueue,
    assets,
    assetsRoot,
    imageGenerations,
    videoProjects,
    videoScenes,
  };

  const app = await buildServer(config, ctx);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  // Graceful shutdown — real, not decorative. PGlite (ADR-025) is a single embedded
  // engine, not a client to a separately-managed server process: an ungraceful exit
  // (e.g. a forceful `taskkill`/SIGKILL) can leave its on-disk state corrupted in a way
  // that doesn't surface until a later operation touches the affected structures —
  // discovered directly during this phase's own testing (PROJECT_STATUS.md), where a
  // stray abandoned process from an earlier crash silently damaged the dev database and
  // it only failed loudly once a new migration ran, well after the actual damage. A
  // normal shutdown signal (SIGINT/SIGTERM, e.g. a plain `taskkill` without `/F`, or
  // Ctrl+C) now closes the queue and the database cleanly instead of leaving that risk.
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    try {
      await app.close();
      await jobQueue.stop();
      await db.$client.close();
    } catch (err) {
      console.error("Error during graceful shutdown:", err);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
