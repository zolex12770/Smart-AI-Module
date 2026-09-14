import type { FastifyInstance } from "fastify";
import {
  createTaskRequestSchema,
  NotFoundError,
  ValidationError,
  type AuthContext,
  type TaskEvent,
} from "@ai-platform/shared";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { requireProject } from "../../plugins/auth.js";

/**
 * Agent task endpoints — docs/15_API_ARCHITECTURE.md. Backs the state machine and task
 * graph implemented in backend/packages/agent-core (docs/11_AGENT_LOOP.md).
 *
 * Two things every route here obeys (docs/26_DECISIONS.md ADR-049):
 *
 * - **A task is never reached by id alone.** `ctx.tasks.get(projectId, id)` puts the tenant
 *   in the SQL `WHERE`, so a task in another project is reported exactly like one that does
 *   not exist. Nothing is fetched and then compared in JavaScript — that shape *is* an IDOR.
 * - **The actor is the authenticated principal.** Approvals, rejections and cancellations
 *   record `authCtx.user.id`. The body used to be able to name its own approver, which made
 *   the approval trail (docs/13 §6, docs/11 §2.2's human-in-the-loop gate) worthless: anyone
 *   who could call the endpoint could also decide whose name appeared against the decision.
 */

/**
 * `AuthContext.projectId` is optional at the type level because an `AuthContext` exists
 * before a request has been resolved against a project. Everything `requireProject` returns
 * *has* been, so this narrows once, at the boundary, rather than scattering non-null
 * assertions through every repository call below.
 */
function scopedProjectId(authCtx: AuthContext): string {
  if (!authCtx.projectId) {
    throw new ValidationError("A projectId is required (send it as a query parameter or in the body).");
  }
  return authCtx.projectId;
}

/**
 * Approve/reject bodies. Previously a hand-rolled `if (!nodeId) throw` that accepted any
 * type for the field and also read an `approvedBy`/`rejectedBy` string straight off the
 * request — both are gone: the shape is validated here, and the actor comes from the session.
 */
const nodeDecisionSchema = z.object({ nodeId: z.string().min(1) });

/**
 * Cancel carries no fields of its own. `.strict()` so a stray `actor` is rejected loudly
 * rather than silently ignored — which is what would otherwise let a caller *think* it chose
 * who the cancellation is attributed to. `projectId` is allowed through because the body is
 * one of the places `requireProject` looks for the scope (plugins/auth.ts), so a client that
 * puts it there must not be told its request is malformed.
 */
const cancelRequestSchema = z.object({ projectId: z.string().optional() }).strict();

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    "/api/v1/agent/tasks",
    // docs/13_SECURITY_ARCHITECTURE.md §4 Layer 2 — each task spins up a full task graph
    // (potentially several tool/model-call nodes); the dispatcher's own hard cascade-
    // iteration ceiling (backend/packages/agent-core/src/engine.ts) bounds a single runaway task,
    // this bounds the rate of *new* tasks.
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      // `agent:run` rather than `project:write`: starting a task spends model tokens and
      // executes tools in the sandbox (ADR-055), so it is the permission a `viewer` must not
      // have even though they may read every task below.
      const authCtx = await requireProject(request, ctx.auth, "agent:run");
      const projectId = scopedProjectId(authCtx);

      const parsed = createTaskRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      // The owner is handed to the engine explicitly and has no default (ADR-049): it is what
      // scopes every row the run writes and what its tool calls are attributed to, and neither
      // may be guessed or taken from the body. Everything that can afterwards read or act on
      // the task — the two GETs, the event stream, approve, reject, cancel — re-resolves it
      // through a project-scoped repository read, so it is never reachable across projects.
      const task = await ctx.engine.createAndStart(parsed.data.taskType, parsed.data.input, {
        projectId,
        userId: authCtx.user.id,
      });
      request.log.info(
        {
          request_id: request.id,
          project_id: projectId,
          user_id: authCtx.user.id,
          task_id: task.id,
          task_type: parsed.data.taskType,
          status: "created",
        },
        "agent task created"
      );
      reply.status(201).send({ task });
    }
  );

  app.get("/api/v1/agent/tasks", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    return { tasks: await ctx.tasks.list(scopedProjectId(authCtx)) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/agent/tasks/:id", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    const projectId = scopedProjectId(authCtx);

    const task = await ctx.tasks.get(projectId, request.params.id);
    if (!task) throw new NotFoundError(`Task "${request.params.id}" not found.`);
    // `task_nodes` has no project column of its own — it inherits scope through its FK to
    // `tasks`, so the repository joins the parent and applies the predicate there (ADR-049).
    const nodes = await ctx.taskNodes.listByRoot(projectId, task.id);
    return { task, nodes };
  });

  app.get<{ Params: { id: string } }>("/api/v1/agent/tasks/:id/events", async (request, reply) => {
    // An EventSource cannot set headers, so a browser subscribes with `?projectId=...`;
    // `requireProject` reads it from the query as readily as from a body (ADR-049).
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    const projectId = scopedProjectId(authCtx);

    const task = await ctx.tasks.get(projectId, request.params.id);
    if (!task) throw new NotFoundError(`Task "${request.params.id}" not found.`);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // See backend/src/routes/v1/chat.ts for why this is written by hand: reply.hijack()
      // bypasses @fastify/cors's response hook entirely. The EventSource subscribes with
      // `withCredentials`, so the credentials header is required too (ADR-123).
      "Access-Control-Allow-Origin": ctx.corsOrigin,
      "Access-Control-Allow-Credentials": "true",
    });
    reply.hijack();

    const send = (event: TaskEvent) => {
      // The subscription outlives an abandoned socket by however long it takes the `close`
      // handler to run; writing to a destroyed socket throws, so every write is guarded.
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // Replay current state immediately so a client connecting after the task already
    // progressed isn't stuck waiting for the next event that may never come.
    send({ type: "state", taskId: task.id, state: task.state });
    const nodes = await ctx.taskNodes.listByRoot(projectId, task.id);
    for (const node of nodes) send({ type: "node", taskId: task.id, node });

    // Only reached for a task already proven to be in the caller's project, so the in-process
    // event bus — which is keyed by task id alone and knows nothing about tenancy — is never
    // subscribed to on behalf of someone who could not read the task in the first place.
    const unsubscribe = ctx.engine.subscribe(task.id, send);
    // `request.raw` is the right hook *here* and the wrong one in chat.ts: this is a bodyless
    // GET, so Fastify never drains and destroys the request stream, and its `close` fires only
    // when the client actually goes away. A POST's request stream is destroyed as soon as the
    // body is parsed — see the long note in routes/v1/chat.ts before copying this pattern.
    request.raw.on("close", unsubscribe);
  });

  app.post<{ Params: { id: string } }>("/api/v1/agent/tasks/:id/approve", async (request) => {
    // A human approval gate (docs/11 §2.2) is only worth having if the human is the
    // authenticated one, so this needs `agent:approve` — and records the session's user.
    const authCtx = await requireProject(request, ctx.auth, "agent:approve");
    const { task, node } = await resolveDecisionTarget(ctx, authCtx, request.params.id, request.body);

    // `approvedBy` is the authenticated principal. It used to be `request.body.approvedBy`
    // defaulted to "anonymous" — a client-supplied approver name on the one record whose
    // whole purpose is attributing the decision (an audit finding, docs/13 §6). The engine
    // stores this on the node and prefixes it as `user:<id>` in the transition log.
    await ctx.engine.approve(task.id, node.id, authCtx.user.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/v1/agent/tasks/:id/reject", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "agent:approve");
    const { task, node } = await resolveDecisionTarget(ctx, authCtx, request.params.id, request.body);

    // Same rule as approve: the rejecter is whoever the session says it is, never the body.
    await ctx.engine.reject(task.id, node.id, authCtx.user.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/v1/agent/tasks/:id/cancel", async (request) => {
    // Stopping a run is `agent:run` rather than `agent:approve`: it is the same authority as
    // starting one, and a `viewer` must not be able to halt another member's work.
    const authCtx = await requireProject(request, ctx.auth, "agent:run");
    const projectId = scopedProjectId(authCtx);

    // Fastify hands an absent body through as `undefined`; an empty object is the schema's
    // shape either way, so both spellings of "no fields" validate identically.
    const parsed = cancelRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const task = await ctx.tasks.get(projectId, request.params.id);
    if (!task) throw new NotFoundError(`Task "${request.params.id}" not found.`);

    // `user:<id>` is the transition log's actor convention (shared task-graph.ts):
    // "engine", "user:<id>", "system:crash-recovery". `cancel` writes the actor verbatim,
    // unlike approve/reject which add the prefix themselves.
    await ctx.engine.cancel(task.id, `user:${authCtx.user.id}`);
    return { ok: true };
  });

  // The tool routes live in platform.ts alongside the other introspection endpoints (ADR-066).
}

/**
 * Resolves the (task, node) pair an approval decision is about, entirely inside the caller's
 * project.
 *
 * Both reads are scoped, and the node is then checked to belong to *this* task: without that
 * last step a member of a project could approve any node of any task in the same project by
 * naming a different task's id, which would let a node whose own approval gate the caller
 * never saw be waved through. A mismatch is reported as "not found", the same as an id that
 * does not exist, so the endpoint never confirms which node ids are real.
 */
async function resolveDecisionTarget(
  ctx: AppContext,
  authCtx: AuthContext,
  taskId: string,
  body: unknown
): Promise<{ task: { id: string }; node: { id: string } }> {
  const projectId = scopedProjectId(authCtx);

  const parsed = nodeDecisionSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError(parsed.error.message);

  const task = await ctx.tasks.get(projectId, taskId);
  if (!task) throw new NotFoundError(`Task "${taskId}" not found.`);

  const node = await ctx.taskNodes.get(projectId, parsed.data.nodeId);
  if (!node || node.rootTaskId !== task.id) {
    throw new NotFoundError(`Node "${parsed.data.nodeId}" not found on task "${taskId}".`);
  }

  return { task, node };
}
