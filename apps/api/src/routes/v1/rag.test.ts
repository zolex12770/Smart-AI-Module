import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DrizzleDb } from "@ai-platform/database";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

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
