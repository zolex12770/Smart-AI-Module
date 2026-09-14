import type { FastifyInstance } from "fastify";
import {
  audioGenerationRequestSchema,
  NotFoundError,
  PermissionError,
  QuotaExceededError,
  CapabilityUnavailableError,
  ValidationError,
  type AuthContext,
} from "@ai-platform/shared";
import { v4 as uuid } from "uuid";
import type { AppContext } from "../../context.js";
import { requireProject } from "../../plugins/auth.js";

/**
 * Speech generation — docs/26_DECISIONS.md ADR-114.
 *
 * Text-to-speech existed only inside the long-form video pipeline, so a user could not ask this
 * platform for audio at all. These routes make it a capability in its own right, with the same
 * shape as image generation: the request records a row and enqueues a job, the worker synthesises,
 * stores and measures the result, and the bytes come back through the one asset route that checks
 * tenancy (`GET /api/v1/assets/:id`).
 *
 * Nothing here calls a synthesiser inline. A minute of narration is a minute of work, and an HTTP
 * request is the wrong place to hold it.
 */
export const AUDIO_UNAVAILABLE =
  "Audio generation is not available on this deployment: no speech provider is configured. Set SPEECH_PROVIDER (piper on a server, sapi on Windows, or openai for an HTTP synthesiser) to enable it. Nothing was queued.";

/** Narrows the project scope `requireProject` always sets — see the identical helper in rag.ts. */
function scopeOf(authCtx: AuthContext): string {
  if (!authCtx.projectId) throw new PermissionError("This request is not scoped to a project.");
  return authCtx.projectId;
}

export function registerAudioRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    "/api/v1/audio",
    // docs/13 §4 Layer 2: synthesis is per-character work on a worker, and a hosted synthesiser
    // bills per character. The same cap as image generation, for the same reason.
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      // Spending is an editor-and-above action, so it names `media:generate`.
      const authCtx = await requireProject(request, ctx.auth, "media:generate");
      const projectId = scopeOf(authCtx);

      // Refuse before doing anything (ADR-045): queueing a job no worker is registered for
      // would leave the caller polling a `pending` row forever.
      if (!ctx.audioGenerationAvailable) throw new CapabilityUnavailableError(AUDIO_UNAVAILABLE);

      const parsed = audioGenerationRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      // FR-063 — checked before the job exists, in the unit speech is billed in. The project
      // comes from the authenticated scope, never from the request body.
      const quotaCheck = await ctx.quota.checkSpeechCharacters(projectId, parsed.data.text.length);
      if (!quotaCheck.allowed) throw new QuotaExceededError(quotaCheck.reason ?? "Speech quota exceeded.");

      const id = uuid();
      const generation = await ctx.audioGenerations.create({
        id,
        projectId,
        // Who asked, from the credential — the row and its usage are attributable afterwards.
        createdByUserId: authCtx.user.id,
        request: parsed.data,
      });
      await ctx.jobQueue.enqueue("audio.generate", {
        generationId: id,
        // Not for the worker (it re-reads the row): this is what makes the job visible to its
        // owner through GET /api/v1/jobs, and what attributes the spend (ADR-072).
        projectId,
        userId: authCtx.user.id,
        requestId: request.id,
      });
      reply.status(202).send({ generation });
    }
  );

  app.get("/api/v1/audio", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    return { generations: await ctx.audioGenerations.list(scopeOf(authCtx)) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/audio/:id", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    const generation = await ctx.audioGenerations.get(scopeOf(authCtx), request.params.id);
    // Another tenant's id is reported exactly like one that does not exist (ADR-049).
    if (!generation) throw new NotFoundError(`Audio generation "${request.params.id}" not found.`);
    return { generation };
  });

  /**
   * Cooperative cancellation (docs/07 §1.5). This records the REQUEST; the worker settles the
   * row. A generation already inside a synthesiser has to notice and stop, and claiming a
   * terminal state the worker has not reached would be a lie the interface would then show.
   */
  app.post<{ Params: { id: string } }>("/api/v1/audio/:id/cancel", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "media:generate");
    const projectId = scopeOf(authCtx);
    const generation = await ctx.audioGenerations.get(projectId, request.params.id);
    if (!generation) throw new NotFoundError(`Audio generation "${request.params.id}" not found.`);
    const cancelled = await ctx.audioGenerations.requestCancel(projectId, request.params.id);
    return { ok: true, alreadyRequested: !cancelled };
  });
}
