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
  type PgliteDb,
} from "@ai-platform/database";
import { EmbeddingService, HashEmbeddingProvider } from "@ai-platform/embeddings";
import { MemoryService } from "@ai-platform/memory";
import { fromPglite, JobQueue } from "@ai-platform/jobs";
import { MockLLMProvider } from "@ai-platform/llm-mock";
import { LocalAssetStore } from "@ai-platform/media";
import { McpManager } from "@ai-platform/mcp";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import { QuotaManager } from "@ai-platform/quota";
import { AuthService, ProcessSandbox, TEST_SCRYPT_PARAMS, generateCsrfToken } from "@ai-platform/security";
import { createFilesystemTools, ToolRegistry } from "@ai-platform/tools";
import { loadConfig } from "./config.js";
import type { AppContext } from "./context.js";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "./plugins/auth.js";
import { buildServer } from "./server.js";

/**
 * Real, in-process test harness for the HTTP layer — mirrors `index.ts`'s composition
 * root (same repositories, same real PGlite Postgres, same real pg-boss job queue, same
 * real `AuthService`) minus the pieces route-level tests don't need: no real network
 * `listen()` (Fastify's own `app.inject()` drives requests directly against the app
 * instance), no MCP subprocess, no job *workers* registered (route tests assert on
 * enqueue-time behavior — validation, status codes, rate limits — not job completion, which
 * `backend/packages/media`/`backend/packages/rag`'s own integration tests already cover for real).
 * `NODE_ENV=test` keeps `loadConfig()` happy without a real `.env`.
 *
 * Since ADR-049 the harness also has to produce a *caller*. Every route that touches user
 * data now demands an authenticated principal and a project scope, so a test that only got
 * an app back could no longer reach anything: there is deliberately no ambient authority to
 * fall back on. `buildTestApp` therefore signs up a real user through the real `AuthService`
 * — which creates their organization and first project in one transaction — logs them in for
 * a real session token, and hands back ready-to-use `headers`.
 */

/** Password used for the harness account. Length only matters to `signupRequestSchema`;
 * this goes straight through `AuthService`, but keeping it valid means a test may re-login
 * through `POST /api/v1/auth/login` with the same credentials. */
const TEST_PASSWORD = "test-password-1234";

export interface TestAuth {
  userId: string;
  /** The tenant project every repository call in a route will be scoped to. */
  projectId: string;
  /** The opaque session token; only its SHA-256 is stored, exactly as in production. */
  sessionToken: string;
  csrfToken: string;
  /**
   * Drop-in for `app.inject({ headers })`. Carries three things, and each is load-bearing:
   * the session cookie (authentication), the CSRF cookie *and* matching header (the
   * double-submit pair the auth plugin requires on every cookie-authenticated mutation), and
   * `x-project-id` (the scope selector — a session, unlike an API key, is not bound to one
   * project, so the caller has to name which one it is acting in).
   */
  headers: Record<string, string>;
}

export async function buildTestApp(): Promise<{
  app: FastifyInstance;
  /**
   * The concrete PGlite handle, not the dialect-agnostic `DrizzleDb` the repositories take.
   * Tests need the narrower type because `$client` — the embedded engine that has to be shut
   * down at the end of a test, and the connection `pg-boss` is wired to — exists only on it.
   */
  db: PgliteDb;
  ctx: AppContext;
  auth: TestAuth;
}> {
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

  /**
   * The real AuthService against the real test database — not a stub. Authorization is the
   * thing these route tests most need to exercise honestly: a fake that always said "yes"
   * would make every IDOR regression invisible, which is exactly the class of bug ADR-049
   * exists to prevent.
   *
   * The one concession to running in a test is the scrypt cost. Production uses OWASP's
   * minimum (N=2^17 ≈ 128 MiB per hash); at that cost a suite that signs up a user per test
   * spends most of its runtime deriving keys. `TEST_SCRYPT_PARAMS` is the same algorithm and
   * the same encoded format at a lower N — the code path under test is unchanged.
   */
  const authService = new AuthService(db, { scryptParams: TEST_SCRYPT_PARAMS });

  const embeddings = new EmbeddingService(new HashEmbeddingProvider());
  const memoryItemRepo = new PgMemoryItemRepository(db);

  const ctx: AppContext = {
    db,
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
    memoryItems: memoryItemRepo,
    memory: new MemoryService(memoryItemRepo, embeddings),
    embeddings,
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
    imageGenerationAvailable: true,
    videoGenerationAvailable: true,

    // --- identity, tenancy and isolation (ADR-049 / ADR-055) -----------------------------
    auth: authService,
    // Plain HTTP under `app.inject()`: a `Secure` cookie would simply not be sent back.
    cookieSecure: false,
    authRateLimitMax: 1000,
    cookieSameSite: "lax",
    // ADR-055's process isolation (scrubbed env, real termination, output caps) rooted at the
    // same throwaway directory the filesystem tools use, so a test that reaches the sandbox
    // gets the real containment check rather than a permissive double.
    sandbox: new ProcessSandbox(sandboxRoot),
    agentLimits: {
      maxIterations: config.AGENT_MAX_ITERATIONS,
      maxTokensPerRun: config.AGENT_MAX_TOKENS_PER_RUN,
    },
    // False here, and truthfully so: the hash provider is a deterministic lexical fallback,
    // not a semantic model (ADR-048). Reading it off the service rather than hardcoding it
    // means a harness that one day configures a real embedding runtime reports the change.
    semanticEmbeddingsAvailable: !embeddings.isDeterministicFallback,
    registry,
    // No MCP subprocess in tests (see the harness note above), but the manager still has to
    // exist so routes that report server status have something honest to report: none.
    mcp: new McpManager(toolRegistry, { healthIntervalMs: 0 }),
    health: {
      database: async () => true,
      queue: async () => true,
      stats: async () => ({ projects: 1, users: 1, providers: registry.list().length, mcpServersConnected: 0 }),
    },
  };

  const { createLogger } = await import("@ai-platform/observability");
  const app = await buildServer(config, ctx, createLogger("api-test"));

  // A real signup (user + organization + first project, one transaction) followed by a real
  // login, through the same service the HTTP routes call. Nothing is inserted behind the
  // service's back, so the fixture cannot drift from what a genuine account looks like.
  const { user, projectId } = await authService.signup({
    email: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
    password: TEST_PASSWORD,
    displayName: "Test Operator",
    organizationName: "Test Organization",
  });
  const session = await authService.login(user.email, TEST_PASSWORD);
  // The CSRF token is minted by the login *route* in production (it is not a property of the
  // session), so the harness mints one the same way and sends both halves of the pair.
  const csrfToken = generateCsrfToken();

  return {
    app,
    db,
    ctx,
    auth: {
      userId: user.id,
      projectId,
      sessionToken: session.token,
      csrfToken,
      headers: {
        cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${csrfToken}`,
        [CSRF_HEADER]: csrfToken,
        "x-project-id": projectId,
      },
    },
  };
}

export async function closeTestApp(app: FastifyInstance, db: PgliteDb, ctx: AppContext): Promise<void> {
  await app.close();
  await ctx.jobQueue.stop();
  await db.$client.close();
}
