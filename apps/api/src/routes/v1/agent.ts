import type { FastifyInstance } from "fastify";
import { createTaskRequestSchema, NotFoundError, ValidationError, type TaskEvent } from "@ai-platform/shared";
import type { AppContext } from "../../context.js";

/**
 * Agent task endpoints — docs/15_API_ARCHITECTURE.md. Backs the state machine and task
 * graph implemented in packages/agent-core (docs/11_AGENT_LOOP.md).
 */
export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/v1/agent/tasks", async (request, reply) => {
    const parsed = createTaskRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const task = await ctx.engine.createAndStart(parsed.data.taskType, parsed.data.input);
    reply.status(201).send({ task });
  });

  app.get("/api/v1/agent/tasks", async () => ({ tasks: await ctx.tasks.list() }));

  app.get<{ Params: { id: string } }>("/api/v1/agent/tasks/:id", async (request) => {
    const task = await ctx.tasks.get(request.params.id);
    if (!task) throw new NotFoundError(`Task "${request.params.id}" not found.`);
    const nodes = await ctx.taskNodes.listByRoot(task.id);
    return { task, nodes };
  });

  app.get<{ Params: { id: string } }>("/api/v1/agent/tasks/:id/events", async (request, reply) => {
    const task = await ctx.tasks.get(request.params.id);
    if (!task) throw new NotFoundError(`Task "${request.params.id}" not found.`);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // See apps/api/src/routes/v1/chat.ts for why this is written by hand: reply.hijack()
      // bypasses @fastify/cors's response hook entirely.
      "Access-Control-Allow-Origin": ctx.corsOrigin,
    });
    reply.hijack();

    const send = (event: TaskEvent) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Replay current state immediately so a client connecting after the task already
    // progressed isn't stuck waiting for the next event that may never come.
    send({ type: "state", taskId: task.id, state: task.state });
    const nodes = await ctx.taskNodes.listByRoot(task.id);
    for (const node of nodes) send({ type: "node", taskId: task.id, node });

    const unsubscribe = ctx.engine.subscribe(task.id, send);
    request.raw.on("close", unsubscribe);
  });

  app.post<{ Params: { id: string }; Body: { nodeId: string; approvedBy?: string } }>(
    "/api/v1/agent/tasks/:id/approve",
    async (request) => {
      const { nodeId, approvedBy } = request.body;
      if (!nodeId) throw new ValidationError("approve requires a nodeId.");
      await ctx.engine.approve(request.params.id, nodeId, approvedBy ?? "anonymous");
      return { ok: true };
    }
  );

  app.post<{ Params: { id: string }; Body: { nodeId: string; rejectedBy?: string } }>(
    "/api/v1/agent/tasks/:id/reject",
    async (request) => {
      const { nodeId, rejectedBy } = request.body;
      if (!nodeId) throw new ValidationError("reject requires a nodeId.");
      await ctx.engine.reject(request.params.id, nodeId, rejectedBy ?? "anonymous");
      return { ok: true };
    }
  );

  app.post<{ Params: { id: string }; Body: { actor?: string } | undefined }>(
    "/api/v1/agent/tasks/:id/cancel",
    async (request) => {
      await ctx.engine.cancel(request.params.id, request.body?.actor ?? "anonymous");
      return { ok: true };
    }
  );

  app.get("/api/v1/tools", async () => ({ tools: ctx.toolRegistry.list() }));

  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    "/api/v1/tools/:id/enable",
    async (request) => {
      const enabled = request.body?.enabled ?? true;
      const tool = ctx.toolRegistry.setEnabled(decodeURIComponent(request.params.id), enabled);
      return { tool };
    }
  );
}
