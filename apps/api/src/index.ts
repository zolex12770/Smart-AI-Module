import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentEngine } from "@ai-platform/agent-core";
import {
  createDb,
  createPostgresDb,
  runMigrations,
  runPostgresMigrations,
  type DrizzleDb,
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
import { fromPglite, JobQueue, type JobQueueOptions } from "@ai-platform/jobs";
import { AnthropicProvider } from "@ai-platform/llm-anthropic";
import { GoogleProvider } from "@ai-platform/llm-google";
import { MockLLMProvider } from "@ai-platform/llm-mock";
import { OpenAIProvider } from "@ai-platform/llm-openai";
import { connectMcpServer } from "@ai-platform/mcp";
import { LocalAssetStore, processImageGeneration, processVideoRender, processVideoScene } from "@ai-platform/media";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import { createLogger, initTracing, withSpan, type Logger } from "@ai-platform/observability";
import { createRagTools, processDocumentIngestion } from "@ai-platform/rag";
import { createCodingTools, createFilesystemTools, createTerminalTools, ToolRegistry } from "@ai-platform/tools";
import { MockVideoProvider } from "@ai-platform/video-mock";
import { loadConfig, type AppConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Connects to whichever Postgres backend `config` selects (docs/26_DECISIONS.md ADR-037):
 * the local embedded PGlite default, or a real standalone Postgres (e.g. Cloud SQL, once
 * Phase 14's infrastructure is actually deployed to) when DATABASE_URL is set. Everything
 * past this point in `main()` only ever touches the returned `db` through the general,
 * dialect-agnostic `DrizzleDb` type every repository already accepts — the two backends'
 * driver-specific connection-teardown and job-queue-wiring differences are captured here,
 * once, rather than scattered through the rest of boot.
 */
async function connectDatabase(
  config: AppConfig
): Promise<{ db: DrizzleDb; jobQueueOptions: JobQueueOptions; close: () => Promise<void> }> {
  if (config.DATABASE_URL) {
    const db = await createPostgresDb(config.DATABASE_URL);
    await runPostgresMigrations(db);
    return { db, jobQueueOptions: { connectionString: config.DATABASE_URL }, close: () => db.$client.end() };
  }
  const db = await createDb(config.DATABASE_DIR);
  await runMigrations(db);
  return {
    db,
    jobQueueOptions: { db: fromPglite(db.$client), backend: "pglite" },
    close: () => db.$client.close(),
  };
}

async function main() {
  const config = loadConfig();

  // docs/20_OBSERVABILITY.md — must happen before anything else logs or traces, so no
  // early-boot line is missed and the tracer provider is registered before any span-creating
  // code path (job workers registered below, request handlers once the server starts) runs.
  initTracing("api");
  const logger = createLogger("api");

  const { db, jobQueueOptions, close: closeDb } = await connectDatabase(config);

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
  // ADR-012/ADR-027/ADR-037) — pg-boss, either against the local PGlite instance via its
  // native `fromPglite` adapter, or (once DATABASE_URL is set) its own default connection
  // pool built from that same connection string; connectDatabase above decides which. The
  // worker still runs in-process here rather than in a separate apps/worker process even
  // against a real standalone Postgres — that split is a real, currently-unbuilt follow-up
  // (see ADR-037's deployment runbook), not something this env-var switch does by itself.
  const jobQueue = new JobQueue(jobQueueOptions);
  await jobQueue.start();
  await jobQueue.ensureQueue("document.ingest", { retryLimit: 2, expireInSeconds: 120 });
  await jobQueue.registerWorker<{ documentId: string; requestId?: string }>(
    "document.ingest",
    async ({ documentId, requestId }) =>
      runJob(logger, { queue: "document.ingest", jobId: documentId, requestId }, async () => {
        const document = await documents.get(documentId);
        if (!document) throw new Error(`document.ingest job referenced unknown document "${documentId}".`);
        await processDocumentIngestion({ documentRepo: documents, chunkRepo: documentChunks, embeddings, sandboxRoot }, document);
      })
  );

  // Image generation (docs/05_IMAGE_GENERATION_RESEARCH.md) — mock-only until real
  // credentials exist (docs/26_DECISIONS.md ADR-009), but genuinely runs through the same
  // async job system a real (slow) provider would need, per docs/07 §1.6's "mock-provider
  // parity" directive — never resolved inline.
  const assets = new PgAssetRepository(db);
  const assetStore = new LocalAssetStore(assetsRoot, assets);
  const imageGenerations = new PgImageGenerationRepository(db);
  const imageProvider = new MockImageProvider();
  await jobQueue.ensureQueue("image.generate", { retryLimit: 1, expireInSeconds: 60 });
  await jobQueue.registerWorker<{ generationId: string; requestId?: string }>(
    "image.generate",
    async ({ generationId, requestId }) =>
      runJob(logger, { queue: "image.generate", jobId: generationId, requestId }, async () => {
        await processImageGeneration({ generationRepo: imageGenerations, assetStore, provider: imageProvider }, generationId);
        const generation = await imageGenerations.get(generationId);
        logger.info(
          {
            request_id: requestId,
            job_id: generationId,
            provider: generation?.providerName ?? imageProvider.name,
            status: generation?.status === "succeeded" ? "success" : "error",
          },
          "provider call completed"
        );
      })
  );

  // Long-form video pipeline (docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md Part 2,
  // docs/26_DECISIONS.md ADR-030) — mock-only per the same ADR-009 policy as images.
  // `video.generate_scene` runs with bounded concurrency (docs/07 §1.6: "not all 150
  // scenes fire at once"); `video.render` shells out to a system ffmpeg if one is present.
  const videoProjects = new PgVideoProjectRepository(db);
  const videoScenes = new PgVideoSceneRepository(db);
  const videoProvider = new MockVideoProvider();
  await jobQueue.ensureQueue("video.generate_scene", { retryLimit: 1, expireInSeconds: 60 });
  await jobQueue.registerWorker<{ sceneId: string; requestId?: string }>(
    "video.generate_scene",
    async ({ sceneId, requestId }) =>
      runJob(logger, { queue: "video.generate_scene", jobId: sceneId, requestId }, async () => {
        await processVideoScene(
          { projectRepo: videoProjects, sceneRepo: videoScenes, jobQueue, assetStore, provider: videoProvider },
          sceneId,
          requestId
        );
      }),
    { localConcurrency: 3 }
  );
  await jobQueue.ensureQueue("video.render", { retryLimit: 1, expireInSeconds: 300 });
  await jobQueue.registerWorker<{ projectId: string; requestId?: string }>(
    "video.render",
    async ({ projectId, requestId }) =>
      runJob(logger, { queue: "video.render", jobId: projectId, requestId }, async () => {
        await processVideoRender(
          { projectRepo: videoProjects, sceneRepo: videoScenes, assetRepo: assets, assetStore, ffmpegPath: config.FFMPEG_PATH },
          projectId
        );
      })
  );

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

  const app = await buildServer(config, ctx, logger);

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
      await closeDb();
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

/**
 * docs/20_OBSERVABILITY.md §3.3 (`job.process` span) + §1.2 (structured job log fields) —
 * shared by every job worker registered above so a job's `request_id` (propagated from the
 * enqueueing HTTP request — see routes/v1/images.ts, videos.ts, rag.ts) is threaded through
 * both the trace and every log line the job produces, closing the "API → worker →
 * provider-call" correlation the roadmap's Phase 12 exit criterion asks for.
 */
async function runJob<T>(
  jobLogger: Logger,
  params: { queue: string; jobId: string; requestId?: string },
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  return withSpan(
    "job.process",
    { "job.queue": params.queue, job_id: params.jobId, request_id: params.requestId ?? "" },
    async () => {
      try {
        const result = await fn();
        jobLogger.info(
          { request_id: params.requestId, job_id: params.jobId, queue: params.queue, latency_ms: Date.now() - startedAt, status: "success" },
          "job completed"
        );
        return result;
      } catch (err) {
        jobLogger.error(
          { request_id: params.requestId, job_id: params.jobId, queue: params.queue, err, latency_ms: Date.now() - startedAt, status: "error" },
          "job failed"
        );
        throw err;
      }
    }
  );
}
