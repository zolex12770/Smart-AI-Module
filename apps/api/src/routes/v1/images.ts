import type { FastifyInstance } from "fastify";
import { imageGenerationRequestSchema, NotFoundError, QuotaExceededError, ValidationError } from "@ai-platform/shared";
import { v4 as uuid } from "uuid";
import type { AppContext } from "../../context.js";

/**
 * Image generation + asset serving — docs/15_API_ARCHITECTURE.md,
 * docs/05_IMAGE_GENERATION_RESEARCH.md. Mock-only (docs/26_DECISIONS.md ADR-009) but
 * genuinely async end to end: this route only creates the record and enqueues the job,
 * it never calls the provider inline.
 */
export function registerImageRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    "/api/v1/images",
    // docs/13_SECURITY_ARCHITECTURE.md §4 Layer 2 (per-resource consumption caps) — image
    // generation is the most expensive endpoint the mock provider stands in for; a real
    // provider bills per call, so this cap exists even though the mock itself is cheap.
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = imageGenerationRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      // FR-063 — checked before the job is even created, per docs/22_COST_AND_QUOTA_STRATEGY.md.
      const quotaCheck = await ctx.quota.checkImageGeneration();
      if (!quotaCheck.allowed) throw new QuotaExceededError(quotaCheck.reason ?? "Image generation quota exceeded.");

      const id = uuid();
      const generation = await ctx.imageGenerations.create(id, parsed.data);
      // docs/20_OBSERVABILITY.md §3.2 — propagate the originating request's id into the job
      // payload so the worker's logs (apps/api/src/index.ts's `runJob`) can be correlated
      // back to this request, the "API → worker → provider-call" trail the Phase 12 exit
      // criterion asks for.
      await ctx.jobQueue.enqueue("image.generate", { generationId: id, requestId: request.id });
      reply.status(202).send({ generation });
    }
  );

  app.get("/api/v1/images", async () => ({ generations: await ctx.imageGenerations.list() }));

  app.get<{ Params: { id: string } }>("/api/v1/images/:id", async (request) => {
    const generation = await ctx.imageGenerations.get(request.params.id);
    if (!generation) throw new NotFoundError(`Image generation "${request.params.id}" not found.`);
    return { generation };
  });

  app.get<{ Params: { id: string } }>("/api/v1/assets/:id", async (request, reply) => {
    const asset = await ctx.assets.get(request.params.id);
    if (!asset) throw new NotFoundError(`Asset "${request.params.id}" not found.`);
    // ADR-042 serve-gate: an uploaded document's bytes are never handed out while the scan
    // is pending or after it was rejected. 404, not 403 — existence isn't confirmed either way.
    if (asset.kind === "document") {
      const document = await ctx.documents.findByAssetId(asset.id);
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
