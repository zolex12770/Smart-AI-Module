import type { FastifyInstance } from "fastify";
import { NotFoundError, ValidationError } from "@ai-platform/shared";
import { createPendingDocument } from "@ai-platform/rag";
import { v4 as uuid } from "uuid";
import type { AppContext } from "../../context.js";

/**
 * Document ingestion + memory endpoints — docs/15_API_ARCHITECTURE.md. No auth system
 * exists yet (docs/26_DECISIONS.md ADR-008 is Phase 1 scope, not built), so memory
 * items use a fixed single-operator owner id, consistent with docs/00_PROJECT_VISION.md's
 * stated initial single-operator/small-team scope — this is a real, if temporary,
 * simplification, not a hidden gap: multi-user ownership needs real auth first.
 */
const SINGLE_OPERATOR_OWNER_ID = "local-user";

export function registerRagRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Real async job (docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md, docs/25_IMPLEMENTATION_ROADMAP.md
  // Phase 7) — returns immediately with the document in "ingesting" status; poll
  // GET /api/v1/files/:id (or watch it complete) to see it flip to "ready"/"failed" once
  // the job worker (registered in apps/api/src/index.ts) actually processes it.
  app.post<{ Body: { path: string } }>("/api/v1/files", async (request, reply) => {
    const path = request.body?.path;
    if (!path) throw new ValidationError("Body must include a sandbox-relative \"path\".");

    const document = await createPendingDocument(ctx.documents, path);
    await ctx.jobQueue.enqueue("document.ingest", { documentId: document.id });
    reply.status(202).send({ document });
  });

  app.get("/api/v1/files", async () => ({ documents: await ctx.documents.list() }));

  app.get<{ Params: { id: string } }>("/api/v1/files/:id", async (request) => {
    const document = await ctx.documents.get(request.params.id);
    if (!document) throw new NotFoundError(`Document "${request.params.id}" not found.`);
    return { document };
  });

  app.get("/api/v1/memory", async () => ({
    items: await ctx.memoryItems.listByOwner(SINGLE_OPERATOR_OWNER_ID),
  }));

  app.post<{ Body: { scope: "conversation" | "task" | "user" | "project" | "semantic"; content: string } }>(
    "/api/v1/memory",
    async (request, reply) => {
      const { scope, content } = request.body ?? {};
      if (!scope || !content) throw new ValidationError("Body must include \"scope\" and \"content\".");
      const item = await ctx.memoryItems.create({ id: uuid(), scope, ownerId: SINGLE_OPERATOR_OWNER_ID, content });
      reply.status(201).send({ item });
    }
  );

  app.delete<{ Params: { id: string } }>("/api/v1/memory/:id", async (request) => {
    await ctx.memoryItems.delete(request.params.id);
    return { ok: true };
  });
}
