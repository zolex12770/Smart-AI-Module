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
  PgUsageRecordRepository,
} from "@ai-platform/database";
import { HashEmbeddingProvider } from "@ai-platform/embeddings";
import { MockImageProvider } from "@ai-platform/image-mock";
import { fromPglite, JobQueue, type JobQueueOptions } from "@ai-platform/jobs";
import { AnthropicProvider } from "@ai-platform/llm-anthropic";
import { GoogleProvider } from "@ai-platform/llm-google";
import { MockLLMProvider } from "@ai-platform/llm-mock";
import { OpenAIProvider } from "@ai-platform/llm-openai";
import { connectMcpServer } from "@ai-platform/mcp";
import {
  CloudStorageAssetStore,
  LocalAssetStore,
  processImageGeneration,
  processVideoRender,
  processVideoScene,
  type AssetStore,
} from "@ai-platform/media";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import { createLogger, initTracing, withSpan, type Logger } from "@ai-platform/observability";
import { QuotaManager } from "@ai-platform/quota";
import { createRagTools, processDocumentIngestion } from "@ai-platform/rag";
import { createCodingTools, createFilesystemTools, createTerminalTools, ToolRegistry } from "@ai-platform/tools";
import { MockVideoProvider } from "@ai-platform/video-mock";
import { v4 as uuid } from "uuid";
import { loadConfig, type AppConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { roleRuns } from "./role.js";
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
  const runs = roleRuns(config.ROLE);

  // docs/20_OBSERVABILITY.md — must happen before anything else logs or traces, so no
  // early-boot line is missed and the tracer provider is registered before any span-creating
  // code path (job workers registered below, request handlers once the server starts) runs.
  // The service name follows the role (ADR-039) so a worker pool's logs/spans are attributable
  // as "worker", not misfiled under "api", once the two run as separate Cloud Run units.
  const serviceName = config.ROLE === "worker" ? "worker" : "api";
  initTracing(serviceName);
  const logger = createLogger(serviceName);
  logger.info({ role: config.ROLE, http: runs.http, workers: runs.workers }, "booting");

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

  // FR-063 (docs/22_COST_AND_QUOTA_STRATEGY.md) — single-operator scope (ADR-008), so these
  // are global limits read straight from config; all optional (unset = no limit).
  const usage = new PgUsageRecordRepository(db);
  const quota = new QuotaManager(usage, {
    dailyTokenLimit: config.DAILY_TOKEN_LIMIT,
    monthlyTokenLimit: config.MONTHLY_TOKEN_LIMIT,
    dailyImageLimit: config.DAILY_IMAGE_LIMIT,
    monthlyVideoSecondsLimit: config.MONTHLY_VIDEO_SECONDS_LIMIT,
  });

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
  // pool built from that same connection string; connectDatabase above decides which.
  //
  // The queue is started and every queue is ensured in EVERY role (ADR-039): the api role
  // must still be able to enqueue (pg-boss requires `start()` before `send()`), and
  // `ensureQueue` is idempotent, so whichever process boots first creates the queues and
  // the other finds them already there. Only the worker *registrations* below are gated —
  // an `api`-role process never claims a job, a `worker`-role process never serves HTTP.
  const jobQueue = new JobQueue(jobQueueOptions);
  await jobQueue.start();
  await jobQueue.ensureQueue("document.ingest", { retryLimit: 2, expireInSeconds: 120 });
  await jobQueue.ensureQueue("image.generate", { retryLimit: 1, expireInSeconds: 60 });
  await jobQueue.ensureQueue("video.generate_scene", { retryLimit: 1, expireInSeconds: 60 });
  await jobQueue.ensureQueue("video.render", { retryLimit: 1, expireInSeconds: 300 });

  // Image generation (docs/05_IMAGE_GENERATION_RESEARCH.md) — mock-only until real
  // credentials exist (docs/26_DECISIONS.md ADR-009), but genuinely runs through the same
  // async job system a real (slow) provider would need, per docs/07 §1.6's "mock-provider
  // parity" directive — never resolved inline. Long-form video (docs/07 Part 2, ADR-030) —
  // mock-only per the same policy; `video.generate_scene` runs with bounded concurrency
  // (docs/07 §1.6: "not all 150 scenes fire at once"), `video.render` shells out to a system
  // ffmpeg if one is present. The repositories/providers are constructed in every role
  // (the api role's routes read them too); only the workers are role-gated.
  const assets = new PgAssetRepository(db);
  // ADR-040 — Cloud Storage when a bucket is configured, local disk otherwise. Same opt-in
  // shape as DATABASE_URL (ADR-037): unset means today's local-dev behavior, unchanged.
  const assetStore: AssetStore = config.ASSETS_BUCKET
    ? new CloudStorageAssetStore({ bucketName: config.ASSETS_BUCKET, apiEndpoint: config.GCS_API_ENDPOINT }, assets)
    : new LocalAssetStore(assetsRoot, assets);
  logger.info(
    config.ASSETS_BUCKET
      ? { assetStore: "gcs", bucket: config.ASSETS_BUCKET, apiEndpoint: config.GCS_API_ENDPOINT ?? "https://storage.googleapis.com" }
      : { assetStore: "local", assetsRoot },
    "asset store selected"
  );
  const imageGenerations = new PgImageGenerationRepository(db);
  const imageProvider = new MockImageProvider();
  const videoProjects = new PgVideoProjectRepository(db);
  const videoScenes = new PgVideoSceneRepository(db);
  const videoProvider = new MockVideoProvider();

  if (runs.workers) {
    await jobQueue.registerWorker<{ documentId: string; requestId?: string }>(
      "document.ingest",
      async ({ documentId, requestId }) =>
        runJob(logger, { queue: "document.ingest", jobId: documentId, requestId }, async () => {
          const document = await documents.get(documentId);
          if (!document) throw new Error(`document.ingest job referenced unknown document "${documentId}".`);
          await processDocumentIngestion({ documentRepo: documents, chunkRepo: documentChunks, embeddings, sandboxRoot }, document);
        })
    );

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
          // FR-061/FR-063 — recorded only on real success; a failed generation never happened,
          // so it shouldn't consume the daily image quota. estimatedCostUsd is null (docs/22:
          // image cost estimation needs a real image provider, ADR-009 — this stays mock-only).
          if (generation?.status === "succeeded") {
            await usage.create({
              id: uuid(),
              kind: "image",
              provider: generation.providerName ?? imageProvider.name,
              model: null,
              inputTokens: null,
              outputTokens: null,
              units: 1,
              estimatedCostUsd: null,
              requestId: requestId ?? null,
            });
          }
        })
    );

    await jobQueue.registerWorker<{ sceneId: string; requestId?: string }>(
      "video.generate_scene",
      async ({ sceneId, requestId }) =>
        runJob(logger, { queue: "video.generate_scene", jobId: sceneId, requestId }, async () => {
          await processVideoScene(
            { projectRepo: videoProjects, sceneRepo: videoScenes, jobQueue, assetStore, provider: videoProvider },
            sceneId,
            requestId
          );
          // FR-061/FR-063 — recorded per scene (the real unit of work), only on real success,
          // same reasoning as the image job above. estimatedCostUsd is null (mock-only, ADR-009).
          const scene = await videoScenes.get(sceneId);
          if (scene?.status === "succeeded") {
            await usage.create({
              id: uuid(),
              kind: "video",
              provider: videoProvider.name,
              model: null,
              inputTokens: null,
              outputTokens: null,
              units: scene.durationSeconds,
              estimatedCostUsd: null,
              requestId: requestId ?? null,
            });
          }
        }),
      { localConcurrency: 3 }
    );

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
    logger.info({ queues: ["document.ingest", "image.generate", "video.generate_scene", "video.render"] }, "job workers registered");
  } else {
    logger.info("api role: job workers NOT registered in this process — jobs are enqueued here and processed by a worker-role process");
  }

  // Worker role (ADR-039): no HTTP listener, no agent engine, no MCP — a Cloud Run worker
  // pool has no ingress, so there is nothing to listen for. The process stays alive on
  // pg-boss's own polling loop until a shutdown signal arrives.
  if (!runs.http) {
    logger.info("worker role: no HTTP listener started");
    installGracefulShutdown(logger, [() => jobQueue.stop(), closeDb]);
    return;
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
    assetStore,
    imageGenerations,
    videoProjects,
    videoScenes,
    usage,
    quota,
  };

  const app = await buildServer(config, ctx, logger);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  installGracefulShutdown(logger, [() => app.close(), () => jobQueue.stop(), closeDb]);
}

/**
 * Graceful shutdown — real, not decorative. PGlite (ADR-025) is a single embedded
 * engine, not a client to a separately-managed server process: an ungraceful exit
 * (e.g. a forceful `taskkill`/SIGKILL) can leave its on-disk state corrupted in a way
 * that doesn't surface until a later operation touches the affected structures —
 * discovered directly during Phase 8's own testing (PROJECT_STATUS.md), where a stray
 * abandoned process from an earlier crash silently damaged the dev database and it only
 * failed loudly once a new migration ran, well after the actual damage. A normal shutdown
 * signal (SIGINT/SIGTERM — which is exactly what Cloud Run sends before stopping an
 * instance in either role) runs the given close steps in order instead of leaving that
 * risk. Shared by both roles (ADR-039); only the list of things to close differs.
 */
function installGracefulShutdown(shutdownLogger: Logger, steps: Array<() => Promise<unknown>>): void {
  const shutdown = async (signal: string) => {
    shutdownLogger.info({ signal }, "shutting down gracefully");
    try {
      for (const step of steps) await step();
    } catch (err) {
      shutdownLogger.error({ err }, "error during graceful shutdown");
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
