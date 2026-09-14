import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * Cancelling media work — docs/26_DECISIONS.md ADR-122.
 *
 * The repositories recorded cancellations and the statuses existed; no route ever called them, so
 * a user who started a 900-scene video had no way to stop it and the `cancelled` state could never
 * occur. These cover the route half: who may cancel, what another tenant sees, and that the route
 * records a REQUEST rather than claiming a state the worker has not reached.
 */
describe("media cancellation routes", () => {
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

  const ABSENT = "7d8f3c2e-1b4a-4c6d-9e8f-0a1b2c3d4e5f";

  it("records a cancellation for an image generation, once", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/images",
      headers: auth.headers,
      payload: { prompt: "a harbour at dawn" },
    });
    expect(created.statusCode).toBe(202);
    const { generation } = created.json() as { generation: { id: string } };

    const first = await app.inject({ method: "POST", url: `/api/v1/images/${generation.id}/cancel`, headers: auth.headers });
    expect(first.json()).toEqual({ ok: true, alreadyRequested: false });
    const second = await app.inject({ method: "POST", url: `/api/v1/images/${generation.id}/cancel`, headers: auth.headers });
    expect(second.json()).toEqual({ ok: true, alreadyRequested: true });

    const row = await ctx.imageGenerations.get(auth.projectId, generation.id);
    expect(row?.cancelRequestedAt).toBeInstanceOf(Date);
    // The route does not claim the terminal state — the worker settles it (docs/07 §1.5).
    expect(row?.status).toBe("pending");
  });

  it("records a cancellation for a video project, once", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/videos",
      headers: auth.headers,
      payload: { prompt: "a harbour at dawn", targetDurationSeconds: 8, sceneClipSeconds: 4 },
    });
    expect(created.statusCode).toBe(202);
    const { project } = created.json() as { project: { id: string } };

    const first = await app.inject({ method: "POST", url: `/api/v1/videos/${project.id}/cancel`, headers: auth.headers });
    expect(first.json()).toEqual({ ok: true, alreadyRequested: false });
    const second = await app.inject({ method: "POST", url: `/api/v1/videos/${project.id}/cancel`, headers: auth.headers });
    expect(second.json()).toEqual({ ok: true, alreadyRequested: true });

    const row = await ctx.videoProjects.get(auth.projectId, project.id);
    expect(row?.cancelRequestedAt).toBeInstanceOf(Date);
  });

  it("answers 404 for another tenant's id, and 401 without a credential", async () => {
    expect(
      (await app.inject({ method: "POST", url: `/api/v1/images/${ABSENT}/cancel`, headers: auth.headers })).statusCode
    ).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: `/api/v1/videos/${ABSENT}/cancel`, headers: auth.headers })).statusCode
    ).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/v1/images/${ABSENT}/cancel` })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/api/v1/videos/${ABSENT}/cancel` })).statusCode).toBe(401);
  });
});
