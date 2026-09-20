import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgliteDb } from "@ai-platform/database";
import type { FastifyInstance } from "fastify";
import { processDocumentIngestion, processDocumentScan, searchDocuments } from "@ai-platform/rag";
import type { MalwareScanner, ScanVerdict } from "@ai-platform/scanning";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";
import { UPLOAD_MAX_BYTES } from "../../server.js";

/** A real multipart body via the platform FormData/Blob — Fastify's inject() streams it
 * with a real boundary (light-my-request's form-data support), so the route sees exactly
 * what a browser sends. */
function upload(
  app: FastifyInstance,
  headers: Record<string, string>,
  filename: string,
  bytes: Buffer | string,
  type: string
) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), filename);
  return app.inject({ headers, method: "POST", url: "/api/v1/files/upload", payload: form });
}

describe("files (RAG ingestion) + memory routes", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;
  /** Session cookie + CSRF pair + x-project-id for the seeded test user (ADR-049).
   * Every request in these suites is authenticated and project-scoped, because every real
   * request is — an unauthenticated inject would only ever assert a 401. */
  let auth: Awaited<ReturnType<typeof buildTestApp>>["auth"];

  beforeEach(async () => {
    ({ app, db, ctx, auth } = await buildTestApp());
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  it("POST /api/v1/files ingests a real sandbox file as a pending document and enqueues a job", async () => {
    writeFileSync(join(ctx.sandboxRoot, "handbook.txt"), "vacation policy: 15 days a year");
    const res = await app.inject({ headers: auth.headers, method: "POST", url: "/api/v1/files", payload: { path: "handbook.txt" } });
    expect(res.statusCode).toBe(202);
    expect(res.json().document.status).toBe("ingesting");

    const listRes = await app.inject({ headers: auth.headers, method: "GET", url: "/api/v1/files" });
    expect(listRes.json().documents.some((d: { filename: string }) => d.filename === "handbook.txt")).toBe(true);
  });

  it("POST /api/v1/files rejects a missing path", async () => {
    const res = await app.inject({ headers: auth.headers, method: "POST", url: "/api/v1/files", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  describe("POST /api/v1/files/upload — real multipart upload into the AssetStore (ADR-041, docs/13 §12)", () => {
    it("accepts a real text upload, stores it under a generated key, and the SAME ingest job then makes it retrievable", async () => {
      const res = await upload(app, auth.headers, "remote-work-policy.txt", "Remote work: employees may work remotely three days per week.", "text/plain");
      expect(res.statusCode).toBe(202);
      const { document } = res.json();
      expect(document.status).toBe("ingesting");
      expect(document.scanStatus).toBe("skipped_no_scanner"); // ADR-042: fail-open, but durably marked
      expect(document.filename).toBe("remote-work-policy.txt");
      expect(document.sourcePath).toBeNull();
      expect(typeof document.assetId).toBe("string");

      // The bytes live in the asset store under the generated id, not under the filename.
      const asset = await ctx.assets.get(auth.projectId, document.assetId);
      expect(asset).toBeDefined();
      expect(asset!.kind).toBe("document");
      expect(asset!.storagePath).not.toContain("remote-work-policy");

      // The test app registers no job workers (test-app.ts), so drive the real ingestion
      // step directly with the real deps the worker would use — real asset-store read, real
      // chunking, real embeddings, real pgvector write.
      const row = await ctx.documents.get(auth.projectId, document.id);
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
      expect((await ctx.documents.get(auth.projectId, document.id))!.status).toBe("ready");

      const hits = await searchDocuments(
        { chunkRepo: ctx.documentChunks, documentRepo: ctx.documents, embeddings: ctx.embeddings },
        { projectId: auth.projectId, query: "how many remote days per week?", topK: 1 }
      );
      expect(hits[0]?.content).toContain("three days");
    });

    it("accepts a real PDF upload (content-sniffed) and ingests it through the real PDF parser", async () => {
      // Minimal valid PDF, same construction as backend/packages/rag's pdf.test.ts.
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

      const res = await upload(app, auth.headers, "policy.pdf", pdf, "application/pdf");
      expect(res.statusCode).toBe(202);
      const { document } = res.json();
      await processDocumentIngestion(
        { documentRepo: ctx.documents, chunkRepo: ctx.documentChunks, embeddings: ctx.embeddings, sandboxRoot: ctx.sandboxRoot, assetRepo: ctx.assets, assetStore: ctx.assetStore },
        (await ctx.documents.get(auth.projectId, document.id))!
      );
      const row = await ctx.documents.get(auth.projectId, document.id);
      expect(row!.status).toBe("ready");
      const hits = await searchDocuments(
        { chunkRepo: ctx.documentChunks, documentRepo: ctx.documents, embeddings: ctx.embeddings },
        { projectId: auth.projectId, query: "expense receipts", topK: 1 }
      );
      expect(hits[0]?.content).toContain("thirty days");
    });

    it("rejects an extension outside the allow-list with a clear 400 (never a deny-list)", async () => {
      const res = await upload(app, auth.headers, "payload.exe", Buffer.from("MZ..."), "application/octet-stream");
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/Unsupported file type/);
    });

    it("rejects a declared content type that does not match the extension", async () => {
      const res = await upload(app, auth.headers, "notes.txt", "hello", "application/pdf");
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/not valid for a \.txt/);
    });

    it("rejects a file whose CONTENT contradicts its extension — the sniff, not the header, is the real gate", async () => {
      const res = await upload(app, auth.headers, "report.pdf", Buffer.from("<html>definitely not a pdf</html>"), "application/pdf");
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/PDF signature/);
    });

    it("rejects an oversized upload with a real 413 from the multipart size cap", async () => {
      const res = await upload(app, auth.headers, "huge.txt", Buffer.alloc(UPLOAD_MAX_BYTES + 1, 0x61), "text/plain");
      expect(res.statusCode).toBe(413);
    });

    it("rejects an empty file", async () => {
      const res = await upload(app, auth.headers, "empty.txt", Buffer.alloc(0), "text/plain");
      expect(res.statusCode).toBe(400);
    });

    it("serves an uploaded document back as an attachment under its generated id, never inline", async () => {
      const res = await upload(app, auth.headers, "handbook.md", "# Handbook\n\nbe kind", "text/markdown");
      const { document } = res.json();
      const asset = await app.inject({ headers: auth.headers, method: "GET", url: `/api/v1/assets/${document.assetId}` });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-disposition"]).toContain("attachment");
      expect(asset.headers["content-disposition"]).not.toContain("handbook");
    });
  });

  describe("malware scanning of uploads (ADR-042, docs/13 §12) — status-based quarantine + serve-gate", () => {
    const scripted = (verdict: ScanVerdict): MalwareScanner => ({ name: "scripted", scan: async () => verdict, ping: async () => true });
    const scanDeps = () => ({ documentRepo: ctx.documents, assetRepo: ctx.assets, assetStore: ctx.assetStore, scanner: ctx.scanner!, jobQueue: ctx.jobQueue });

    it("with a scanner configured, an upload is held in `scanning` and its asset is NOT served until the scan clears it", async () => {
      ctx.scanner = scripted({ verdict: "clean" });
      const { document } = (await upload(app, auth.headers, "held.txt", "harmless text", "text/plain")).json();
      expect(document.status).toBe("scanning");
      expect(document.scanStatus).toBe("pending");

      // Serve-gate: 404 while scanning, even though the bytes exist in the store.
      expect((await app.inject({ headers: auth.headers, method: "GET", url: `/api/v1/assets/${document.assetId}` })).statusCode).toBe(404);

      // Run the real scan job (the test app registers no workers) → clean → ingesting.
      expect(await processDocumentScan(scanDeps(), auth.projectId, document.id)).toBe("clean");
      const after = (await ctx.documents.get(auth.projectId, document.id))!;
      expect(after.status).toBe("ingesting");
      expect(after.scanStatus).toBe("clean");
      expect((await app.inject({ headers: auth.headers, method: "GET", url: `/api/v1/assets/${document.assetId}` })).statusCode).toBe(200);
    });

    it("an infected verdict rejects the document, deletes its bytes and row, and the asset route 404s forever after", async () => {
      ctx.scanner = scripted({ verdict: "infected", signature: "Eicar-Test-Signature" });
      const { document } = (await upload(app, auth.headers, "bad.txt", "pretend this is malware", "text/plain")).json();
      const assetId = document.assetId as string;
      expect(await ctx.assets.get(auth.projectId, assetId)).toBeDefined();

      expect(await processDocumentScan(scanDeps(), auth.projectId, document.id)).toBe("infected");

      const after = (await ctx.documents.get(auth.projectId, document.id))!;
      expect(after.status).toBe("rejected");
      expect(after.scanStatus).toBe("infected");
      expect(after.errorMessage).toMatch(/Eicar-Test-Signature/);
      expect(after.assetId).toBeNull();
      expect(await ctx.assets.get(auth.projectId, assetId)).toBeUndefined();
      expect((await app.inject({ headers: auth.headers, method: "GET", url: `/api/v1/assets/${assetId}` })).statusCode).toBe(404);
      // The document is still listed — an operator can see WHAT was rejected and why.
      expect((await app.inject({ headers: auth.headers, method: "GET", url: `/api/v1/files/${document.id}` })).json().document.status).toBe("rejected");
    });

    it("UPLOAD_SCAN_REQUIRED with no scanner refuses the upload with a real 503 before reading any bytes (fail-closed)", async () => {
      ctx.scanner = null;
      ctx.uploadScanRequired = true;
      const res = await upload(app, auth.headers, "anything.txt", "hello", "text/plain");
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("SERVICE_UNAVAILABLE");
      expect((await app.inject({ headers: auth.headers, method: "GET", url: "/api/v1/files" })).json().documents).toHaveLength(0);
    });
  });

  describe("memory CRUD — regression coverage for two real bugs found in Phase 10 browser testing", () => {
    it("adds and lists a memory item", async () => {
      const addRes = await app.inject({ headers: auth.headers, method: "POST",
        url: "/api/v1/memory",
        payload: { scope: "user", content: "prefers dark mode" },
      });
      expect(addRes.statusCode).toBe(201);

      const listRes = await app.inject({ headers: auth.headers, method: "GET", url: "/api/v1/memory" });
      expect(listRes.json().items.some((i: { content: string }) => i.content === "prefers dark mode")).toBe(true);
    });

    it("DELETE with no request body does not 400 (regression: FST_ERR_CTP_EMPTY_JSON_BODY, ADR-031)", async () => {
      const { item } = (
        await app.inject({ headers: auth.headers, method: "POST", url: "/api/v1/memory", payload: { scope: "user", content: "temp" } })
      ).json();

      // A bare DELETE, no Content-Type header and no body — exactly what the frontend's
      // fixed request() helper now sends (frontend/app/lib/api.ts), and exactly what the
      // pre-fix version got wrong by always declaring application/json.
      const deleteRes = await app.inject({ headers: auth.headers, method: "DELETE", url: `/api/v1/memory/${item.id}` });
      expect(deleteRes.statusCode).toBe(200);

      const listRes = await app.inject({ headers: auth.headers, method: "GET", url: "/api/v1/memory" });
      expect(listRes.json().items.some((i: { id: string }) => i.id === item.id)).toBe(false);
    });

    it("CORS preflight for DELETE is allowed (regression: @fastify/cors default methods excluded DELETE, ADR-031)", async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/api/v1/memory/some-id",
        // One `headers` key, merged. There were two, and the second silently won — so
        // `auth.headers` was dropped and this preflight was being sent unauthenticated. It
        // passed anyway, because CORS preflight is answered before authentication runs, but the
        // test was not exercising what it appeared to.
        headers: {
          ...auth.headers,
          origin: "http://localhost:3000",
          "access-control-request-method": "DELETE",
        },
      });
      expect(res.statusCode).toBeLessThan(300);
      expect(res.headers["access-control-allow-methods"]).toContain("DELETE");
    });
  });
});
