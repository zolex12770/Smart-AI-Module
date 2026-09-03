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
import { estimateLlmCostUsd, ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import { createLogger, initTracing, withSpan, type Logger } from "@ai-platform/observability";
import { QuotaManager } from "@ai-platform/quota";
import { createRagTools, processDocumentIngestion, processDocumentScan } from "@ai-platform/rag";
import { ClamAvScanner, type MalwareScanner } from "@ai-platform/scanning";
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
  // `||`, not `??` — docs/26_DECISIONS.md ADR-045. The schema already maps an empty value to
  // undefined, but this is the line where a blank `GOOGLE_API_KEY=` silently shadowed a real
  // key set under the documented alias, so it states the intent locally too.
  const googleApiKey = config.GOOGLE_API_KEY || config.GEMINI_API_KEY;
  if (googleApiKey) {
    registry.register(new GoogleProvider({ apiKey: googleApiKey }));
  }

  const hasRealProvider = Boolean(config.ANTHROPIC_API_KEY || config.OPENAI_API_KEY || googleApiKey);
  // ADR-013 says the mock must never serve traffic in production. It was implemented as a
  // throw in MockLLMProvider's constructor — but this line constructed one unconditionally,
  // so a production boot died here even WITH a valid real key: the deployed image sets
  // NODE_ENV=production (apps/api/Dockerfile), which made every container un-bootable. Never
  // caught because no image has ever been built or run (ADR-037). ADR-045 keeps the rule and
  // fixes the enforcement: in production the mock is simply never constructed, and the
  // no-real-provider case fails with a message that says what to do about it.
  if (config.NODE_ENV === "production") {
    if (!hasRealProvider) {
      throw new Error(
        "No real LLM provider is configured and the mock provider is refused when NODE_ENV=production " +
          "(docs/26_DECISIONS.md ADR-013). Set ANTHROPIC_API_KEY, OPENAI_API_KEY or GOOGLE_API_KEY."
      );
    }
  } else {
    registry.register(new MockLLMProvider(), { asDefault: !hasRealProvider });
  }

  // ADR-045: without this, a reader who dropped a key into `.env` had no way to confirm it
  // took effect short of sending a chat and inferring from the answer — the exact ambiguity
  // that hid the alias bug above.
  logger.info(
    {
      providers: registry.list().map((p) => p.name),
      default: registry.getDefault().name,
      real_provider_configured: hasRealProvider,
    },
    hasRealProvider ? "LLM providers registered" : "LLM providers registered — NO real provider key found, the mock will answer"
  );

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

  // docs/13 §12 / ADR-042 — upload malware scanning. Presence of CLAMD_HOST is what turns the
  // scan step on for the upload route; the boot-time ping is a warning, not a gate, because
  // in the api role clamd is expected to be unreachable (the sidecar lives on the worker
  // pool, the only role that scans). A missing scanner is logged at WARN in capitals on
  // purpose: it is the one security control in docs/13 §12 that can be silently absent.
  let scanner: MalwareScanner | null = null;
  if (config.CLAMD_HOST) {
    scanner = new ClamAvScanner({ host: config.CLAMD_HOST, port: config.CLAMD_PORT });
    const reachable = await scanner.ping();
    logger.info({ scanner: scanner.name, reachable, role: config.ROLE }, reachable ? "malware scanner reachable" : "malware scanner configured but not reachable from this process");
    if (!reachable && runs.workers) logger.warn({ scanner: scanner.name }, "worker role cannot reach clamd — document.scan jobs will fail and retry until it is");
  } else if (config.UPLOAD_SCAN_REQUIRED) {
    logger.warn("UPLOAD_SCAN_REQUIRED=true but no CLAMD_HOST is configured — uploads will be REFUSED (503) until a scanner is configured");
  } else {
    logger.warn("UPLOAD MALWARE SCANNING DISABLED — no CLAMD_HOST configured; uploads are accepted unscanned and marked scan_status=skipped_no_scanner (docs/13 §12, ADR-042)");
  }

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
  // ADR-042: more retries, backoff — the common failure is clamd not (yet) reachable (e.g. the
  // sidecar still loading its database), which resolves on its own; a scan that never runs
  // leaves the document `scanning`, never `ready`.
  await jobQueue.ensureQueue("document.scan", { retryLimit: 5, retryDelay: 15, retryBackoff: true, expireInSeconds: 120 });
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
  const videoProjects = new PgVideoProjectRepository(db);
  const videoScenes = new PgVideoSceneRepository(db);
  // docs/26_DECISIONS.md ADR-045, same ADR-013 enforcement bug as the LLM mock above and with
  // a sharper consequence: image and video generation are mock-ONLY (ADR-009), so there is no
  // real provider to substitute. Constructing these unconditionally made every production boot
  // throw. Refusing to boot at all would make one mocked feature block the whole deployment,
  // so instead the capability is absent in production: no provider, no workers registered, and
  // the routes answer 503 with a reason (below) rather than accepting work nothing will do.
  const mediaGenerationAvailable = config.NODE_ENV !== "production";
  const imageProvider = mediaGenerationAvailable ? new MockImageProvider() : null;
  const videoProvider = mediaGenerationAvailable ? new MockVideoProvider() : null;
  if (!mediaGenerationAvailable) {
    logger.warn(
      "IMAGE AND VIDEO GENERATION DISABLED — they are mock-only (ADR-009) and a mock provider may not serve production traffic (ADR-013); those routes will return 503"
    );
  }

  if (runs.workers) {
    if (scanner) {
      const activeScanner = scanner;
      await jobQueue.registerWorker<{ documentId: string; requestId?: string }>(
        "document.scan",
        async ({ documentId, requestId }) =>
          runJob(logger, { queue: "document.scan", jobId: documentId, requestId }, async () => {
            const outcome = await processDocumentScan(
              { documentRepo: documents, assetRepo: assets, assetStore, scanner: activeScanner, jobQueue },
              documentId,
              requestId
            );
            logger.info({ request_id: requestId, job_id: documentId, scanner: activeScanner.name, outcome }, "upload scan completed");
          })
      );
    }

    await jobQueue.registerWorker<{ documentId: string; requestId?: string }>(
      "document.ingest",
      async ({ documentId, requestId }) =>
        runJob(logger, { queue: "document.ingest", jobId: documentId, requestId }, async () => {
          const document = await documents.get(documentId);
          if (!document) throw new Error(`document.ingest job referenced unknown document "${documentId}".`);
          await processDocumentIngestion(
            { documentRepo: documents, chunkRepo: documentChunks, embeddings, sandboxRoot, assetRepo: assets, assetStore },
            document
          );
        })
    );

    if (imageProvider)
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

    if (videoProvider)
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
  // docs/26_DECISIONS.md ADR-044 — the instance-wide fallback hook. The chat route overrides
  // it per call so its warning carries the request id; this one covers every other caller
  // (today: the agent engine's model_call nodes), which would otherwise report a failed real
  // provider only as an unstructured `console.warn` on stderr.
  const modelRouter = new ModelRouter(registry, {
    onFallback: (fallback) =>
      logger.warn(
        { provider: fallback.provider, stage: fallback.stage, error: fallback.message, status: "fallback" },
        "provider call failed, falling back to the next provider"
      ),
  });

  const engine = new AgentEngine({
    // docs/26_DECISIONS.md ADR-046 — the same quota gate and usage ledger the chat route
    // uses, so a real key's spend through agent tasks is bounded and visible too.
    meter: {
      checkTokens: (estimatedTokens) => quota.checkLlmTokens(estimatedTokens),
      record: async ({ provider, model, inputTokens, outputTokens, taskId, nodeId }) => {
        await usage.create({
          id: uuid(),
          kind: "llm",
          provider,
          model,
          inputTokens,
          outputTokens,
          units: null,
          estimatedCostUsd: estimateLlmCostUsd(provider, model, { inputTokens, outputTokens }),
          // No HTTP request id here: the call originates from a task node, not a request.
          // The node id is the durable identifier an operator would trace it back by.
          requestId: nodeId,
        });
        logger.info(
          { task_id: taskId, node_id: nodeId, provider, model, tokens_input: inputTokens, tokens_output: outputTokens, status: "success" },
          "provider call completed"
        );
      },
    },
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
    scanner,
    uploadScanRequired: config.UPLOAD_SCAN_REQUIRED,
    mediaGenerationAvailable,
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
