import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DrizzleDb } from "@ai-platform/database";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

describe("image generation routes", () => {
  let app: FastifyInstance;
  let db: DrizzleDb;
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

  it("POST /api/v1/images creates a pending generation and enqueues a real job", async () => {
    const res = await app.inject({ headers: auth.headers, method: "POST", url: "/api/v1/images", payload: { prompt: "a lighthouse" } });
    expect(res.statusCode).toBe(202);
    const { generation } = res.json();
    expect(generation.status).toBe("pending");
    expect(generation.prompt).toBe("a lighthouse");

    const getRes = await app.inject({ headers: auth.headers, method: "GET", url: `/api/v1/images/${generation.id}` });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().generation.id).toBe(generation.id);
  });

  it("rejects a request missing the required prompt", async () => {
    const res = await app.inject({ headers: auth.headers, method: "POST", url: "/api/v1/images", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/v1/images/:id 404s for an unknown generation", async () => {
    const res = await app.inject({ headers: auth.headers, method: "GET", url: "/api/v1/images/00000000-0000-0000-0000-000000000000" });
    expect(res.statusCode).toBe(404);
  });

  it("enforces the real per-route rate limit (docs/13 SS4, ADR-032) — 10/min, verified at the HTTP layer", async () => {
    const results = [];
    for (let i = 0; i < 12; i++) {
      results.push(await app.inject({ headers: auth.headers, method: "POST", url: "/api/v1/images", payload: { prompt: `rl-${i}` } }));
    }
    const accepted = results.filter((r) => r.statusCode === 202);
    const limited = results.filter((r) => r.statusCode === 429);
    expect(accepted).toHaveLength(10);
    expect(limited).toHaveLength(2);
    expect(limited[0].json().error.code).toBe("RATE_LIMITED");
  });

  /**
   * docs/26_DECISIONS.md ADR-045. In production there is no image/video provider at all
   * (they are mock-only per ADR-009, and ADR-013 forbids a mock serving production), so the
   * routes must refuse rather than queue work no registered worker will ever pick up —
   * which would leave the caller polling a `pending` generation forever.
   */
  it("POST /api/v1/images refuses with a real capability error when image generation is unavailable, and stores nothing", async () => {
    ctx.imageGenerationAvailable = false;

    const res = await app.inject({ headers: auth.headers, method: "POST", url: "/api/v1/images", payload: { prompt: "a lighthouse" } });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(res.json().error.message).toMatch(/no image provider is configured/);

    expect((await ctx.imageGenerations.list()).length).toBe(0);
  });

  it("POST /api/v1/videos refuses with a capability error when video generation is unavailable", async () => {
    ctx.videoGenerationAvailable = false;

    const res = await app.inject({ headers: auth.headers,
      method: "POST",
      url: "/api/v1/videos",
      payload: { prompt: "a lighthouse at dawn", targetDurationSeconds: 10 },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe("CAPABILITY_UNAVAILABLE");
  });
});
