import type { FastifyInstance } from "fastify";
import { createVideoProject, orchestrateVideoProject, type VideoProjectScope } from "@ai-platform/media";
import {
  NotFoundError,
  PermissionError,
  QuotaExceededError,
  CapabilityUnavailableError,
  ValidationError,
  videoProjectRequestSchema,
  type AuthContext,
} from "@ai-platform/shared";
import { v4 as uuid } from "uuid";
import type { AppContext } from "../../context.js";
import { requireProject } from "../../plugins/auth.js";
import { VIDEO_UNAVAILABLE } from "./images.js";

/**
 * Long-form video — docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md Part 2, ADR-030/ADR-053.
 *
 * Every route resolves a `VideoProjectScope` before it touches anything: the tenant project
 * from the credential plus the video project from the path. That pair is what the scoped
 * repositories and the orchestration helpers take, and it is why a video project id from
 * another tenant now resolves to "not found" instead of to a row this handler would have to
 * be trusted to reject. Scenes carry no `project_id` of their own — they inherit tenancy
 * through a NOT NULL FK to their parent — so they are always read through that same scope
 * (ADR-049).
 */

/** See rag.ts for why this is a checked narrowing rather than a `!` assertion. */
function scopeOf(authCtx: AuthContext): string {
  if (!authCtx.projectId) throw new PermissionError("This request is not scoped to a project.");
  return authCtx.projectId;
}

export function registerVideoRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    "/api/v1/videos",
    // docs/13_SECURITY_ARCHITECTURE.md §4 Layer 2 — a long-form video fans out into many
    // per-scene generation jobs (docs/07 §1.6), the most resource-intensive single request
    // shape in the platform; capped tighter than images accordingly.
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      // Spending provider budget is an editor-and-above action, so the route names
      // `media:generate` rather than the `project:write` a plain content write would use.
      const authCtx = await requireProject(request, ctx.auth, "media:generate");
      const projectId = scopeOf(authCtx);

      const parsed = videoProjectRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      // ADR-045 — see images.ts. Unchanged by ADR-075's real provider: a deployment that has
      // configured none still refuses here rather than queueing scenes no worker will run.
      if (!ctx.videoGenerationAvailable) throw new CapabilityUnavailableError(VIDEO_UNAVAILABLE);

      // FR-063 — the whole project's requested duration is checked against the monthly
      // budget up front (docs/22_COST_AND_QUOTA_STRATEGY.md's long-form-video special case:
      // "a bad estimate has real consequence... the UI must show this... before the job is
      // enqueued"), not per scene as each one starts. Charged against the authenticated
      // project, never a caller-supplied one.
      const quotaCheck = await ctx.quota.checkVideoSeconds(projectId, parsed.data.targetDurationSeconds);
      if (!quotaCheck.allowed) throw new QuotaExceededError(quotaCheck.reason ?? "Video-seconds quota exceeded.");

      const scope: VideoProjectScope = { projectId, videoProjectId: uuid() };
      const project = await createVideoProject(
        { projectRepo: ctx.videoProjects, sceneRepo: ctx.videoScenes },
        {
          ...scope,
          // Attribution from the credential, never from the body (ADR-049).
          createdByUserId: authCtx.user.id,
          request: parsed.data,
        }
      );
      // docs/20_OBSERVABILITY.md §3.2 — see the matching comment in video-orchestration.ts
      // for how this id then reaches every scene job and the eventual render job.
      await orchestrateVideoProject(
        { projectRepo: ctx.videoProjects, sceneRepo: ctx.videoScenes, jobQueue: ctx.jobQueue },
        scope,
        request.id
      );

      reply.status(202).send({ project });
    }
  );

  app.get("/api/v1/videos", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    return { projects: await ctx.videoProjects.list(scopeOf(authCtx)) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/videos/:id", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    const projectId = scopeOf(authCtx);
    const project = await ctx.videoProjects.get(projectId, request.params.id);
    if (!project) throw new NotFoundError(`Video project "${request.params.id}" not found.`);
    const scenes = await ctx.videoScenes.listByVideoProject({ projectId, videoProjectId: project.id });
    return { project, scenes: scenes.sort((a, b) => a.sceneIndex - b.sceneIndex) };
  });

  /**
   * Resumability (docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md §2.3): re-running orchestration
   * only (re-)submits scenes that still need a generation attempt — this is the "fix scene
   * 37, only scene 37 regenerates" mechanism, exposed as an explicit user action.
   *
   * Two audit findings are closed here. The route now names `media:generate` and resolves the
   * project by `(project_id, id)`, so another tenant's video can no longer be made to spend
   * provider budget by anyone who knows its id. And it carries the same ADR-045 guard the
   * create route always had: without it, a deployment with no media provider accepted a retry
   * and re-enqueued scene jobs that no worker was registered to run, leaving the caller
   * polling a project that could never move.
   */
  app.post<{ Params: { id: string } }>("/api/v1/videos/:id/retry", async (request, reply) => {
    const authCtx = await requireProject(request, ctx.auth, "media:generate");
    const projectId = scopeOf(authCtx);
    if (!ctx.videoGenerationAvailable) throw new CapabilityUnavailableError(VIDEO_UNAVAILABLE);

    // Resolved here, before orchestration, so an unknown or cross-tenant id is a clean 404
    // rather than the orchestrator's internal "unknown video project" throw surfacing as 500.
    const project = await ctx.videoProjects.get(projectId, request.params.id);
    if (!project) throw new NotFoundError(`Video project "${request.params.id}" not found.`);

    const scope: VideoProjectScope = { projectId, videoProjectId: project.id };
    await orchestrateVideoProject(
      { projectRepo: ctx.videoProjects, sceneRepo: ctx.videoScenes, jobQueue: ctx.jobQueue },
      scope,
      request.id
    );
    reply.status(202).send({ project: await ctx.videoProjects.get(projectId, project.id) });
  });
}
