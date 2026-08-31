import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { imageGenerationRequestSchema, NotFoundError, ValidationError } from "@ai-platform/shared";
import { v4 as uuid } from "uuid";
import type { AppContext } from "../../context.js";

/**
 * Image generation + asset serving — docs/15_API_ARCHITECTURE.md,
 * docs/05_IMAGE_GENERATION_RESEARCH.md. Mock-only (docs/26_DECISIONS.md ADR-009) but
 * genuinely async end to end: this route only creates the record and enqueues the job,
 * it never calls the provider inline.
 */
export function registerImageRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/v1/images", async (request, reply) => {
    const parsed = imageGenerationRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const id = uuid();
    const generation = await ctx.imageGenerations.create(id, parsed.data);
    await ctx.jobQueue.enqueue("image.generate", { generationId: id });
    reply.status(202).send({ generation });
  });

  app.get("/api/v1/images", async () => ({ generations: await ctx.imageGenerations.list() }));

  app.get<{ Params: { id: string } }>("/api/v1/images/:id", async (request) => {
    const generation = await ctx.imageGenerations.get(request.params.id);
    if (!generation) throw new NotFoundError(`Image generation "${request.params.id}" not found.`);
    return { generation };
  });

  app.get<{ Params: { id: string } }>("/api/v1/assets/:id", async (request, reply) => {
    const asset = await ctx.assets.get(request.params.id);
    if (!asset) throw new NotFoundError(`Asset "${request.params.id}" not found.`);
    const bytes = await readFile(asset.storagePath);
    reply.header("content-type", asset.mimeType).header("content-length", asset.sizeBytes).send(bytes);
  });
}
