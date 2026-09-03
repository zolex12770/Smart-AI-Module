import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DrizzleDb } from "@ai-platform/database";
import { processDocumentIngestion, searchDocuments } from "@ai-platform/rag";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";
import { UPLOAD_MAX_BYTES } from "../../server.js";

/** A real multipart body via the platform FormData/Blob — Fastify's inject() streams it
 * with a real boundary (light-my-request's form-data support), so the route sees exactly
 * what a browser sends. */
function upload(app: FastifyInstance, filename: string, bytes: Buffer | string, type: string) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), filename);
  return app.inject({ method: "POST", url: "/api/v1/files/upload", payload: form });
}

describe("files (RAG ingestion) + memory routes", () => {
  let app: FastifyInstance;
  let db: DrizzleDb;
  let ctx: AppContext;

  beforeEach(async () => {
    ({ app, db, ctx } = await buildTestApp());
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  it("POST /api/v1/files ingests a real sandbox file as a pending document and enqueues a job", async () => {
    writeFileSync(join(ctx.sandboxRoot, "handbook.txt"), "vacation policy: 15 days a year");
    const res = await app.inject({ method: "POST", url: "/api/v1/files", payload: { path: "handbook.txt" } });
    expect(res.statusCode).toBe(202);
    expect(res.json().document.status).toBe("ingesting");

    const listRes = await app.inject({ method: "GET", url: "/api/v1/files" });
    expect(listRes.json().documents.some((d: { filename: string }) => d.filename === "handbook.txt")).toBe(true);
  });

  it("POST /api/v1/files rejects a missing path", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/files", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  describe("POST /api/v1/files/upload — real multipart upload into the AssetStore (ADR-041, docs/13 §12)", () => {
    it("accepts a real text upload, stores it under a generated key, and the SAME ingest job then makes it retrievable", async () => {
      const res = await upload(app, "remote-work-policy.txt", "Remote work: employees may work remotely three days per week.", "text/plain");
      expect(res.statusCode).toBe(202);
      const { document } = res.json();
      expect(document.status).toBe("ingesting");
      expect(document.filename).toBe("remote-work-policy.txt");
      expect(document.sourcePath).toBeNull();
      expect(typeof document.assetId).toBe("string");

      // The bytes live in the asset store under the generated id, not under the filename.
      const asset = await ctx.assets.get(document.assetId);
      expect(asset).toBeDefined();
      expect(asset!.kind).toBe("document");
      expect(asset!.storagePath).not.toContain("remote-work-policy");

      // The test app registers no job workers (test-app.ts), so drive the real ingestion
      // step directly with the real deps the worker would use — real asset-store read, real
      // chunking, real embeddings, real pgvector write.
      const row = await ctx.documents.get(document.id);
      await processDocumentIngestion(
        {
          documentRepo: ctx.documents,
          chunkRepo: ctx.documentChunks,
          embeddings: ctx.embeddings,
          sandboxRoot: ctx.sandboxRoot,
          assetRepo: ctx.assets,
          assetStore: ctx.assetStore,
        },
        row!
      );
      expect((await ctx.documents.get(document.id))!.status).toBe("ready");

      const hits = await searchDocuments({ chunkRepo: ctx.documentChunks, embeddings: ctx.embeddings }, "how many remote days per week?", 1);
      expect(hits[0]?.content).toContain("three days");
    });

    it("accepts a real PDF upload (content-sniffed) and ingests it through the real PDF parser", async () => {
      // Minimal valid PDF, same construction as packages/rag's pdf.test.ts.
      const stream = "BT /F1 18 Tf 10 150 Td (Expense receipts within thirty days) Tj ET";
      const objs = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
        "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
        `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
      ];
      let body = "%PDF-1.4\n";
      const offsets: number[] = [];
      for (const o of objs) { offsets.push(body.length); body += o; }
      const xrefStart = body.length;
      const xref = `xref\n0 6\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
      const pdf = Buffer.from(body + xref + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`, "utf8");

      const res = await upload(app, "policy.pdf", pdf, "application/pdf");
      expect(res.statusCode).toBe(202);
      const { document } = res.json();
      await processDocumentIngestion(
        { documentRepo: ctx.documents, chunkRepo: ctx.documentChunks, embeddings: ctx.embeddings, sandboxRoot: ctx.sandboxRoot, assetRepo: ctx.assets, assetStore: ctx.assetStore },
        (await ctx.documents.get(document.id))!
      );
      const row = await ctx.documents.get(document.id);
      expect(row!.status).toBe("ready");
      const hits = await searchDocuments({ chunkRepo: ctx.documentChunks, embeddings: ctx.embeddings }, "expense receipts", 1);
      expect(hits[0]?.content).toContain("thirty days");
    });

    it("rejects an extension outside the allow-list with a clear 400 (never a deny-list)", async () => {
      const res = await upload(app, "payload.exe", Buffer.from("MZ..."), "application/octet-stream");
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/Unsupported file type/);
    });

    it("rejects a declared content type that does not match the extension", async () => {
      const res = await upload(app, "notes.txt", "hello", "application/pdf");
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/not valid for a \.txt/);
    });

    it("rejects a file whose CONTENT contradicts its extension — the sniff, not the header, is the real gate", async () => {
      const res = await upload(app, "report.pdf", Buffer.from("<html>definitely not a pdf</html>"), "application/pdf");
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/PDF signature/);
    });

    it("rejects an oversized upload with a real 413 from the multipart size cap", async () => {
      const res = await upload(app, "huge.txt", Buffer.alloc(UPLOAD_MAX_BYTES + 1, 0x61), "text/plain");
      expect(res.statusCode).toBe(413);
    });

    it("rejects an empty file", async () => {
      const res = await upload(app, "empty.txt", Buffer.alloc(0), "text/plain");
      expect(res.statusCode).toBe(400);
    });

    it("serves an uploaded document back as an attachment under its generated id, never inline", async () => {
      const res = await upload(app, "handbook.md", "# Handbook\n\nbe kind", "text/markdown");
      const { document } = res.json();
      const asset = await app.inject({ method: "GET", url: `/api/v1/assets/${document.assetId}` });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-disposition"]).toContain("attachment");
      expect(asset.headers["content-disposition"]).not.toContain("handbook");
    });
  });

  describe("memory CRUD — regression coverage for two real bugs found in Phase 10 browser testing", () => {
    it("adds and lists a memory item", async () => {
      const addRes = await app.inject({
        method: "POST",
        url: "/api/v1/memory",
        payload: { scope: "user", content: "prefers dark mode" },
      });
      expect(addRes.statusCode).toBe(201);

      const listRes = await app.inject({ method: "GET", url: "/api/v1/memory" });
      expect(listRes.json().items.some((i: { content: string }) => i.content === "prefers dark mode")).toBe(true);
    });

    it("DELETE with no request body does not 400 (regression: FST_ERR_CTP_EMPTY_JSON_BODY, ADR-031)", async () => {
      const { item } = (
        await app.inject({ method: "POST", url: "/api/v1/memory", payload: { scope: "user", content: "temp" } })
      ).json();

      // A bare DELETE, no Content-Type header and no body — exactly what the frontend's
      // fixed request() helper now sends (apps/web/app/lib/api.ts), and exactly what the
      // pre-fix version got wrong by always declaring application/json.
      const deleteRes = await app.inject({ method: "DELETE", url: `/api/v1/memory/${item.id}` });
      expect(deleteRes.statusCode).toBe(200);

      const listRes = await app.inject({ method: "GET", url: "/api/v1/memory" });
      expect(listRes.json().items.some((i: { id: string }) => i.id === item.id)).toBe(false);
    });

    it("CORS preflight for DELETE is allowed (regression: @fastify/cors default methods excluded DELETE, ADR-031)", async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/api/v1/memory/some-id",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "DELETE",
        },
      });
      expect(res.statusCode).toBeLessThan(300);
      expect(res.headers["access-control-allow-methods"]).toContain("DELETE");
    });
  });
});
