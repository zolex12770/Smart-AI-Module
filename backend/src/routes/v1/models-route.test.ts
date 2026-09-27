import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { ModelRegistry } from "@ai-platform/model-router";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * `GET /api/v1/models` is what the chat screen reads to say which model answers. A development
 * process with no model configured has an empty registry — a normal state, which boots with a
 * warning — and the route called `registry.getDefault()` unconditionally, which throws there, so
 * the screen got a 500 instead of "no model configured".
 */
describe("GET /api/v1/models", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;
  let auth: Awaited<ReturnType<typeof buildTestApp>>["auth"];

  beforeEach(async () => {
    ({ app, db, ctx, auth } = await buildTestApp());
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  it("names the default model when one is registered", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/models", headers: auth.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { models: Array<{ provider: string; isDefault: boolean }>; default: string | null };
    expect(body.default).toBe(body.models.find((m) => m.isDefault)?.provider);
  });

  it("answers an empty list and a null default when no model is configured, not a 500", async () => {
    ctx.registry = new ModelRegistry();
    const res = await app.inject({ method: "GET", url: "/api/v1/models", headers: auth.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ models: [], default: null });
  });
});
