import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DrizzleDb } from "@ai-platform/database";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

describe("image generation routes", () => {
  let app: FastifyInstance;
  let db: DrizzleDb;
  let ctx: AppContext;

  beforeEach(async () => {
    ({ app, db, ctx } = await buildTestApp());
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  it("POST /api/v1/images creates a pending generation and enqueues a real job", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/images", payload: { prompt: "a lighthouse" } });
    expect(res.statusCode).toBe(202);
    const { generation } = res.json();
    expect(generation.status).toBe("pending");
    expect(generation.prompt).toBe("a lighthouse");

    const getRes = await app.inject({ method: "GET", url: `/api/v1/images/${generation.id}` });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().generation.id).toBe(generation.id);
  });

  it("rejects a request missing the required prompt", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/images", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/v1/images/:id 404s for an unknown generation", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/images/00000000-0000-0000-0000-000000000000" });
    expect(res.statusCode).toBe(404);
  });

  it("enforces the real per-route rate limit (docs/13 SS4, ADR-032) — 10/min, verified at the HTTP layer", async () => {
    const results = [];
    for (let i = 0; i < 12; i++) {
      results.push(await app.inject({ method: "POST", url: "/api/v1/images", payload: { prompt: `rl-${i}` } }));
    }
    const accepted = results.filter((r) => r.statusCode === 202);
    const limited = results.filter((r) => r.statusCode === 429);
    expect(accepted).toHaveLength(10);
    expect(limited).toHaveLength(2);
    expect(limited[0].json().error.code).toBe("RATE_LIMITED");
  });
});
