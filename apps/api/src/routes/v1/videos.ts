import type { FastifyInstance } from "fastify";
import { createVideoProject, orchestrateVideoProject } from "@ai-platform/media";
import { NotFoundError, ValidationError, videoProjectRequestSchema } from "@ai-platform/shared";
import { v4 as uuid } from "uuid";
import type { AppContext } from "../../context.js";

export function registerVideoRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/v1/videos", async (request, reply) => {
    const parsed = videoProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const id = uuid();
    const project = await createVideoProject({ projectRepo: ctx.videoProjects, sceneRepo: ctx.videoScenes }, id, parsed.data);
    await orchestrateVideoProject({ projectRepo: ctx.videoProjects, sceneRepo: ctx.videoScenes, jobQueue: ctx.jobQueue }, id);

    reply.status(202).send({ project });
  });

  app.get("/api/v1/videos", async () => ({ projects: await ctx.videoProjects.list() }));

  app.get<{ Params: { id: string } }>("/api/v1/videos/:id", async (request) => {
    const project = await ctx.videoProjects.get(request.params.id);
    if (!project) throw new NotFoundError(`Video project "${request.params.id}" not found.`);
    const scenes = await ctx.videoScenes.listByProject(project.id);
    return { project, scenes: scenes.sort((a, b) => a.sceneIndex - b.sceneIndex) };
  });

  // Resumability (docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md §2.3): re-running orchestration
  // only (re-)submits scenes that are not already `succeeded` — this is the "fix scene 37,
  // only scene 37 regenerates" mechanism, exposed as an explicit user action.
  app.post<{ Params: { id: string } }>("/api/v1/videos/:id/retry", async (request, reply) => {
    const project = await ctx.videoProjects.get(request.params.id);
    if (!project) throw new NotFoundError(`Video project "${request.params.id}" not found.`);
    await orchestrateVideoProject({ projectRepo: ctx.videoProjects, sceneRepo: ctx.videoScenes, jobQueue: ctx.jobQueue }, project.id);
    reply.status(202).send({ project: await ctx.videoProjects.get(project.id) });
  });
}
