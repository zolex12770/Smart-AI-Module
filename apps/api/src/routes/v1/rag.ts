import { basename, extname } from "node:path";
import type { FastifyInstance } from "fastify";
import { NotFoundError, ServiceUnavailableError, ValidationError } from "@ai-platform/shared";
import { createPendingDocument, createPendingUploadedDocument, sniffDocumentBytes, UPLOAD_ALLOWED_TYPES } from "@ai-platform/rag";
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
    // docs/20_OBSERVABILITY.md §3.2 — see routes/v1/images.ts for why.
    await ctx.jobQueue.enqueue("document.ingest", { documentId: document.id, requestId: request.id });
    reply.status(202).send({ document });
  });

  // Real file upload (docs/15's "POST (upload)", docs/26_DECISIONS.md ADR-041) — the flow that
  // works on a stateless Cloud Run instance, where there is no sandbox directory for the
  // path-based route above to point at. Every docs/13 §12 control is applied here, in order:
  // allow-list by extension (only what packages/rag can actually parse), declared MIME
  // checked against that extension, a hard size cap (the multipart plugin's own limit, a
  // real 413), a real CONTENT sniff (not just the header), and "rename on upload" — the
  // bytes are stored under a generated key by the AssetStore, the original filename is
  // reduced to a basename and kept for display only. NOT done: malware scanning / the
  // quarantine-bucket promotion docs/13 §12 also calls for — tracked openly in docs/27.
  app.post(
    "/api/v1/files/upload",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      // ADR-042 fail-closed switch, checked before reading a single byte of the upload.
      if (!ctx.scanner && ctx.uploadScanRequired) {
        throw new ServiceUnavailableError("Uploads require malware scanning, but no scanner is configured on this deployment.");
      }

      const part = await request.file();
      if (!part) throw new ValidationError('Multipart body must include a "file" field.');

      const originalName = basename(part.filename ?? "").trim();
      const ext = extname(originalName).toLowerCase();
      const allowedMimes = UPLOAD_ALLOWED_TYPES[ext];
      if (!allowedMimes) {
        throw new ValidationError(
          `Unsupported file type "${ext || "(none)"}". Allowed: ${Object.keys(UPLOAD_ALLOWED_TYPES).join(", ")}.`
        );
      }
      if (!allowedMimes.includes(part.mimetype)) {
        throw new ValidationError(`Declared content type "${part.mimetype}" is not valid for a ${ext} file.`);
      }

      // Throws the plugin's own 413 (FST_REQ_FILE_TOO_LARGE) if the size cap is exceeded.
      const bytes = await part.toBuffer();
      if (bytes.length === 0) throw new ValidationError("Uploaded file is empty.");
      const sniff = sniffDocumentBytes(ext, bytes);
      if (!sniff.ok) throw new ValidationError(`Rejected: ${sniff.reason}`);

      const assetId = await ctx.assetStore.store(bytes, allowedMimes[0], ext.slice(1), "document");

      // ADR-042: with a scanner configured the document is held in `scanning` (never ingested,
      // never served) until the worker's document.scan job clears it; without one it goes
      // straight to ingestion carrying a durable `skipped_no_scanner` mark — visible in the
      // row and the API, never silently equivalent to "scanned clean".
      if (ctx.scanner) {
        const document = await createPendingUploadedDocument(ctx.documents, { filename: originalName, assetId, scanStatus: "pending" });
        await ctx.jobQueue.enqueue("document.scan", { documentId: document.id, requestId: request.id });
        reply.status(202).send({ document });
        return;
      }
      const document = await createPendingUploadedDocument(ctx.documents, { filename: originalName, assetId, scanStatus: "skipped_no_scanner" });
      await ctx.jobQueue.enqueue("document.ingest", { documentId: document.id, requestId: request.id });
      reply.status(202).send({ document });
    }
  );

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
