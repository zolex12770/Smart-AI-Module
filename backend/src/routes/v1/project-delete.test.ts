import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { v4 as uuid } from "uuid";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * Deleting a project stops its work — audit finding 11, docs/DECISION_LOG.md DL-9.
 *
 * The route only stamped `deletedAt`. Queued image, speech and video jobs still ran against
 * paid providers, a running agent task kept calling the model, and the agent's workspace stayed
 * on disk with nothing able to reach it. Account deletion already cleaned all three up; project
 * deletion, the more common act, did not.
 */
describe("DELETE /api/v1/projects/:projectId", () => {
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

  it("cancels the project's queued jobs and open tasks, and removes its workspace", async () => {
    // A second project: an organization's last project cannot be deleted.
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: auth.headers,
      payload: { name: "Doomed" },
    });
    expect(created.statusCode).toBe(201);
    const projectId = (created.json() as { project: { id: string } }).project.id;
    const headers = { ...auth.headers, "x-project-id": projectId };

    await ctx.jobQueue.ensureQueue("image.generate");
    const jobId = (await ctx.jobQueue.enqueue("image.generate", { projectId, generationId: "g1" }))!;
    const task = await ctx.tasks.create({ id: uuid(), projectId, taskType: "autonomous", input: { goal: "x" } });
    const survivor = await ctx.tasks.create({ id: uuid(), projectId: auth.projectId, taskType: "autonomous", input: { goal: "y" } });
    // Media: one waiting in the queue, one a worker is running.
    const request = { prompt: "a lighthouse", aspectRatio: "1:1" as const, quality: "fast" as const };
    const queued = await ctx.imageGenerations.create({ id: uuid(), projectId, createdByUserId: auth.userId, request });
    const running = await ctx.imageGenerations.create({ id: uuid(), projectId, createdByUserId: auth.userId, request });
    await ctx.imageGenerations.updateStatus(projectId, running.id, "processing", {});
    const workspace = join(ctx.sandboxRoot, projectId);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "notes.txt"), "agent output");

    const res = await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}`, headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, stopped: { queuedJobs: 1, tasks: 1, media: 2, workspaceRemoved: true }, notStopped: [] });

    expect((await ctx.jobQueue.getJob("image.generate", jobId))?.state).toBe("cancelled");
    expect((await ctx.tasks.getUnscoped(task.id))?.state).toBe("CANCELLED");
    expect(existsSync(workspace)).toBe(false);
    // The queued one is settled (nothing else ever would); the running one is asked to stop, which
    // is what its worker's cancellation watch reads (DL-18).
    expect((await ctx.imageGenerations.get(projectId, queued.id))?.status).toBe("cancelled");
    expect((await ctx.imageGenerations.get(projectId, running.id))?.cancelRequestedAt).toBeTruthy();
    // Another project's work is untouched.
    expect((await ctx.tasks.getUnscoped(survivor.id))?.state).not.toBe("CANCELLED");
  });
});
