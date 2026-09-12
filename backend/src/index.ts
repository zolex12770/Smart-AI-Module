import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  type TaskNodeRepository,
  type TaskRepository,
  type TaskTransitionRepository,
  projects as projectsTable,
  users as usersTable,
} from "@ai-platform/database";
import { EmbeddingService, HashEmbeddingProvider } from "@ai-platform/embeddings";
import { MemoryService } from "@ai-platform/memory";
import { MockImageProvider } from "@ai-platform/image-mock";
import { OpenAICompatibleImageProvider } from "@ai-platform/image-openai";
import { fromPglite, JobQueue, type JobQueueOptions } from "@ai-platform/jobs";
import { AnthropicProvider } from "@ai-platform/llm-anthropic";
import { GoogleProvider } from "@ai-platform/llm-google";
import { LocalEmbeddingProvider, LocalOpenAICompatibleProvider } from "@ai-platform/llm-local";
import { MockLLMProvider } from "@ai-platform/llm-mock";
import { OpenAIProvider } from "@ai-platform/llm-openai";
import { McpManager, parseMcpServerConfigs } from "@ai-platform/mcp";
import {
  CloudStorageAssetStore,
  LocalAssetStore,
  OpenAiSpeechProvider,
  SapiSpeechProvider,
  processImageGeneration,
  processVideoRender,
  processVideoScene,
  type AssetStore,
  type SpeechProvider,
} from "@ai-platform/media";
import { estimateLlmCostUsd, ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import {
  createLogger,
  initMetrics,
  initTracing,
  observeQueueDepth,
  recordAgentRun,
  recordDeadLetter,
  recordJobProcessed,
  recordMediaJob,
  withSpan,
  type Logger,
} from "@ai-platform/observability";
import { QuotaManager } from "@ai-platform/quota";
import { createRagTools, processDocumentIngestion, processDocumentScan } from "@ai-platform/rag";
import { ClamAvScanner, type MalwareScanner } from "@ai-platform/scanning";
import { AuthService, createSandbox, type ExecutionSandbox } from "@ai-platform/security";
import { signupRequestSchema, type EmbeddingProvider } from "@ai-platform/shared";
import {
  createCodingTools,
  createFilesystemTools,
  createSearchTools,
  createTerminalTools,
  projectWorkspace,
  resolveSandboxedPath,
  ToolRegistry,
} from "@ai-platform/tools";
import { MockVideoProvider } from "@ai-platform/video-mock";
import { ReplicateVideoProvider } from "@ai-platform/video-replicate";
import { sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import { loadConfig, type AppConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { roleRuns, type RoleResponsibilities } from "./role.js";
import { buildServer } from "./server.js";
import { reapExpiredRateLimits } from "./plugins/rate-limit-store.js";

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
  // PGlite creates its data directory but not the parents, so a first boot with a nested
  // DATABASE_DIR (the default `./data/pgdata`, or a per-environment one) fails with a bare
  // ENOENT from `mkdir`. Creating the parent here makes a fresh checkout, a fresh container
  // and a throwaway test database all boot without a manual `mkdir` first.
  mkdirSync(dirname(resolve(config.DATABASE_DIR)), { recursive: true });
  // PGlite creates its data directory but not the parents, so a first boot with a nested
  // DATABASE_DIR (the default `./data/pgdata`, or a per-environment one) fails with a bare
  // ENOENT from `mkdir`. Creating the parent here makes a fresh checkout, a fresh container
  // and a throwaway test database all boot without a manual `mkdir` first.
  mkdirSync(dirname(resolve(config.DATABASE_DIR)), { recursive: true });
  const db = await createDb(config.DATABASE_DIR);
  await runMigrations(db);
  return {
    db,
    jobQueueOptions: { db: fromPglite(db.$client), backend: "pglite" },
    close: () => db.$client.close(),
  };
}

// --- job payloads -----------------------------------------------------------------------

/**
 * Every job payload now carries the tenant `projectId` — docs/26_DECISIONS.md ADR-049.
 *
 * This is not decoration. Every repository a worker touches takes `projectId` as its first
 * argument and puts it in the SQL `WHERE` (see PgDocumentRepository's own docstring): there
 * is deliberately no longer a `documents.get(id)` to call, so the ownership check a worker
 * might forget cannot be forgotten. But a background job has no request and no session to
 * derive scope from, so the scope has to travel *with* the job — the enqueueing route
 * resolved it from the caller's `AuthContext`, and it is carried through verbatim.
 *
 * `userId` travels for the same reason: `usage_records.user_id` attributes spend to the
 * person who asked for it, and a worker cannot otherwise know who that was. It is nullable
 * because some work genuinely has no user behind it (a scheduled re-index, say).
 *
 * These are parsed with zod rather than trusted as a typed generic. A job payload is
 * persisted JSON written by a *different* process — possibly an older deployment mid-rollout
 * — so it is exactly as untrusted as an HTTP body. A payload missing its scope fails here
 * with a message that names the field, instead of reaching Drizzle as `undefined` and
 * surfacing as an opaque SQL error several frames away.
 */
const jobScopeSchema = z.object({
  projectId: z.string().min(1, "job payload is missing projectId (ADR-049 tenant scope)"),
  /** Present when a user asked for this work; null/absent for platform-initiated jobs. */
  userId: z.string().min(1).nullish(),
  /** docs/20_OBSERVABILITY.md §3.2 — the enqueueing request, for log/trace correlation. */
  requestId: z.string().min(1).optional(),
});

const documentJobSchema = jobScopeSchema.extend({ documentId: z.string().min(1) });
const imageJobSchema = jobScopeSchema.extend({ generationId: z.string().min(1) });
/**
 * `videoProjectId` is the long-form video, NOT the tenant project — ADR-049 renamed that
 * column precisely because the two would otherwise collide on the one table where `projectId`
 * meant something else (see `VideoScene.videoProjectId`). Both ids are needed on the payload:
 * one selects the parent, the other proves the caller may see it.
 */
const videoSceneJobSchema = jobScopeSchema.extend({
  videoProjectId: z.string().min(1),
  sceneId: z.string().min(1),
});
const videoRenderJobSchema = jobScopeSchema.extend({ videoProjectId: z.string().min(1) });

/**
 * Registers the platform's LLM providers, in priority order — docs/26_DECISIONS.md ADR-056.
 *
 * The order is the architectural statement. A self-hosted OpenAI-compatible runtime is the
 * *default* when one is configured, not a fallback for when the hosted keys are missing: the
 * platform's independence from any single vendor is only real if the independent path is the
 * one that actually runs (product brief §7). A hosted key present alongside it is an escape
 * hatch for capabilities the local model lacks, not a silent upgrade.
 */
function registerLlmProviders(config: AppConfig, registry: ModelRegistry, logger: Logger): void {
  // 1. Self-hosted runtime — Ollama, vLLM, llama.cpp's server, LM Studio, or any
  //    OpenAI-compatible gateway. No third-party account involved.
  if (config.LLM_BASE_URL && config.LLM_MODEL) {
    registry.register(
      new LocalOpenAICompatibleProvider({
        baseUrl: config.LLM_BASE_URL,
        model: config.LLM_MODEL,
        apiKey: config.LLM_API_KEY,
        contextWindow: config.LLM_CONTEXT_WINDOW,
        supportsTools: config.LLM_SUPPORTS_TOOLS,
      }),
      { asDefault: true }
    );
  }

  // 2-4. Hosted adapters, each registering only when its key is present (ADR-010). Each has
  // been fixture-tested and confirmed to reach its live endpoint correctly, not
  // full-success-tested (ADR-023/024).
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

  // 5. The mock. ADR-013 says it must never serve production traffic; ADR-045 turned that
  // from a constructor throw (which killed every production boot, even with a valid key) into
  // "never constructed in production". Outside production it stays the zero-configuration
  // default so the platform runs with no credentials at all — but only as the default when
  // nothing real is registered, so a configured runtime is never shadowed by it.
  if (config.NODE_ENV !== "production") {
    registry.register(new MockLLMProvider(), { asDefault: registry.list().length === 0 });
  } else {
    logger.info("mock LLM provider NOT registered — NODE_ENV=production (ADR-013)");
  }
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
  // Metrics are initialised beside tracing (ADR-082). It must happen before ANY instrument is
  // resolved: `metrics.getMeter()` called with no provider registered returns a no-op meter and
  // caches it, so an instrument created earlier would record nothing, forever, with no error.
  initMetrics(serviceName);
  const logger = createLogger(serviceName);
  logger.info({ role: config.ROLE, http: runs.http, workers: runs.workers }, "booting");

  const { db, jobQueueOptions, close: closeDb } = await connectDatabase(config);

  // --- identity and tenancy (ADR-049) ----------------------------------------------------
  // The single authentication/authorization decision point for this process, constructed
  // before anything that can serve or process user data. After ADR-049 there is no such thing
  // as unattributed work: the hardcoded `local-user` owner every row used to carry is gone,
  // and ownership now comes from an AuthContext resolved here, or from nowhere at all.
  const authService = new AuthService(db, { sessionTtlMs: config.SESSION_TTL_DAYS * 86_400_000 });
  await bootstrapFirstAdmin(config, authService, runs, logger);

  const registry = new ModelRegistry();
  registerLlmProviders(config, registry, logger);
  const chatProviderCount = registry.list().length;

  /**
   * The production boot gate — narrowed to the processes it actually applies to (ADR-056).
   *
   * The previous rule was "production with no hosted LLM key cannot boot". That crash-looped
   * the deployed worker pool, which deliberately has no LLM key and needs none: a worker
   * serves no chat, runs no agent engine, and never asks the router for anything — it ingests
   * documents and renders media. Refusing to start it over a capability it never exercises is
   * the same class of bug ADR-045 fixed for the mock provider: a check placed where a
   * capability is *configured* rather than where it is *needed*.
   *
   * `runs.http` is that place. Only a process that will serve chat and run the agent loop
   * requires a provider to serve it with.
   */
  if (config.NODE_ENV === "production" && runs.http && chatProviderCount === 0) {
    throw new Error(
      "This process serves chat but no LLM provider is configured, and the mock provider may not run in " +
        "production (docs/26_DECISIONS.md ADR-013/ADR-056). Either point the platform at a self-hosted " +
        "OpenAI-compatible runtime by setting LLM_BASE_URL and LLM_MODEL (Ollama, vLLM, llama.cpp, LM Studio " +
        "or any compatible gateway — no third-party account required), or supply one of ANTHROPIC_API_KEY, " +
        "OPENAI_API_KEY or GOOGLE_API_KEY."
    );
  }

  // ADR-045: without this, a reader who dropped a key into `.env` had no way to confirm it
  // took effect short of sending a chat and inferring from the answer — the exact ambiguity
  // that hid the alias bug above. `getDefault()` is only consulted when something is
  // registered: the worker role legitimately boots with zero providers, and it throws on empty.
  logger.info(
    {
      providers: registry.list().map((p) => p.name),
      default: chatProviderCount > 0 ? registry.getDefault().name : null,
      self_hosted_runtime: Boolean(config.LLM_BASE_URL && config.LLM_MODEL),
      serves_chat: runs.http,
    },
    chatProviderCount > 0
      ? "LLM providers registered"
      : "no LLM provider registered — expected for a worker-role process, fatal for one that serves chat"
  );

  const sandboxRoot = resolve(config.SANDBOX_ROOT);
  mkdirSync(sandboxRoot, { recursive: true });
  const assetsRoot = resolve(config.ASSETS_ROOT);
  mkdirSync(assetsRoot, { recursive: true });

  // --- command execution isolation (ADR-055) ---------------------------------------------
  // Every command the agent chooses to run goes through this one object. `createSandbox`
  // refuses to downgrade silently: asking for docker and not getting it is an error, never a
  // quiet fall back to a weaker sandbox nobody asked for.
  const sandbox: ExecutionSandbox = await createSandbox({
    root: sandboxRoot,
    runtime: config.SANDBOX_RUNTIME,
    image: config.SANDBOX_IMAGE,
  });
  // Role-scoped, for the same reason the provider gate is: this guard asks "will THIS process
  // execute a command a model chose?", and only a process running the agent engine does. The
  // engine lives behind the HTTP role (`runs.http`); the worker pool runs ingestion, scanning
  // and media jobs, none of which execute arbitrary commands, so demanding container isolation
  // there would block a deployment on a risk that unit genuinely does not carry. A worker that
  // one day gains a command-executing job type gets this guard the moment it also gains the
  // engine.
  if (
    config.NODE_ENV === "production" &&
    runs.http &&
    sandbox.isolation === "process" &&
    !config.SANDBOX_ALLOW_PROCESS_IN_PRODUCTION
  ) {
    throw new Error(
      "Refusing to start in production with process-level sandbox isolation. The agent executes commands " +
        "chosen by a model; process isolation scrubs the environment and really does kill the process tree " +
        "on timeout, but it shares the host's network and filesystem, so a command that escapes the " +
        "workspace reaches the host (docs/13_SECURITY_ARCHITECTURE.md §6, ADR-055). Set SANDBOX_RUNTIME=docker " +
        "for real container isolation, or SANDBOX_ALLOW_PROCESS_IN_PRODUCTION=true to accept this explicitly."
    );
  }
  logger.info(
    { isolation: sandbox.isolation, image: sandbox.isolation === "docker" ? config.SANDBOX_IMAGE : null, sandboxRoot },
    sandbox.isolation === "docker"
      ? "sandbox: container isolation (no network, read-only root, dropped capabilities, pid/memory caps)"
      : "SANDBOX: PROCESS ISOLATION ONLY — model-chosen commands share the host network and filesystem (ADR-055)"
  );

  const toolRegistry = new ToolRegistry();

  const documents = new PgDocumentRepository(db);
  const documentChunks = new PgDocumentChunkRepository(db);

  // --- embeddings (ADR-048 / ADR-056) ----------------------------------------------------
  // Two providers behind one boundary. The hash provider is a real, deterministic *lexical*
  // embedding (ADR-026) — it finds chunks that share vocabulary, not chunks that mean the same
  // thing — and the platform must never imply otherwise, which is why the choice is logged in
  // capitals and surfaced to callers as `semanticEmbeddingsAvailable`. Pointing
  // EMBEDDING_BASE_URL at the same self-hosted runtime that serves chat gives real semantic
  // retrieval with no hosted provider at all.
  const embeddingProvider: EmbeddingProvider =
    config.EMBEDDING_BASE_URL && config.EMBEDDING_MODEL
      ? new LocalEmbeddingProvider({
          baseUrl: config.EMBEDDING_BASE_URL,
          model: config.EMBEDDING_MODEL,
          // The declared width is metadata only: EmbeddingService zero-pads every vector to
          // the column width, which is exact for cosine distance. 768 is the most common
          // self-hosted default (nomic-embed-text, all-mpnet-base-v2).
          dimensions: config.EMBEDDING_DIMENSIONS ?? 768,
          apiKey: config.EMBEDDING_API_KEY,
        })
      : new HashEmbeddingProvider();
  const embeddings = new EmbeddingService(embeddingProvider);
  const semanticEmbeddingsAvailable = !embeddingProvider.isDeterministicFallback;
  logger.info(
    {
      provider: embeddingProvider.name,
      model: embeddingProvider.model,
      dimensions: embeddingProvider.dimensions,
      semantic: semanticEmbeddingsAvailable,
    },
    semanticEmbeddingsAvailable
      ? "embeddings: a real semantic model is configured"
      : "EMBEDDINGS ARE LEXICAL, NOT SEMANTIC — the deterministic feature-hash fallback is active (ADR-026), so " +
          "retrieval matches shared vocabulary rather than meaning. Set EMBEDDING_BASE_URL and EMBEDDING_MODEL for real semantics"
  );

  // FR-063 (docs/22_COST_AND_QUOTA_STRATEGY.md) — the limits are still deployment-wide values
  // read from config; what ADR-049 changed is that the *usage* they are measured against is
  // counted per project, so one tenant can no longer exhaust another tenant's budget.
  const memoryItems = new PgMemoryItemRepository(db);
  // ADR-063 — the retrieval/injection/extraction layer over the memory store. Its relevance
  // threshold is derived from the embedding model, so it adapts when a real semantic model
  // replaces the deterministic fallback rather than needing to be retuned by hand.
  const memory = new MemoryService(memoryItems, embeddings);

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

  // The RAG tools take the EmbeddingService, not the raw provider: a query vector must be
  // padded to the column width and tagged with the same model as the stored vectors, or the
  // cosine comparison is against a different space entirely (ADR-048).
  for (const { definition, handler } of [
    ...createFilesystemTools(sandboxRoot),
    // The hardened sandbox, not a bare spawn (ADR-077): the parent's environment — every
    // provider key and the database URL — must never reach a command a model wrote.
    ...createTerminalTools(sandboxRoot, sandbox),
    ...createCodingTools(sandboxRoot),
    // `fs.search` / `fs.glob`. These were written, exported and unit-tested for ADR-062 and
    // then never added to this loop, so FR-010 ("where is X defined?") was unmeetable in the
    // running product no matter what the model asked for: the tools existed everywhere except
    // in the registry the agent actually sees. A coding agent that can read and patch but
    // cannot search has to guess at filenames.
    ...createSearchTools(sandboxRoot),
    ...createRagTools({ chunkRepo: documentChunks, documentRepo: documents, embeddings }),
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
  const jobQueue = new JobQueue({
    ...jobQueueOptions,
    // ADR-072 gave every queue a dead-letter sibling, but nothing ever counted an arrival:
    // `job_dead_letter_total` was defined, exported and tested, and never incremented, so the
    // one queue event that always warrants a page was invisible on the dashboard. The queue
    // reports the failure that exhausts a job's retries; naming it as a metric is this layer's
    // job, not the queue package's.
    onDeadLetter: ({ queue }) => recordDeadLetter({ queue }),
  });
  await jobQueue.start();
  // Every queue gets a dead-letter queue (ADR-072). Before this, a job that exhausted its
  // retries stopped at `failed`, was archived on the maintenance schedule and then deleted —
  // silent data loss, and for `document.scan` in particular it left the document stuck in
  // `scanning` with no surviving record of why.
  await jobQueue.ensureQueueWithDeadLetter("document.ingest", { retryLimit: 2, expireInSeconds: 120 });
  // ADR-042: more retries, backoff — the common failure is clamd not (yet) reachable (e.g. the
  // sidecar still loading its database), which resolves on its own; a scan that never runs
  // leaves the document `scanning`, never `ready`.
  await jobQueue.ensureQueueWithDeadLetter("document.scan", {
    retryLimit: 5,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 120,
  });
  await jobQueue.ensureQueueWithDeadLetter("image.generate", { retryLimit: 1, expireInSeconds: 60 });
  // 15 minutes, not the 60s the mock needed — ADR-085. `expireInSeconds` is how long a job may
  // sit `active` before pg-boss decides the worker died and lets another claim it, and a real
  // video prediction routinely runs for minutes: a cold model can take 60s to load before
  // generation starts (docs/05 §2.5) and generation itself is several multiples of the clip's
  // length (docs/06 §2.2). At 60s every real scene would be re-claimed mid-flight, so two
  // workers would poll — and pay for — the same prediction, and the scene would thrash until
  // its retries ran out. It sits above the provider's own 10-minute deadline so the provider
  // always gives up first, with room left for the download and the cancel.
  await jobQueue.ensureQueueWithDeadLetter("video.generate_scene", { retryLimit: 1, expireInSeconds: 900 });
  await jobQueue.ensureQueueWithDeadLetter("video.render", { retryLimit: 1, expireInSeconds: 300 });

  // `queue_depth` (docs/20_OBSERVABILITY.md §2.1) — the gauge that answers "are the workers
  // keeping up", and the other metric that was built, exported and then never wired to
  // anything. Registered after the queues are ensured, so the very first scrape reports all of
  // them, including the ones sitting at zero, rather than only whichever had work at boot.
  observeQueueDepth(() => jobQueue.queueDepths());

  // Image generation (docs/05_IMAGE_GENERATION_RESEARCH.md) — a real provider when one is
  // configured (ADR-065), the labelled mock otherwise, and either way it runs through the same
  // async job system a real (slow) provider needs, per docs/07 §1.6's "mock-provider parity"
  // directive — never resolved inline. Long-form video (docs/07 Part 2, ADR-030/ADR-085) —
  // the same three states; `video.generate_scene` runs with bounded concurrency
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
  /**
   * Image generation — ADR-065.
   *
   * A real provider is used whenever one is configured, in development as much as in
   * production: there is no reason to run the mock against a working image server. The mock
   * remains the zero-configuration development default and still refuses to exist in
   * production (ADR-013), so the possible states are "real images", "mock images, clearly
   * labelled, development only", or "no capability, reported honestly" — never a fake picture
   * presented as a generation.
   */
  const realImageProvider =
    config.IMAGE_BASE_URL && config.IMAGE_MODEL
      ? new OpenAICompatibleImageProvider({
          baseUrl: config.IMAGE_BASE_URL,
          model: config.IMAGE_MODEL,
          apiKey: config.IMAGE_API_KEY,
          supportsNegativePrompt: config.IMAGE_SUPPORTS_NEGATIVE_PROMPT,
          supportsSeed: config.IMAGE_SUPPORTS_SEED,
        })
      : null;
  const imageProvider = realImageProvider ?? (config.NODE_ENV !== "production" ? new MockImageProvider() : null);
  const imageGenerationAvailable = imageProvider !== null;

  /**
   * Video generation — ADR-085, and the same three-state shape as images above.
   *
   * ADR-065 declined to ship a video adapter because there is no cross-vendor wire format for
   * video — Runway, Luma and Veo each expose a different asynchronous contract — and one
   * vendor's adapter would have bought one vendor. Replicate is the answer to that objection
   * rather than an exception to it: it is itself an aggregator, one `predictions` API over
   * hundreds of hosted video models (docs/05 §2.5), so this single adapter reaches all of them
   * and changing model is a `VIDEO_MODEL_VERSION` change. The `VideoProvider` interface is
   * still the seam, so a second adapter is a new package and no change here.
   *
   * `VIDEO_PROVIDER` unset is unchanged from before this existed: the GIF-producing mock in
   * development (labelled as a mock, and forbidden in production by ADR-013), and no video
   * capability at all in production, with the routes reporting a real capability error rather
   * than queueing work no worker will do. Configuration cannot be half-done — config.ts
   * refuses to boot without the token and the model version — so there is no state in which
   * this constructs a provider that cannot actually generate anything.
   */
  const realVideoProvider =
    config.VIDEO_PROVIDER === "replicate" && config.VIDEO_API_TOKEN && config.VIDEO_MODEL_VERSION
      ? new ReplicateVideoProvider({
          apiToken: config.VIDEO_API_TOKEN,
          modelVersion: config.VIDEO_MODEL_VERSION,
        })
      : null;
  const videoProvider = realVideoProvider ?? (config.NODE_ENV !== "production" ? new MockVideoProvider() : null);
  const videoGenerationAvailable = videoProvider !== null;

  logger.info(
    {
      image_provider: imageProvider?.name ?? null,
      image_is_mock: imageProvider?.isMock ?? null,
      video_provider: videoProvider?.name ?? null,
      video_is_mock: videoProvider?.isMock ?? null,
    },
    imageGenerationAvailable || videoGenerationAvailable
      ? "media providers registered"
      : "MEDIA GENERATION UNAVAILABLE — no image or video provider is configured; those routes will report a capability error"
  );
  if (imageProvider?.isMock) {
    logger.warn(
      "IMAGE GENERATION IS MOCKED — output is a labelled placeholder, not a generated image (ADR-009). Set IMAGE_BASE_URL and IMAGE_MODEL for real generation"
    );
  }
  if (videoProvider?.isMock) {
    logger.warn(
      "VIDEO GENERATION IS MOCKED — output is an animated GIF, not video (ADR-030). Set VIDEO_PROVIDER, VIDEO_API_TOKEN and VIDEO_MODEL_VERSION for real generation"
    );
  }

  if (runs.workers) {
    if (scanner) {
      const activeScanner = scanner;
      await jobQueue.registerWorker<unknown>("document.scan", async (raw) => {
        const { projectId, documentId, requestId } = documentJobSchema.parse(raw);
        await runJob(logger, { queue: "document.scan", jobId: documentId, projectId, requestId }, async () => {
          const outcome = await processDocumentScan(
            { documentRepo: documents, assetRepo: assets, assetStore, scanner: activeScanner, jobQueue },
            projectId,
            documentId,
            requestId
          );
          logger.info(
            { request_id: requestId, job_id: documentId, project_id: projectId, scanner: activeScanner.name, outcome },
            "upload scan completed"
          );
        });
      });
    }

    await jobQueue.registerWorker<unknown>("document.ingest", async (raw) => {
      const { projectId, documentId, requestId } = documentJobSchema.parse(raw);
      await runJob(logger, { queue: "document.ingest", jobId: documentId, projectId, requestId }, async () => {
        // Scoped read (ADR-049). A document id belonging to another project resolves to "not
        // found" right here rather than being fetched and then checked, so a job whose payload
        // names the wrong project simply finds nothing — there is no ownership comparison for
        // this worker to get wrong.
        const document = await documents.get(projectId, documentId);
        if (!document) {
          throw new Error(`document.ingest job referenced unknown document "${documentId}" in project "${projectId}".`);
        }
        await processDocumentIngestion(
          {
            documentRepo: documents,
            chunkRepo: documentChunks,
            embeddings,
            sandboxRoot,
            assetRepo: assets,
            assetStore,
          },
          document
        );
      });
    });

    if (imageProvider)
      await jobQueue.registerWorker<unknown>("image.generate", async (raw) => {
        const { projectId, userId, generationId, requestId } = imageJobSchema.parse(raw);
        await runJob(logger, { queue: "image.generate", jobId: generationId, projectId, requestId }, async () => {
          // Measured around the provider call itself, not around the whole job: `runJob`'s
          // `job_duration_seconds` already covers queue-handler overhead, and the question
          // `generation_duration_seconds` answers is "how long does this provider take".
          const startedAt = Date.now();
          let generation: Awaited<ReturnType<typeof imageGenerations.get>> = undefined;
          try {
            await processImageGeneration(
              { generationRepo: imageGenerations, assetStore, provider: imageProvider },
              projectId,
              generationId
            );
            generation = await imageGenerations.get(projectId, generationId);
          } finally {
            /**
             * docs/20_OBSERVABILITY.md §2.1 `generation_duration_seconds` / `generation_total`.
             *
             * Specified since Phase 12 and never once emitted: `recordMediaJob` had no
             * production call site at all, so the media dashboards those two metrics back had
             * no data behind them — an operator could not answer "are image generations slower
             * or failing more than yesterday" from anything but log archaeology.
             *
             * In `finally` rather than after the call, because a provider that throws is
             * exactly the case the failure rate exists to show; recording only on the happy
             * path would make `generation_total{outcome="failure"}` permanently zero while
             * generations failed. An unset `generation` means the read never happened (the call
             * threw), which is a failure by definition.
             */
            recordMediaJob({
              mediaType: "image",
              provider: generation?.providerName ?? imageProvider.name,
              outcome: generation?.status === "succeeded" ? "success" : "failure",
              durationMs: Date.now() - startedAt,
            });
          }
          logger.info(
            {
              request_id: requestId,
              job_id: generationId,
              project_id: projectId,
              provider: generation?.providerName ?? imageProvider.name,
              status: generation?.status === "succeeded" ? "success" : "error",
            },
            "provider call completed"
          );
          // FR-061/FR-063 — recorded only on real success; a failed generation never happened,
          // so it shouldn't consume the project's daily image quota. estimatedCostUsd is null
          // (docs/22: image cost estimation needs a real image provider, ADR-009 — this stays
          // mock-only). The generation id is the natural key (ADR-054): a job retried after its
          // usage row was already written cannot charge the project a second time.
          if (generation?.status === "succeeded") {
            await usage.create({
              id: uuid(),
              projectId,
              userId: userId ?? null,
              kind: "image",
              provider: generation.providerName ?? imageProvider.name,
              model: null,
              inputTokens: null,
              outputTokens: null,
              units: 1,
              estimatedCostUsd: null,
              requestId: requestId ?? null,
              idempotencyKey: `image.generate:${generationId}`,
            });
          }
        });
      });

    if (videoProvider)
      await jobQueue.registerWorker<unknown>(
        "video.generate_scene",
        async (raw) => {
          const { projectId, userId, videoProjectId, sceneId, requestId } = videoSceneJobSchema.parse(raw);
          await runJob(logger, { queue: "video.generate_scene", jobId: sceneId, projectId, requestId }, async () => {
            // See the image worker: the provider call is what `generation_duration_seconds`
            // is about, so the clock starts here and not at job pickup.
            const startedAt = Date.now();
            let scene: Awaited<ReturnType<typeof videoScenes.get>> = undefined;
            try {
              await processVideoScene(
                {
                  projectRepo: videoProjects,
                  sceneRepo: videoScenes,
                  jobQueue,
                  assetStore,
                  provider: videoProvider,
                  // Narration for this scene (ADR-079). Undefined when unconfigured, and the
                  // scene then stays honestly silent rather than carrying a silent audio asset.
                  ...(speech ? { speech } : {}),
                  logger,
                },
                { projectId, videoProjectId },
                sceneId,
                requestId
              );
              // FR-061/FR-063 — recorded per scene (the real unit of work), only on real
              // success, for the same reason as the image job above. A scene is read through
              // its parent video project *and* the tenant project: scenes carry no project_id
              // of their own (ADR-049), so the scope object is what turns this read into an
              // access control.
              scene = await videoScenes.get({ projectId, videoProjectId }, sceneId);
            } finally {
              // docs/20 §2.1, same reasoning as the image worker — a scene is the unit of
              // video generation, so it is the unit this metric counts.
              recordMediaJob({
                mediaType: "video",
                provider: videoProvider.name,
                outcome: scene?.status === "succeeded" ? "success" : "failure",
                durationMs: Date.now() - startedAt,
              });
            }
            if (scene?.status === "succeeded") {
              /**
               * Who to charge this scene to (ADR-049's `usage_records.user_id`).
               *
               * Unlike the image job, `userId` is not on this payload and cannot be put there
               * from here: scene jobs are enqueued by `orchestrateVideoProject` in
               * backend/packages/media, which also fans out from the render/completion path where no
               * request and no caller exist. The video project row is the authority instead —
               * `created_by_user_id` is stamped from the credential by POST /api/v1/videos —
               * and it is the same person the payload would have named. Without it every video
               * usage row carried a null user, so the ledger could say which project spent but
               * never which member, which is precisely the attribution it exists to provide.
               * The payload still wins when a future enqueue site does set it.
               */
              const videoProject = await videoProjects.get(projectId, videoProjectId);
              await usage.create({
                id: uuid(),
                projectId,
                userId: userId ?? videoProject?.createdByUserId ?? null,
                kind: "video",
                provider: videoProvider.name,
                model: null,
                inputTokens: null,
                outputTokens: null,
                units: scene.durationSeconds,
                estimatedCostUsd: null,
                requestId: requestId ?? null,
                // ADR-054's own worked example: re-running orchestration re-enqueues `pending`
                // scenes, and this key is what stops that from billing the project twice.
                idempotencyKey: `video.scene:${sceneId}`,
              });
            }
          });
        },
        { localConcurrency: 3 }
      );

    await jobQueue.registerWorker<unknown>("video.render", async (raw) => {
      const { projectId, videoProjectId, requestId } = videoRenderJobSchema.parse(raw);
      await runJob(logger, { queue: "video.render", jobId: videoProjectId, projectId, requestId }, async () => {
        await processVideoRender(
          { projectRepo: videoProjects, sceneRepo: videoScenes, assetRepo: assets, assetStore, ffmpegPath: config.FFMPEG_PATH },
          { projectId, videoProjectId }
        );
      });
    });
    logger.info(
      { queues: ["document.scan", "document.ingest", "image.generate", "video.generate_scene", "video.render"] },
      "job workers registered"
    );
  } else {
    logger.info("api role: job workers NOT registered in this process — jobs are enqueued here and processed by a worker-role process");
  }

  /**
   * Reaps closed rate-limit windows (ADR-071).
   *
   * Deliberately on the WORKER role and not on every API instance: expired rows are already
   * harmless — the limiter's upsert treats one as a fresh window — so this is housekeeping,
   * and running it on N instances would mean N concurrent DELETEs competing for the same rows
   * to accomplish what one does. `unref` so it can never hold the process open during
   * shutdown, and a rejection is logged rather than propagated, because failing to tidy is not
   * a reason to take a worker down.
   */
  if (runs.workers) {
    const reaper = setInterval(
      () => {
        void reapExpiredRateLimits(db).catch((error: unknown) => {
          logger.warn({ error: error instanceof Error ? error.message : String(error) }, "rate limit reaper failed");
        });
      },
      15 * 60_000
    );
    reaper.unref();
  }

  // Worker role (ADR-039): no HTTP listener, no agent engine, no MCP — a Cloud Run worker
  // pool has no ingress, so there is nothing to listen for. The process stays alive on
  // pg-boss's own polling loop until a shutdown signal arrives.
  if (!runs.http) {
    installGracefulShutdown(logger, [
      { name: "mcp", close: () => mcpManager.stopAll() },
      { name: "jobs", close: () => jobQueue.stop() },
      { name: "database", close: closeDb },
    ]);
    logger.info("worker role: no HTTP listener started");
    return;
  }

  /**
   * MCP servers — docs/26_DECISIONS.md ADR-067.
   *
   * Configured servers come from `MCP_SERVERS` (a JSON array), so a deployment can run any set
   * without a code change; the bundled reference filesystem server is added when nothing is
   * configured, preserving the zero-configuration local loop. The manager isolates failures:
   * one server that will not start is recorded as `failed` and the platform continues, because
   * MCP is optional and an optional integration must never be able to stop a boot.
   */
  // Owns every MCP subprocess's lifetime, so the shutdown path can close them: the previous
  // integration assigned its connection to a local and dropped it, leaking the child (ADR-067).
  const mcpManager = new McpManager(toolRegistry, { logger });

  const { configs: configuredMcp, errors: mcpConfigErrors } = parseMcpServerConfigs(config.MCP_SERVERS);
  for (const error of mcpConfigErrors) {
    logger.warn({ error }, "ignoring a malformed MCP_SERVERS entry");
  }
  const mcpServers =
    configuredMcp.length > 0
      ? configuredMcp
      : [
          {
            id: "reference-filesystem",
            command: process.execPath,
            args: [fileURLToPath(import.meta.resolve("@modelcontextprotocol/server-filesystem/dist/index.js")), sandboxRoot],
            cwd: sandboxRoot,
          },
        ];
  await mcpManager.startAll(mcpServers);

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

  const cookieSecure = config.COOKIE_SECURE ? config.COOKIE_SECURE === "true" : config.NODE_ENV === "production";

  const engine = new AgentEngine({
    // ADR-064 — ceilings for an autonomous `reasoning` node. Set by the operator, not by the
    // model: they are the harness's half of the bargain that lets the model drive execution.
    agentLimits: {
      maxIterations: config.AGENT_MAX_ITERATIONS,
      maxTokensPerRun: config.AGENT_MAX_TOKENS_PER_RUN,
    },
    // docs/26_DECISIONS.md ADR-046 — the same quota gate and usage ledger the chat route
    // uses, so a real key's spend through agent tasks is bounded and visible too.
    meter: {
      checkTokens: async (estimatedTokens, { taskId }) => {
        // Quota is per-project (ADR-049) and the meter is handed only ids, so the task row is
        // the authority for which project is about to spend — the same resolution `record`
        // does below, kept deliberately identical so the two can never disagree.
        const task = await tasks.getUnscoped(taskId);
        if (!task) return { allowed: false, reason: `Task "${taskId}" no longer exists.` };
        return quota.checkLlmTokens(task.projectId, estimatedTokens);
      },
      record: async ({ provider, model, inputTokens, outputTokens, taskId, nodeId, idempotencyKey }) => {
        // ADR-049: a usage row must name the project that spent. The meter callback carries
        // only task and node ids — a task node is not an HTTP request and has no AuthContext
        // to read — so the task row is the authority. `getUnscoped` exists for exactly this
        // case: a system-internal read whose id came from the engine's own execution, never
        // from a caller, and which by definition spans every project.
        const task = await tasks.getUnscoped(taskId);
        if (!task) {
          // Real spend we cannot attribute. Dropping it silently would understate a project's
          // usage and quietly widen its quota, so it is surfaced at error level instead.
          logger.error(
            { task_id: taskId, node_id: nodeId, provider, model, tokens_input: inputTokens, tokens_output: outputTokens },
            "model call could not be charged: its task row is gone, so the spending project is unknown"
          );
          return;
        }
        await usage.create({
          id: uuid(),
          projectId: task.projectId,
          userId: task.createdByUserId,
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
          // ADR-054 — the engine supplies the key, because only it knows how many billable
          // calls a node makes. This used to be composed here as `agent.node:${nodeId}`, which
          // is correct for a `model_call` node and silently wrong for a `reasoning` node: every
          // turn after the first collided on the unique index below and was dropped, so a
          // multi-turn agent run billed for one turn. See `ModelCallMeter.record` in
          // backend/packages/agent-core/src/engine.ts.
          idempotencyKey,
        });
        logger.info(
          {
            task_id: taskId,
            node_id: nodeId,
            project_id: task.projectId,
            provider,
            model,
            tokens_input: inputTokens,
            tokens_output: outputTokens,
            status: "success",
          },
          "provider call completed"
        );
      },
    },
    /**
     * `test_suite` verification, wired to the same hardened sandbox the agent's own terminal
     * tool runs through (ADR-075, ADR-077).
     *
     * It was never wired. verify.ts documents that the composition root supplies this and that
     * an absent runner FAILS the check rather than passing it — so `test_suite` verification
     * could not pass anywhere in the running product, while the docstring read as though the
     * wire were connected. That matters now beyond tidiness: `fix_failing_test` verifies this
     * way, because the alternative is completing a coding task on the model's own report that
     * the tests pass.
     *
     * The two guards below are `terminal.run_command`'s, repeated rather than reused: routing
     * through the registry would need a project and a user, and a verification spec carries
     * neither. They are not decorative. `verificationSpec.args` is built from the
     * caller-supplied `testFile`, and `node` treats a single argv token like `--eval=<code>` as
     * a flag rather than a filename — that exact input, through that exact field, read a file
     * from outside the sandbox on a live instance of this platform (docs/29 Phase 11).
     */
    runTestCommand: async (spec) => {
      if (spec.command !== "node") {
        throw new Error(`Test command "${spec.command}" is not allow-listed; only "node" may be run in the sandbox.`);
      }
      // The CALLER'S project workspace (ADR-090/093), not the deployment root. Resolving against
      // the root both failed to find the test file and would have exposed every other tenant's
      // files to the command if it had.
      if (!spec.projectId) {
        throw new Error("A test_suite verification arrived with no project scope; refusing to run it.");
      }
      const workspace = projectWorkspace(sandboxRoot, { projectId: spec.projectId });
      const workdir = resolveSandboxedPath(workspace, spec.workspaceRoot ?? ".");
      const args = (spec.args ?? []).map(String);
      for (const arg of args) {
        if (arg.startsWith("-")) {
          throw new Error(
            `Test argument "${arg}" looks like a command-line flag, which a test command never legitimately needs — rejected.`
          );
        }
        // Resolved against the already-sandboxed workdir, the same base node itself will use.
        resolveSandboxedPath(workspace, arg, workdir);
      }
      const run = await sandbox.run({
        command: spec.command,
        args,
        workdir,
        ...(spec.timeoutMs ? { limits: { timeoutMs: spec.timeoutMs } } : {}),
      });
      // A run that was killed is not a run that failed, and reporting it as an exit code would
      // put "the tests failed" in the node's failure reason when the truth is "the tests never
      // finished" — two situations that call for different responses from a human and from a
      // retry. Thrown so the engine records the real reason instead.
      if (run.timedOut) {
        throw new Error(`The test command exceeded its time limit and was terminated after ${run.durationMs}ms.`);
      }
      if (run.cancelled) {
        throw new Error("The test command was cancelled before it finished.");
      }
      return { exitCode: run.exitCode ?? -1, stdout: run.stdout, stderr: run.stderr };
    },
    /**
     * `judgeOutput` is deliberately NOT wired, and verify.ts says so in as many words rather
     * than implying otherwise. A model judging a model is the weakest evidence this platform
     * accepts; enabling it by default would make it the easiest verification to reach for, and
     * every method above it is grounded in something outside the model. A node planned with
     * `model_judge` therefore fails with "refusing to treat an unrunnable check as passed",
     * which is the honest outcome — nothing in this repository plans one.
     */
    taskRepo: tasks,
    nodeRepo: taskNodes,
    // Instrumented, not raw: this is where a finished agent run becomes a metric (see
    // `withAgentRunMetrics`). The engine is handed the wrapper rather than the repository so
    // every terminal state is counted, whoever caused it — the run that finishes on its own,
    // the one a user cancels, and the one crash recovery resumes and then fails.
    transitionRepo: withAgentRunMetrics(taskTransitions, { taskRepo: tasks, nodeRepo: taskNodes, logger }),
    toolRegistry,
    modelRouter,
  });

  // Crash recovery (docs/11_AGENT_LOOP.md §4.2) — reconcile any task/node left in a
  // non-terminal or in-flight state by a previous process before serving new requests.
  await engine.resumeAll();

  /**
   * Narration synthesis — docs/26_DECISIONS.md ADR-079.
   *
   * Constructed only when configured. There is deliberately no default and no silent fallback: a
   * pipeline with no speech provider renders without an audio track and reports
   * `skipped_no_narration`, exactly as it already reports `skipped_no_ffmpeg`. Muxing silence and
   * calling it a voice-over would be a fake success an operator could not detect.
   */
  let speech: SpeechProvider | null = null;
  try {
    if (config.SPEECH_PROVIDER === "openai") {
      if (!config.SPEECH_BASE_URL || !config.SPEECH_MODEL) {
        logger.warn({}, "SPEECH_PROVIDER=openai but SPEECH_BASE_URL/SPEECH_MODEL are unset — narration is disabled");
      } else {
        speech = new OpenAiSpeechProvider({
          baseUrl: config.SPEECH_BASE_URL,
          model: config.SPEECH_MODEL,
          apiKey: config.SPEECH_API_KEY,
          defaultVoice: config.SPEECH_VOICE,
        });
      }
    } else if (config.SPEECH_PROVIDER === "sapi") {
      speech = new SapiSpeechProvider({ voice: config.SPEECH_VOICE });
    }
  } catch (error) {
    // A misconfigured OPTIONAL capability must never stop a boot — the rule MCP already follows
    // (ADR-067). Narration is disabled and the reason is logged loudly.
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "speech provider could not be constructed — narration is disabled"
    );
    speech = null;
  }
  logger.info(
    { provider: speech?.name ?? null, available: speech !== null },
    speech ? "speech provider registered" : "no speech provider configured — long-form video renders without narration"
  );

  const ctx: AppContext = {
    db,
    speech,
    speechAvailable: speech !== null,
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
    memoryItems,
    memory,
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
    imageGenerationAvailable,
    videoGenerationAvailable,

    // --- identity, isolation and limits (ADR-049 / ADR-055 / ADR-057) --------------------
    auth: authService,
    // A Secure cookie is mandatory over HTTPS and impossible over plain-HTTP localhost, so
    // the default follows NODE_ENV. COOKIE_SECURE exists only to override that for the
    // unusual case (a production-mode process behind a local TLS-terminating proxy).
    cookieSecure,
    authRateLimitMax: config.AUTH_RATE_LIMIT_MAX,
    // Derived unless explicitly set: the deployed web app and API are different hostnames, so
    // a Lax cookie would never be sent on the browser's API calls and nobody could sign in
    // (ADR-070). `None` requires `Secure`, which is exactly when it is chosen.
    cookieSameSite: config.COOKIE_SAMESITE ?? (cookieSecure ? "none" : "lax"),
    sandbox,
    // Ceilings the model cannot raise. They live on the context rather than inside the loop
    // so an operator can see and change the bound without editing agent code.
    agentLimits: { maxIterations: config.AGENT_MAX_ITERATIONS, maxTokensPerRun: config.AGENT_MAX_TOKENS_PER_RUN },
    semanticEmbeddingsAvailable,
    registry,
    mcp: mcpManager,
    health: {
      // A real readiness probe, unlike `/api/health`'s liveness literal: it actually asks the
      // database and the queue whether they are reachable (ADR-066).
      database: async () => {
        try {
          await db.execute(sql`select 1`);
          return true;
        } catch {
          return false;
        }
      },
      queue: async () => {
        try {
          await jobQueue.getJob("document.ingest", "health-probe");
          return true;
        } catch {
          return false;
        }
      },
      stats: async () => {
        const [projectCount, userCount] = await Promise.all([
          db.select({ n: sql<number>`count(*)::int` }).from(projectsTable),
          db.select({ n: sql<number>`count(*)::int` }).from(usersTable),
        ]);
        return {
          projects: Number(projectCount[0]?.n ?? 0),
          users: Number(userCount[0]?.n ?? 0),
          providers: registry.list().length,
          mcpServersConnected: mcpManager.status().filter((server) => server.status === "connected").length,
        };
      },
    },
  };

  const app = await buildServer(config, ctx, logger);

  // Installed BEFORE `listen()`, not after — an audit finding, not a style preference. This
  // used to be the last statement in `main()`, which left a real window: a SIGTERM arriving
  // while the server was still binding hit Node's default handler and killed the process
  // outright — no `app.close()`, no `jobQueue.stop()`, and, worst of all for PGlite, no clean
  // database close (see `installGracefulShutdown` for why that specifically matters). Cloud
  // Run sends exactly that signal to an instance it decides to stop mid-rollout, so the
  // window was not hypothetical.
  installGracefulShutdown(logger, [
    { name: "mcp", close: () => mcpManager.stopAll() },
    { name: "http", close: () => app.close() },
    { name: "jobs", close: () => jobQueue.stop() },
    { name: "database", close: closeDb },
  ]);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

/**
 * Creates the first administrator on an empty database — docs/26_DECISIONS.md ADR-049.
 *
 * ADR-049 removed the hardcoded `local-user` owner, which means a freshly migrated database
 * has no accounts at all and every endpoint answers 401. Without this there would be no way
 * in except leaving signup open to the world. This closes that bootstrap gap without opening
 * one: the account is created only when the users table is genuinely empty, so the two
 * variables are inert on every subsequent boot and cannot be used to graft an administrator
 * onto a live installation.
 *
 * The credential is validated by the same schema the signup endpoint uses, so a bootstrap
 * password that would be rejected from outside is rejected here too — loudly, at boot —
 * rather than silently creating a weak permanent administrator. It is never logged.
 */
async function bootstrapFirstAdmin(
  config: AppConfig,
  authService: AuthService,
  runs: RoleResponsibilities,
  logger: Logger
): Promise<void> {
  if (!config.BOOTSTRAP_ADMIN_EMAIL || !config.BOOTSTRAP_ADMIN_PASSWORD) return;
  // Only the process that serves HTTP bootstraps. A worker pool cannot log anyone in, and two
  // roles racing to create the same first account is a conflict with nothing to gain.
  if (!runs.http) return;
  if ((await authService.userCount()) > 0) return;

  const parsed = signupRequestSchema.safeParse({
    email: config.BOOTSTRAP_ADMIN_EMAIL,
    password: config.BOOTSTRAP_ADMIN_PASSWORD,
    displayName: "Administrator",
  });
  if (!parsed.success) {
    throw new Error(
      "BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD are set but are not usable credentials (passwords must " +
        `be at least 12 characters): ${parsed.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ")}`
    );
  }

  // `bootstrapSystemAdmin`, not `signup` (ADR-096): signup hardcodes `isSystemAdmin: false`, so
  // this function spent its whole life logging that it had created an administrator while in fact
  // creating an ordinary account -- and every `/admin` route stayed unreachable to everyone.
  const { user, projectId } = await authService.bootstrapSystemAdmin(parsed.data);
  // Email and ids only. The password is never written anywhere, including here.
  logger.warn(
    { user_id: user.id, email: user.email, project_id: projectId, is_system_admin: user.isSystemAdmin },
    "BOOTSTRAPPED THE FIRST ADMINISTRATOR from BOOTSTRAP_ADMIN_EMAIL/PASSWORD on an empty database — log in, " +
      "then remove those variables from the environment"
  );
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
interface ShutdownStep {
  name: string;
  close: () => Promise<unknown>;
}

function installGracefulShutdown(shutdownLogger: Logger, steps: ShutdownStep[]): void {
  const shutdown = async (signal: string) => {
    shutdownLogger.info({ signal }, "shutting down gracefully");
    // Each step is isolated (ADR-098). They used to be awaited inside ONE try, so the first
    // rejection jumped to the catch and skipped every step after it -- and `closeDb` is last,
    // which made the one step this function exists for the first casualty of any other step
    // failing. PGlite is an embedded engine: an unclean close can leave on-disk state damaged
    // in a way that only surfaces on a later migration (it did, in Phase 8).
    const failed: string[] = [];
    for (const step of steps) {
      try {
        await step.close();
      } catch (err) {
        failed.push(step.name);
        shutdownLogger.error({ err, step: step.name }, "a shutdown step failed; continuing with the rest");
      }
    }
    if (failed.length > 0) {
      // Non-zero, because a shutdown that could not close everything is not a clean one and an
      // operator should be able to tell the difference from the exit status alone.
      shutdownLogger.error({ failed }, "graceful shutdown completed with failures");
      process.exit(1);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

/** The task states an agent run ends in, and the `recordAgentRun` outcome each one is.
 *  Task states are upper-case and node statuses are lower-case (shared task-graph.ts),
 *  which is what lets this lookup tell a finished RUN from a finished NODE: both are appended
 *  to the same transition log, and only the run is a run. */
const AGENT_RUN_OUTCOMES = {
  COMPLETED: "success",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

/**
 * Emits `agent_run_duration_seconds` / `agent_step_count` — docs/20_OBSERVABILITY.md §2.1.
 *
 * WHAT WAS MISSING. `recordAgentRun` was specified, implemented and exported, and had no
 * production call site anywhere: the two agent metrics an operator would actually alert on —
 * "are runs getting slower" and "is the planner looping" — were permanently empty. Everything
 * else about a run was observable (a span per run, a usage row per model call, a transition
 * row per state change), which made the gap easy to miss and impossible to work around: a
 * histogram cannot be reconstructed after the fact from logs.
 *
 * WHY HERE, of all places. The engine has no run-completion hook, and backend/packages/agent-core is
 * off-limits to this change, so the call has to go somewhere backend already owns. Every
 * terminal state passes through `transitionRepo.append` exactly once — `transitionTask` is the
 * only writer and it appends after it has updated the task row — so wrapping the repository
 * counts every run, whatever ended it: one that finished on its own, one a user cancelled
 * through the API, one crash recovery resumed and then failed. Subscribing per task in the
 * route handler was the alternative, and it would have counted only runs this process started
 * and leaked a listener for every run that never terminates.
 *
 * It reads the task and its nodes rather than tracking them in memory because those are the
 * facts as they were actually persisted; an in-memory counter would go wrong on exactly the
 * runs that matter (resumed after a restart, replanned, or executed by a second instance).
 * One extra pair of reads per run, at the moment the run ends — not per step.
 *
 * Nothing here may fail a transition. The state change is the real work and the metric is a
 * side effect of it, so a failed read is logged and swallowed; a run that ends correctly but
 * goes uncounted is a gap in a dashboard, while a transition lost to a metrics error would be
 * a task stuck in a non-terminal state forever.
 */
function withAgentRunMetrics(
  transitionRepo: TaskTransitionRepository,
  deps: { taskRepo: TaskRepository; nodeRepo: TaskNodeRepository; logger: Logger }
): TaskTransitionRepository {
  return {
    listByTask: (projectId, taskId) => transitionRepo.listByTask(projectId, taskId),
    listByTaskUnscoped: (taskId) => transitionRepo.listByTaskUnscoped(taskId),
    async append(input) {
      const transition = await transitionRepo.append(input);
      const outcome = AGENT_RUN_OUTCOMES[input.toState as keyof typeof AGENT_RUN_OUTCOMES];
      if (outcome) {
        try {
          // Unscoped reads, and legitimately so: the ids come from the engine's own execution
          // and never from a caller, and a metric spans every project by definition (the same
          // reasoning as the engine meter's `getUnscoped` above). No label carries either id —
          // `recordAgentRun` is labelled by outcome alone, so cardinality stays bounded.
          const task = await deps.taskRepo.getUnscoped(input.taskId);
          if (task) {
            const nodes = await deps.nodeRepo.listByRootUnscoped(input.taskId);
            recordAgentRun({
              outcome,
              // The whole run, from the moment the task row was created — including time spent
              // waiting for a human approval, which is honest: "how long until a user got an
              // answer" is the question this histogram is read for.
              durationMs: Date.now() - task.createdAt,
              // Nodes in the plan, which is what a "step" is for this engine (docs/11 §3.2).
              // A replanned task carries its replacement nodes, so this counts the plan that
              // actually ran, not every node that ever existed.
              stepCount: nodes.length,
            });
          }
        } catch (err) {
          deps.logger.warn(
            { err, task_id: input.taskId, to_state: input.toState },
            "agent run finished but could not be recorded as a metric"
          );
        }
      }
      return transition;
    },
  };
}

/**
 * docs/20_OBSERVABILITY.md §3.3 (`job.process` span) + §1.2 (structured job log fields) —
 * shared by every job worker registered above so a job's `request_id` (propagated from the
 * enqueueing HTTP request — see routes/v1/images.ts, videos.ts, rag.ts) is threaded through
 * both the trace and every log line the job produces, closing the "API → worker →
 * provider-call" correlation the roadmap's Phase 12 exit criterion asks for.
 *
 * `project_id` joined it with ADR-049: once more than one tenant exists, "which job failed"
 * is not an answerable question without knowing whose job it was.
 */
async function runJob<T>(
  jobLogger: Logger,
  params: { queue: string; jobId: string; projectId: string; requestId?: string },
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  return withSpan(
    "job.process",
    {
      "job.queue": params.queue,
      job_id: params.jobId,
      project_id: params.projectId,
      request_id: params.requestId ?? "",
    },
    async () => {
      try {
        const result = await fn();
        jobLogger.info(
          {
            request_id: params.requestId,
            job_id: params.jobId,
            project_id: params.projectId,
            queue: params.queue,
            latency_ms: Date.now() - startedAt,
            status: "success",
          },
          "job completed"
        );
        // The same event as the log line above, counted rather than narrated (ADR-082). A log
        // answers "what happened to THIS job"; only a metric answers "is the failure rate
        // climbing", which is the question an alert is built on.
        recordJobProcessed({ queue: params.queue, outcome: "success", durationMs: Date.now() - startedAt });
        return result;
      } catch (err) {
        jobLogger.error(
          {
            request_id: params.requestId,
            job_id: params.jobId,
            project_id: params.projectId,
            queue: params.queue,
            err,
            latency_ms: Date.now() - startedAt,
            status: "error",
          },
          "job failed"
        );
        recordJobProcessed({ queue: params.queue, outcome: "failure", durationMs: Date.now() - startedAt });
        throw err;
      }
    }
  );
}
