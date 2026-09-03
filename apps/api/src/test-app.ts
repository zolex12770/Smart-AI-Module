import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { AgentEngine } from "@ai-platform/agent-core";
import {
  createDb,
  runMigrations,
  PgAssetRepository,
  PgConversationRepository,
  PgDocumentChunkRepository,
  PgDocumentRepository,
  PgImageGenerationRepository,
  PgMemoryItemRepository,
  PgMessageRepository,
  PgTaskNodeRepository,
  PgTaskRepository,
  PgTaskTransitionRepository,
  PgVideoProjectRepository,
  PgVideoSceneRepository,
  PgUsageRecordRepository,
  type DrizzleDb,
} from "@ai-platform/database";
import { HashEmbeddingProvider } from "@ai-platform/embeddings";
import { fromPglite, JobQueue } from "@ai-platform/jobs";
import { MockLLMProvider } from "@ai-platform/llm-mock";
import { LocalAssetStore } from "@ai-platform/media";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import { QuotaManager } from "@ai-platform/quota";
import { createFilesystemTools, ToolRegistry } from "@ai-platform/tools";
import { loadConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Real, in-process test harness for the HTTP layer — mirrors `index.ts`'s composition
 * root (same repositories, same real PGlite Postgres, same real pg-boss job queue) minus
 * the pieces route-level tests don't need: no real network `listen()` (Fastify's own
 * `app.inject()` drives requests directly against the app instance), no MCP subprocess,
 * no job *workers* registered (route tests assert on enqueue-time behavior — validation,
 * status codes, rate limits — not job completion, which `packages/media`/`packages/rag`'s
 * own integration tests already cover for real). `NODE_ENV=test` keeps `loadConfig()`
 * happy without a real `.env`.
 */
export async function buildTestApp(): Promise<{ app: FastifyInstance; db: DrizzleDb; ctx: AppContext }> {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
  const config = loadConfig();

  const db = await createDb(":memory:");
  await runMigrations(db);

  const sandboxRoot = mkdtempSync(join(tmpdir(), "api-test-sandbox-"));
  const assetsRoot = mkdtempSync(join(tmpdir(), "api-test-assets-"));

  const registry = new ModelRegistry();
  registry.register(new MockLLMProvider(0), { asDefault: true });
  const modelRouter = new ModelRouter(registry);

  const toolRegistry = new ToolRegistry();
  for (const { definition, handler } of createFilesystemTools(sandboxRoot)) {
    toolRegistry.register(definition, handler);
  }

  const tasks = new PgTaskRepository(db);
  const taskNodes = new PgTaskNodeRepository(db);
  const taskTransitions = new PgTaskTransitionRepository(db);
  const engine = new AgentEngine({ taskRepo: tasks, nodeRepo: taskNodes, transitionRepo: taskTransitions, toolRegistry, modelRouter });

  const jobQueue = new JobQueue({ db: fromPglite(db.$client), backend: "pglite" });
  await jobQueue.start();
  // Must mirror every queue index.ts ensures — pg-boss's send() to a queue that was never
  // created throws, which surfaced as a 500 from the upload route the first time a test
  // configured a scanner (ADR-042) before `document.scan` was listed here.
  for (const queue of ["document.scan", "document.ingest", "image.generate", "video.generate_scene", "video.render"]) {
    await jobQueue.ensureQueue(queue);
  }

  const ctx: AppContext = {
    router: modelRouter,
    conversations: new PgConversationRepository(db),
    messages: new PgMessageRepository(db),
    corsOrigin: config.CORS_ORIGIN,
    engine,
    tasks,
    taskNodes,
    toolRegistry,
    documents: new PgDocumentRepository(db),
    documentChunks: new PgDocumentChunkRepository(db),
    memoryItems: new PgMemoryItemRepository(db),
    embeddings: new HashEmbeddingProvider(),
    sandboxRoot,
    jobQueue,
    assets: new PgAssetRepository(db),
    assetsRoot,
    assetStore: new LocalAssetStore(assetsRoot, new PgAssetRepository(db)),
    imageGenerations: new PgImageGenerationRepository(db),
    videoProjects: new PgVideoProjectRepository(db),
    videoScenes: new PgVideoSceneRepository(db),
    usage: new PgUsageRecordRepository(db),
    // No limits configured by default — route tests exercise the unlimited (opt-in) path;
    // a dedicated quota test constructs its own QuotaManager with real limits.
    quota: new QuotaManager(new PgUsageRecordRepository(db), {}),
    // No scanner by default (the fail-open path); tests that exercise scanning set ctx.scanner
    // themselves — route handlers read it at request time.
    scanner: null,
    uploadScanRequired: false,
    // Tests run as development would: the mock media providers are available (ADR-045).
    mediaGenerationAvailable: true,
  };

  const { createLogger } = await import("@ai-platform/observability");
  const app = await buildServer(config, ctx, createLogger("api-test"));

  return { app, db, ctx };
}

export async function closeTestApp(app: FastifyInstance, db: DrizzleDb, ctx: AppContext): Promise<void> {
  await app.close();
  await ctx.jobQueue.stop();
  await db.$client.close();
}
