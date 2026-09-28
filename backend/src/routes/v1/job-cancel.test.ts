import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * Cancelling a job cancels what it was for — audit finding 7. The route called `boss.cancel` and
 * nothing else, so the image row stayed `pending` forever and a video scene was stranded.
 */
describe("POST /api/v1/jobs/:queue/:id/cancel", () => {
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

  const jobFor = async (queue: string) => {
    const res = await app.inject({ method: "GET", url: `/api/v1/jobs?queue=${queue}`, headers: auth.headers });
    const jobs = (res.json() as { jobs: Array<{ id: string; name?: string; queue?: string }> }).jobs;
    expect(jobs.length).toBeGreaterThan(0);
    return jobs[0].id;
  };

  it("settles the image a cancelled job was for", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/images",
      headers: auth.headers,
      payload: { prompt: "a lighthouse", aspectRatio: "1:1", quality: "fast" },
    });
    expect(created.statusCode).toBe(202);
    const generationId = (created.json() as { generation: { id: string } }).generation.id;
    const jobId = await jobFor("image.generate");

    const res = await app.inject({ method: "POST", url: `/api/v1/jobs/image.generate/${jobId}/cancel`, headers: auth.headers });
    expect(res.statusCode).toBe(200);
    expect((await ctx.jobQueue.getJob("image.generate", jobId))?.state).toBe("cancelled");
    const generation = await ctx.imageGenerations.get(auth.projectId, generationId);
    expect(generation?.status).toBe("cancelled");
  });

  it("refuses to strand one step of a video, and says where to cancel it", async () => {
    await ctx.jobQueue.ensureQueue("video.scene");
    const jobId = (await ctx.jobQueue.enqueue("video.scene", { projectId: auth.projectId, videoProjectId: "v", sceneId: "s" }))!;
    const res = await app.inject({ method: "POST", url: `/api/v1/jobs/video.scene/${jobId}/cancel`, headers: auth.headers });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/Cancel the video from its own screen/);
    expect((await ctx.jobQueue.getJob("video.scene", jobId))?.state).not.toBe("cancelled");
  });

  it("answers 404 for another project's job", async () => {
    await ctx.jobQueue.ensureQueue("video.scene");
    const jobId = (await ctx.jobQueue.enqueue("video.scene", { projectId: "someone-else", videoProjectId: "v", sceneId: "s" }))!;
    const res = await app.inject({ method: "POST", url: `/api/v1/jobs/video.scene/${jobId}/cancel`, headers: auth.headers });
    expect(res.statusCode).toBe(404);
  });
});
