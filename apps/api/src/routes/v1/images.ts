import type { FastifyInstance } from "fastify";
import {
  imageGenerationRequestSchema,
  NotFoundError,
  PermissionError,
  QuotaExceededError,
  ServiceUnavailableError,
  ValidationError,
  type AuthContext,
} from "@ai-platform/shared";
import { v4 as uuid } from "uuid";
import type { AppContext } from "../../context.js";
import { requireProject } from "../../plugins/auth.js";

/**
 * Image generation + asset serving — docs/15_API_ARCHITECTURE.md,
 * docs/05_IMAGE_GENERATION_RESEARCH.md. Mock-only (docs/26_DECISIONS.md ADR-009) but
 * genuinely async end to end: this route only creates the record and enqueues the job,
 * it never calls the provider inline.
 *
 * Every route here is scoped to the caller's project (ADR-049). The asset-serving route is
 * the one that changed most: it used to take a bare UUID and hand back the bytes, which made
 * "knows an id" equivalent to "may read it" across every tenant on the deployment.
 */
export const MEDIA_UNAVAILABLE =
  "Image and video generation are mock-only (docs/26_DECISIONS.md ADR-009) and a mock provider may not serve production traffic (ADR-013), so this deployment has no provider for it. Nothing was queued.";

/**
 * Narrows the project scope `requireProject` always sets. See the identical helper in
 * rag.ts for why this is a checked function and not a `!` assertion: an `undefined` that
 * reached a repository would widen its `WHERE` instead of failing the request.
 */
function scopeOf(authCtx: AuthContext): string {
  if (!authCtx.projectId) throw new PermissionError("This request is not scoped to a project.");
  return authCtx.projectId;
}

export function registerImageRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    "/api/v1/images",
    // docs/13_SECURITY_ARCHITECTURE.md §4 Layer 2 (per-resource consumption caps) — image
    // generation is the most expensive endpoint the mock provider stands in for; a real
    // provider bills per call, so this cap exists even though the mock itself is cheap.
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      // Spending money is an editor-and-above action, so it names `media:generate` rather
      // than the `project:write` a viewer-adjacent write would use.
      const authCtx = await requireProject(request, ctx.auth, "media:generate");
      const projectId = scopeOf(authCtx);

      // ADR-045 — refuse before doing anything, the same shape as the upload route's
      // fail-closed 503: queueing a job no worker is registered for would leave the caller
      // polling a `pending` generation forever.
      if (!ctx.mediaGenerationAvailable) throw new ServiceUnavailableError(MEDIA_UNAVAILABLE);

      const parsed = imageGenerationRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      // FR-063 — checked before the job is even created, per docs/22_COST_AND_QUOTA_STRATEGY.md.
      // The project comes from the authenticated scope, never from the request: a quota check
      // that took a caller-supplied tenant would let anyone spend against someone else's
      // budget, and one that took no tenant at all would budget the platform as a single user.
      const quotaCheck = await ctx.quota.checkImageGeneration(projectId);
      if (!quotaCheck.allowed) throw new QuotaExceededError(quotaCheck.reason ?? "Image generation quota exceeded.");

      const id = uuid();
      const generation = await ctx.imageGenerations.create({
        id,
        projectId,
        // Who asked for it, from the credential — the row is attributable after the fact.
        createdByUserId: authCtx.user.id,
        request: parsed.data,
      });
      // docs/20_OBSERVABILITY.md §3.2 — propagate the originating request's id into the job
      // payload so the worker's logs (apps/api/src/index.ts's `runJob`) can be correlated
      // back to this request, the "API → worker → provider-call" trail the Phase 12 exit
      // criterion asks for.
      await ctx.jobQueue.enqueue("image.generate", { generationId: id, requestId: request.id });
      reply.status(202).send({ generation });
    }
  );

  app.get("/api/v1/images", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    return { generations: await ctx.imageGenerations.list(scopeOf(authCtx)) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/images/:id", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    const generation = await ctx.imageGenerations.get(scopeOf(authCtx), request.params.id);
    if (!generation) throw new NotFoundError(`Image generation "${request.params.id}" not found.`);
    return { generation };
  });

  /**
   * Asset bytes. Two controls stack here, and they answer different questions.
   *
   * 1. **Tenancy (ADR-049, an audit finding).** This route used to be unauthenticated and
   *    unscoped: `assets.get(id)` by bare UUID. Anyone who learned or guessed an id — from a
   *    log, a shared link, a leaked payload — could pull down any other tenant's generated
   *    image, rendered video or uploaded document. The scoped read puts `project_id` in the
   *    `WHERE`, so an asset belonging to another project is simply not there. Note the
   *    consequence for an asset whose `project_id` was never stamped: it is not served to
   *    anyone. That is the fail-closed direction, and the right one — bytes nothing can
   *    attribute to a tenant are exactly what must not be handed out on a guessed id.
   * 2. **The ADR-042 serve-gate.** An uploaded document's bytes are never handed out while
   *    its malware scan is pending or after it was rejected. 404, not 403 — the existence of
   *    a quarantined file is not confirmed either way.
   */
  app.get<{ Params: { id: string } }>("/api/v1/assets/:id", async (request, reply) => {
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    const projectId = scopeOf(authCtx);
    const asset = await ctx.assets.get(projectId, request.params.id);
    if (!asset) throw new NotFoundError(`Asset "${request.params.id}" not found.`);

    if (asset.kind === "document") {
      const document = await ctx.documents.findByAssetId(projectId, asset.id);
      if (!document || document.status === "scanning" || document.status === "rejected") {
        throw new NotFoundError(`Asset "${request.params.id}" not found.`);
      }
    }
    // Through the store, never `readFile(asset.storagePath)` — the path may be a gs:// URI
    // (docs/26_DECISIONS.md ADR-040). Serving bytes through the API rather than redirecting
    // to a signed URL keeps the frontend's `<img src>` contract and CORS story unchanged;
    // signed URLs are a real later optimization once assets get large, not needed today.
    const bytes = await ctx.assetStore.read(asset);
    // docs/13 §12: never render user-uploaded content inline. Generated images/clips are
    // ours and are meant to display in <img>; an uploaded document (ADR-041) is served as
    // a download, under its generated id, never under the user-supplied filename.
    if (asset.kind === "document") {
      reply.header("content-disposition", `attachment; filename="${asset.id}"`);
    }
    reply.header("content-type", asset.mimeType).header("content-length", asset.sizeBytes).send(bytes);
  });
}
