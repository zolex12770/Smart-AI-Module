import { and, asc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { TaskTransition } from "@ai-platform/shared";
import type { DrizzleDb } from "../client.js";
import { taskTransitions, tasks } from "../schema/index.js";

export interface AppendTransitionInput {
  taskId: string;
  nodeId: string | null;
  fromState: string | null;
  toState: string;
  actor: string;
  payload?: Record<string, unknown> | null;
}

/**
 * Append-only — docs/11_AGENT_LOOP.md §4.1. No `update`/`delete` method exists here
 * deliberately: the log is the source of truth for crash recovery and audit, and must
 * never be rewritten after the fact. ADR-049 changed nothing about that; the table has no
 * `deleted_at` because a soft delete of an audit record is a contradiction.
 *
 * The rows carry no `project_id` of their own — they inherit scope through the NOT NULL FK
 * to `tasks` — so the request-facing read joins `tasks` and puts the project predicate in
 * the same statement. `listByTaskUnscoped` is the engine's and crash recovery's read, which
 * spans every project by definition and is never given a client-supplied id.
 */
export interface TaskTransitionRepository {
  append(input: AppendTransitionInput): Promise<TaskTransition>;
  /** Oldest first — the log reads as a narrative of the task, so order is part of the answer. */
  listByTask(projectId: string, taskId: string): Promise<TaskTransition[]>;
  /** System-internal read (see the interface docstring) — no tenancy filter. */
  listByTaskUnscoped(taskId: string): Promise<TaskTransition[]>;
}

type TaskTransitionRow = typeof taskTransitions.$inferSelect;

export class PgTaskTransitionRepository implements TaskTransitionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async append(input: AppendTransitionInput): Promise<TaskTransition> {
    const row = {
      id: uuid(),
      taskId: input.taskId,
      nodeId: input.nodeId,
      fromState: input.fromState,
      toState: input.toState,
      actor: input.actor,
      payload: input.payload ?? null,
      createdAt: new Date(),
    } satisfies TaskTransitionRow;
    await this.db.insert(taskTransitions).values(row);
    return toTransition(row);
  }

  async listByTask(projectId: string, taskId: string): Promise<TaskTransition[]> {
    const rows = await this.db
      .select({ transition: taskTransitions })
      .from(taskTransitions)
      // The project predicate is part of this statement, not a check applied to the rows
      // afterwards: a task in another project yields an empty log, which is the same thing
      // an unknown task id yields (ADR-049 — no existence oracle).
      .innerJoin(tasks, eq(taskTransitions.taskId, tasks.id))
      .where(and(eq(taskTransitions.taskId, taskId), eq(tasks.projectId, projectId)))
      .orderBy(asc(taskTransitions.createdAt));
    return rows.map((row) => toTransition(row.transition));
  }

  async listByTaskUnscoped(taskId: string): Promise<TaskTransition[]> {
    const rows = await this.db
      .select()
      .from(taskTransitions)
      .where(eq(taskTransitions.taskId, taskId))
      .orderBy(asc(taskTransitions.createdAt));
    return rows.map(toTransition);
  }
}

function toTransition(row: TaskTransitionRow): TaskTransition {
  return {
    id: row.id,
    taskId: row.taskId,
    nodeId: row.nodeId,
    fromState: row.fromState,
    toState: row.toState,
    actor: row.actor,
    payload: row.payload as Record<string, unknown> | null,
    createdAt: row.createdAt.getTime(),
  };
}
