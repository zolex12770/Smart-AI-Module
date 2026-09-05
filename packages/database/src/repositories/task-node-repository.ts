import { and, eq, inArray, lte, sql } from "drizzle-orm";
import {
  NotFoundError,
  type CreateTaskNodeInput,
  type FailureClass,
  type NodeStatus,
  type TaskNode,
  type TaskState,
} from "@ai-platform/shared";
import type { DrizzleDb } from "../client.js";
import { taskNodes, tasks } from "../schema/index.js";

/**
 * The stored node. `TaskNode` (packages/shared) stays the shape the dispatcher and the
 * frontend speak; the three columns ADR-049's schema added are scheduling bookkeeping that
 * only the repository and the engine need, so they extend it here. Anything typed `TaskNode`
 * keeps compiling against a `TaskNodeRecord`.
 */
export interface TaskNodeRecord extends TaskNode {
  /** Epoch millis at which a retry becomes eligible — what makes `retryPolicy.backoff` real. */
  nextAttemptAt: number | null;
  /** Epoch millis the current attempt began. Null when the node is not executing. */
  startedAt: number | null;
  /** Why the last attempt failed, which is what decides retry vs. replan (docs/11 §4.3). */
  failureClass: FailureClass | null;
}

export interface TaskNodePatch {
  status?: NodeStatus;
  output?: Record<string, unknown> | null;
  errorMessage?: string | null;
  attemptCount?: number;
  approvedBy?: string | null;
  approvedAt?: number | null;
  nextAttemptAt?: number | null;
  startedAt?: number | null;
  failureClass?: FailureClass | null;
}

/**
 * `task_nodes` carries no `project_id` of its own: it inherits scope through its NOT NULL FK
 * to `tasks`, and ADR-049 requires such a child to be read *through* that parent. So the
 * request-facing reads (`get`, `listByRoot`) join `tasks` and put the project predicate in
 * the same statement — a node under someone else's task produces no rows, rather than being
 * fetched and then rejected in JavaScript.
 *
 * The `*Unscoped` reads and `update` exist for the engine and crash recovery, which run
 * across every project by definition and are never handed a client-supplied id. They must
 * not be called from a route handler.
 */
export interface TaskNodeRepository {
  create(rootTaskId: string, input: CreateTaskNodeInput): Promise<TaskNodeRecord>;
  get(projectId: string, id: string): Promise<TaskNodeRecord | undefined>;
  /** System-internal read (see the interface docstring) — no tenancy filter. */
  getUnscoped(id: string): Promise<TaskNodeRecord | undefined>;
  update(id: string, patch: TaskNodePatch): Promise<void>;
  listByRoot(projectId: string, rootTaskId: string): Promise<TaskNodeRecord[]>;
  /** System-internal read (see the interface docstring) — no tenancy filter. */
  listByRootUnscoped(rootTaskId: string): Promise<TaskNodeRecord[]>;
  /** Nodes left in an in-flight status — scanned on boot for crash recovery (docs/11 §4.2-4.3). */
  listInFlight(): Promise<TaskNodeRecord[]>;
  /**
   * Nodes whose backoff has elapsed and which are therefore due to run again. The scheduler
   * polls this instead of holding a timer per node, so a restart loses nothing.
   */
  listDueForRetry(now?: Date): Promise<TaskNodeRecord[]>;
  /**
   * Nodes still executing past `started_at + timeout_ms`. The arithmetic is done by the
   * database so the comparison is against one clock, not per-instance clocks (ADR-052).
   */
  listTimedOut(now?: Date): Promise<TaskNodeRecord[]>;
  /**
   * Replanning: replaces every node under `rootTaskId` and moves the parent task's state in
   * ONE transaction. Halfway through, a task would have a plan that is neither the old one
   * nor the new one while its state claims otherwise — precisely the inconsistency crash
   * recovery cannot reason its way out of (docs/11 §4.2), so it must never be observable.
   */
  replaceForRoot(rootTaskId: string, inputs: CreateTaskNodeInput[], taskState: TaskState): Promise<TaskNodeRecord[]>;
}

const IN_FLIGHT_STATUSES: NodeStatus[] = ["waiting_model", "waiting_tool", "verifying", "retrying"];

/**
 * A subset of the above: statuses in which a node is actually consuming time somewhere.
 * `retrying` is deliberately absent — a node waiting out its backoff is idle, and counting
 * that wait against its execution timeout would kill nodes for being patient.
 */
const RUNNING_STATUSES: NodeStatus[] = ["running", "waiting_model", "waiting_tool", "verifying"];

type TaskNodeRow = typeof taskNodes.$inferSelect;

export class PgTaskNodeRepository implements TaskNodeRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(rootTaskId: string, input: CreateTaskNodeInput): Promise<TaskNodeRecord> {
    const row = buildRow(rootTaskId, input, new Date());
    await this.db.insert(taskNodes).values(row);
    return toNode(row);
  }

  async get(projectId: string, id: string): Promise<TaskNodeRecord | undefined> {
    const [row] = await this.db
      .select({ node: taskNodes })
      .from(taskNodes)
      .innerJoin(tasks, eq(taskNodes.rootTaskId, tasks.id))
      .where(and(eq(taskNodes.id, id), eq(tasks.projectId, projectId)));
    return row ? toNode(row.node) : undefined;
  }

  async getUnscoped(id: string): Promise<TaskNodeRecord | undefined> {
    const [row] = await this.db.select().from(taskNodes).where(eq(taskNodes.id, id));
    return row ? toNode(row) : undefined;
  }

  async update(id: string, patch: TaskNodePatch): Promise<void> {
    await this.db
      .update(taskNodes)
      .set({
        updatedAt: new Date(),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.output !== undefined ? { output: patch.output } : {}),
        ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
        ...(patch.attemptCount !== undefined ? { attemptCount: patch.attemptCount } : {}),
        ...(patch.approvedBy !== undefined ? { approvedBy: patch.approvedBy } : {}),
        ...(patch.approvedAt !== undefined
          ? { approvedAt: patch.approvedAt !== null ? new Date(patch.approvedAt) : null }
          : {}),
        ...(patch.nextAttemptAt !== undefined
          ? { nextAttemptAt: patch.nextAttemptAt !== null ? new Date(patch.nextAttemptAt) : null }
          : {}),
        ...(patch.startedAt !== undefined
          ? { startedAt: patch.startedAt !== null ? new Date(patch.startedAt) : null }
          : {}),
        ...(patch.failureClass !== undefined ? { failureClass: patch.failureClass } : {}),
      })
      .where(eq(taskNodes.id, id));
  }

  async listByRoot(projectId: string, rootTaskId: string): Promise<TaskNodeRecord[]> {
    const rows = await this.db
      .select({ node: taskNodes })
      .from(taskNodes)
      .innerJoin(tasks, eq(taskNodes.rootTaskId, tasks.id))
      .where(and(eq(taskNodes.rootTaskId, rootTaskId), eq(tasks.projectId, projectId)));
    return rows.map((row) => toNode(row.node));
  }

  async listByRootUnscoped(rootTaskId: string): Promise<TaskNodeRecord[]> {
    const rows = await this.db.select().from(taskNodes).where(eq(taskNodes.rootTaskId, rootTaskId));
    return rows.map(toNode);
  }

  async listInFlight(): Promise<TaskNodeRecord[]> {
    // Filtered by the database against `task_nodes_status_idx`. This used to read every node
    // ever created into memory and drop the ~99% that were terminal, which made boot-time
    // recovery cost grow with total history rather than with what is actually in flight.
    const rows = await this.db.select().from(taskNodes).where(inArray(taskNodes.status, IN_FLIGHT_STATUSES));
    return rows.map(toNode);
  }

  async listDueForRetry(now = new Date()): Promise<TaskNodeRecord[]> {
    // A node with no scheduled retry has `next_attempt_at IS NULL`, and NULL never satisfies
    // a comparison — so "not waiting on a backoff" is excluded by the predicate itself and
    // needs no separate IS NOT NULL clause.
    const rows = await this.db
      .select()
      .from(taskNodes)
      .where(and(eq(taskNodes.status, "retrying"), lte(taskNodes.nextAttemptAt, now)));
    return rows.map(toNode);
  }

  async listTimedOut(now = new Date()): Promise<TaskNodeRecord[]> {
    const rows = await this.db
      .select()
      .from(taskNodes)
      .where(
        and(
          inArray(taskNodes.status, RUNNING_STATUSES),
          // `started_at` is NULL for a node that never began, and NULL arithmetic yields
          // NULL, so those drop out here for the same reason as above.
          sql`${taskNodes.startedAt} + (${taskNodes.timeoutMs}::double precision * interval '1 millisecond') < ${now}::timestamptz`
        )
      );
    return rows.map(toNode);
  }

  async replaceForRoot(
    rootTaskId: string,
    inputs: CreateTaskNodeInput[],
    taskState: TaskState
  ): Promise<TaskNodeRecord[]> {
    const now = new Date();
    const rows = inputs.map((input) => buildRow(rootTaskId, input, now));

    await this.db.transaction(async (tx) => {
      // The parent moves first, and its `returning` is the existence check: an unknown
      // `rootTaskId` throws here and the transaction rolls back, so a typo can never delete
      // a node set and leave nothing in its place.
      const [parent] = await tx
        .update(tasks)
        .set({ state: taskState, updatedAt: now, version: sql`${tasks.version} + 1` })
        .where(eq(tasks.id, rootTaskId))
        .returning({ id: tasks.id });
      if (!parent) throw new NotFoundError(`Task "${rootTaskId}" not found.`);

      // A hard DELETE is correct here: `task_nodes` has no `deleted_at`, and a superseded
      // plan is not history worth keeping — `task_transitions` already records what happened
      // to every node, append-only, and survives this.
      await tx.delete(taskNodes).where(eq(taskNodes.rootTaskId, rootTaskId));
      if (rows.length > 0) await tx.insert(taskNodes).values(rows);
    });

    return rows.map(toNode);
  }
}

function buildRow(rootTaskId: string, input: CreateTaskNodeInput, now: Date) {
  const retryPolicy = {
    maxAttempts: input.retryPolicy?.maxAttempts ?? 1,
    backoff: input.retryPolicy?.backoff ?? "none",
    classifyFailureAs: input.retryPolicy?.classifyFailureAs ?? null,
  };
  return {
    id: input.id,
    parentId: input.parentId ?? null,
    rootTaskId,
    type: input.type,
    kind: input.kind,
    status: "pending" as NodeStatus,
    dependsOn: input.dependsOn,
    input: input.input,
    output: null,
    toolId: input.toolId ?? null,
    modelProvider: input.modelProvider ?? null,
    retryPolicy,
    timeoutMs: input.timeoutMs,
    verificationMethod: input.verificationMethod,
    verificationSpec: input.verificationSpec ?? null,
    approvalRequired: input.approvalRequired,
    approvedBy: null,
    approvedAt: null,
    attemptCount: 0,
    nextAttemptAt: null,
    startedAt: null,
    failureClass: null,
    errorMessage: null,
    createdAt: now,
    // Set on create as well as on every update (ADR-049): a row whose `updated_at` only
    // becomes meaningful after the first edit makes staleness queries lie.
    updatedAt: now,
  } satisfies TaskNodeRow;
}

function toNode(row: TaskNodeRow): TaskNodeRecord {
  return {
    id: row.id,
    parentId: row.parentId,
    rootTaskId: row.rootTaskId,
    type: row.type as TaskNode["type"],
    kind: row.kind as TaskNode["kind"],
    status: row.status as NodeStatus,
    dependsOn: row.dependsOn as string[],
    input: row.input as Record<string, unknown>,
    output: row.output as Record<string, unknown> | null,
    toolId: row.toolId,
    modelProvider: row.modelProvider,
    retryPolicy: row.retryPolicy as TaskNode["retryPolicy"],
    timeoutMs: row.timeoutMs,
    verificationMethod: row.verificationMethod as TaskNode["verificationMethod"],
    verificationSpec: row.verificationSpec as Record<string, unknown> | null,
    approvalRequired: row.approvalRequired,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt ? row.approvedAt.getTime() : null,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.getTime() : null,
    startedAt: row.startedAt ? row.startedAt.getTime() : null,
    failureClass: row.failureClass as FailureClass | null,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}
