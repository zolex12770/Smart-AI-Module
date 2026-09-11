import type { FastifyInstance } from "fastify";
import { NotFoundError, ServiceUnavailableError, ValidationError, type Permission } from "@ai-platform/shared";
import { z } from "zod";
import { scrapeMetrics } from "@ai-platform/observability";
import type { AppContext } from "../../context.js";
import { requireProject, requireUser } from "../../plugins/auth.js";

/**
 * Platform introspection and administration — docs/15_API_ARCHITECTURE.md's `/models`,
 * `/providers`, `/mcp`, `/jobs` and `/admin` groups, built by docs/26_DECISIONS.md ADR-066.
 *
 * The ADR-047 audit found these documented in the present tense with no code behind them. They
 * matter more now than they did then: with a provider-neutral runtime (ADR-056) and real
 * image generation (ADR-065), "which model am I actually talking to, and is it real?" is a
 * question an operator has to be able to answer without reading boot logs.
 *
 * Everything here is read-mostly and honest about degraded states — an unconfigured capability
 * is reported as unconfigured rather than omitted, because a missing row looks like a bug and
 * an explicit `available: false` looks like a decision.
 */
export function registerPlatformRoutes(app: FastifyInstance, ctx: AppContext): void {
  // --- models and providers --------------------------------------------------------------

  app.get("/api/v1/models", async (request) => {
    // Any authenticated member may see what the platform can do; only the *configuration* of
    // it is privileged. Knowing that a model exists is not sensitive, and a UI needs it to
    // decide which controls to render at all.
    await requireProject(request, ctx.auth, "project:read");
    const descriptors = ctx.registry.listDescriptors();
    return {
      models: descriptors.map((d) => ({
        provider: d.provider.name,
        model: d.provider.model,
        isMock: d.provider.isMock,
        capabilities: d.capabilities,
        qualityTier: d.qualityTier,
        costHint: d.costHint,
        latencyHint: d.latencyHint,
        isDefault: d.provider.name === ctx.registry.getDefault().name,
      })),
      default: ctx.registry.getDefault().name,
    };
  });

  app.get("/api/v1/providers", async (request) => {
    await requireProject(request, ctx.auth, "project:read");
    const chat = ctx.registry.listDescriptors();
    return {
      providers: {
        /**
         * `selfHosted` is the field that answers the question the whole ADR-056 design exists
         * for: is this deployment independent of a third-party AI vendor, or not?
         */
        chat: chat.map((d) => ({
          name: d.provider.name,
          model: d.provider.model,
          isMock: d.provider.isMock,
          selfHosted: d.provider.name === "local",
          toolCalling: d.capabilities.toolCalling,
        })),
        embeddings: {
          name: ctx.embeddings.modelTag,
          semantic: ctx.semanticEmbeddingsAvailable,
          // Stated plainly rather than left for the reader to infer from a model name.
          note: ctx.semanticEmbeddingsAvailable
            ? "Retrieval matches meaning."
            : "Retrieval matches shared vocabulary, not meaning: the deterministic fallback is active.",
        },
        image: { available: ctx.imageGenerationAvailable },
        video: { available: ctx.videoGenerationAvailable },
        malwareScanner: { available: ctx.scanner !== null, name: ctx.scanner?.name ?? null },
        sandbox: { isolation: ctx.sandbox.isolation },
      },
    };
  });

  // --- tools -----------------------------------------------------------------------------

  app.get("/api/v1/tools", async (request) => {
    await requireProject(request, ctx.auth, "project:read");
    return {
      tools: ctx.toolRegistry.list().map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        origin: t.origin,
        permissionLevel: t.permissionLevel,
        riskLevel: t.riskLevel,
        requiresApproval: t.requiresApproval,
        enabled: t.enabled,
      })),
    };
  });

  const enableToolSchema = z.object({ enabled: z.boolean().default(true) }).strict().partial({ enabled: true });

  /**
   * Enabling or disabling a tool is a DEPLOYMENT decision, not a project one — ADR-089.
   *
   * This used to require `tools:manage`, a PROJECT-scoped permission that every user holds in the
   * project their own signup creates. But `ctx.toolRegistry` is a single process-wide instance and
   * `setEnabled` takes no project, so the effect was global: any self-registered user could
   * disable a tool for every tenant in the deployment, or — worse — ENABLE one of the MCP-
   * discovered tools that ADR-083 deliberately registers disabled, on everyone's behalf.
   *
   * A project-scoped permission governing a process-global mutation is the mismatch; the fix is
   * to match the permission to the blast radius rather than to pretend the radius is smaller.
   * System-admin, like every other `/admin` action, and 404 to everyone else for the same reason
   * (ADR-049: confirming an endpoint exists is itself a disclosure).
   *
   * Per-PROJECT tool policy would be the richer answer and is a real schema change — it is not
   * done, and this is deliberately the narrow fix that closes the escalation today.
   */
  app.post<{ Params: { id: string } }>("/api/v1/tools/:id/enable", async (request) => {
    requireSystemAdmin(request);
    const parsed = enableToolSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const definition = ctx.toolRegistry.setEnabled(request.params.id, parsed.data.enabled ?? true);
    return { tool: { id: definition.id, enabled: definition.enabled } };
  });

  // --- MCP -------------------------------------------------------------------------------

  app.get("/api/v1/mcp", async (request) => {
    await requireProject(request, ctx.auth, "project:read");
    return {
      servers: ctx.mcp.status().map((server) => ({
        id: server.id,
        status: server.status,
        // Which wire it came up on — stdio, Streamable HTTP, or the deprecated SSE fallback.
        transport: server.transport,
        toolCount: server.toolIds.length,
        toolIds: server.toolIds,
        // Tools this server offered and was refused because the id was already taken. Shown,
        // not just logged: on a remote server that is what a name-squatting attempt looks
        // like, and a boot-time log line is not where anyone goes looking for it.
        refusedToolIds: server.refusedToolIds,
        lastError: server.lastError,
        connectedAt: server.connectedAt,
      })),
    };
  });

  app.post<{ Params: { id: string } }>("/api/v1/mcp/:id/reconnect", async (request) => {
    await requireProject(request, ctx.auth, "mcp:manage");
    const reconnected = await ctx.mcp.reconnect(request.params.id);
    if (!reconnected) throw new NotFoundError(`MCP server "${request.params.id}" is not configured.`);
    return { ok: true, server: reconnected };
  });

  // --- jobs ------------------------------------------------------------------------------

  const jobQuerySchema = z.object({
    queue: z.string().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });

  app.get("/api/v1/jobs", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    const parsed = jobQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    // Scoped to the caller's project by the repository, not filtered afterwards (ADR-049).
    return {
      jobs: await ctx.jobQueue.listForProject(authCtx.projectId!, {
        queue: parsed.data.queue,
        limit: parsed.data.limit,
      }),
    };
  });

  app.post<{ Params: { queue: string; id: string } }>("/api/v1/jobs/:queue/:id/cancel", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:write");
    const cancelled = await ctx.jobQueue.cancelForProject(authCtx.projectId!, request.params.queue, request.params.id);
    if (!cancelled) throw new NotFoundError(`Job "${request.params.id}" not found in queue "${request.params.queue}".`);
    return { ok: true };
  });

  /**
   * Work that was given up on, and why — docs/26_DECISIONS.md ADR-072.
   *
   * Separate from `/jobs` on purpose. A dead letter is not a job in progress; it is an incident
   * with an owner and an action, and mixing the two would bury the handful of things that need
   * attention among the hundreds that do not.
   */
  app.get("/api/v1/jobs/dead-letter", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    const parsed = jobQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    return {
      deadLettered: await ctx.jobQueue.listDeadLetteredForProject(authCtx.projectId!, {
        queue: parsed.data.queue,
        limit: parsed.data.limit,
      }),
    };
  });

  /**
   * Re-runs a dead-lettered job. `project:write`, not `project:read`: this enqueues real work
   * that spends the project's quota, so it needs the same permission as creating that work in
   * the first place.
   */
  app.post<{ Params: { queue: string; id: string } }>(
    "/api/v1/jobs/dead-letter/:queue/:id/replay",
    async (request) => {
      const authCtx = await requireProject(request, ctx.auth, "project:write");
      const replayedId = await ctx.jobQueue.replayDeadLettered(
        authCtx.projectId!,
        request.params.queue,
        request.params.id
      );
      // Another project's dead letter is indistinguishable from one that does not exist.
      if (!replayedId) {
        throw new NotFoundError(`Dead-lettered job "${request.params.id}" not found in "${request.params.queue}".`);
      }
      return { ok: true, jobId: replayedId };
    }
  );

  // --- administration --------------------------------------------------------------------

  /**
   * Platform-wide, not project-wide: a system administrator is a cross-tenant role, so these
   * deliberately do NOT go through `requireProject`. They check `isSystemAdmin` directly,
   * which is the only place in the codebase that authority is used.
   */
  const requireSystemAdmin = (request: Parameters<typeof requireUser>[0]) => {
    const user = requireUser(request);
    if (!user.isSystemAdmin) {
      throw new NotFoundError("Not found.");
    }
    return user;
  };

  app.get("/api/v1/admin/health", async (request) => {
    requireSystemAdmin(request);
    // A real readiness answer, unlike `/api/health`, which is a liveness literal.
    const [dbOk, queueOk] = await Promise.all([ctx.health.database(), ctx.health.queue()]);
    return {
      status: dbOk && queueOk ? "ok" : "degraded",
      checks: {
        database: dbOk ? "ok" : "unreachable",
        queue: queueOk ? "ok" : "unreachable",
        scanner: ctx.scanner ? "configured" : "not_configured",
        sandbox: ctx.sandbox.isolation,
        semanticEmbeddings: ctx.semanticEmbeddingsAvailable,
        imageGeneration: ctx.imageGenerationAvailable,
        videoGeneration: ctx.videoGenerationAvailable,
      },
    };
  });

  /**
   * Prometheus scrape — docs/20_OBSERVABILITY.md §2.1, ADR-082.
   *
   * System-admin only, for the same reason as every other `/admin` route AND one specific to
   * this one: the exposition carries token and cost counters. `PrometheusExporter` would have
   * served these on an unauthenticated :9464 by default, publishing spend to anyone who could
   * reach the port; collecting on demand and serving here means one port and one auth model.
   *
   * Returns 503 rather than an empty body when metrics were never initialised — a scrape that
   * silently returns nothing looks identical to a system where nothing has happened, and a
   * monitoring system would record flat zeroes instead of an outage.
   */
  app.get("/api/v1/admin/metrics", async (request, reply) => {
    requireSystemAdmin(request);
    const exposition = await scrapeMetrics();
    if (exposition === null) {
      throw new ServiceUnavailableError("Metrics are not initialised in this process.");
    }
    // The content type Prometheus expects; a scraper given `application/json` ignores the body.
    return reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8").send(exposition);
  });

  app.get("/api/v1/admin/stats", async (request) => {
    requireSystemAdmin(request);
    return { stats: await ctx.health.stats() };
  });
}

/**
 * Permissions this module requires, exported so a test can assert the surface is protected.
 *
 * `"system-admin"` is not a `Permission` — the RBAC permission set is project-scoped by
 * construction (ADR-049), and a system administrator is a property of the USER, checked by
 * `requireSystemAdmin` rather than granted through a project role. It is spelled out here anyway
 * so this table describes the whole surface: a route missing from it reads as unprotected, and
 * silently omitting the admin routes would make the strongest guard the least visible.
 */
export const PLATFORM_ROUTE_PERMISSIONS: Record<string, Permission | "system-admin"> = {
  "GET /api/v1/models": "project:read",
  "GET /api/v1/providers": "project:read",
  "GET /api/v1/tools": "project:read",
  // ADR-089: system-admin, not `tools:manage` — the registry is process-global, so a
  // project-scoped permission governed a deployment-wide mutation.
  "POST /api/v1/tools/:id/enable": "system-admin",
  "GET /api/v1/mcp": "project:read",
  "POST /api/v1/mcp/:id/reconnect": "mcp:manage",
  "GET /api/v1/jobs": "project:read",
  "POST /api/v1/jobs/:queue/:id/cancel": "project:write",
};
