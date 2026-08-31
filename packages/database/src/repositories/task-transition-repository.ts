import { asc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { TaskTransition } from "@ai-platform/shared";
import type { DrizzleDb } from "../client.js";
import { taskTransitions } from "../schema/index.js";

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
 * never be rewritten after the fact.
 */
export interface TaskTransitionRepository {
  append(input: AppendTransitionInput): Promise<TaskTransition>;
  listByTask(taskId: string): Promise<TaskTransition[]>;
}

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
    };
    await this.db.insert(taskTransitions).values(row);
    return { ...row, createdAt: row.createdAt.getTime() };
  }

  async listByTask(taskId: string): Promise<TaskTransition[]> {
    const rows = await this.db
      .select()
      .from(taskTransitions)
      .where(eq(taskTransitions.taskId, taskId))
      .orderBy(asc(taskTransitions.createdAt));
    return rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      nodeId: r.nodeId,
      fromState: r.fromState,
      toState: r.toState,
      actor: r.actor,
      payload: r.payload as Record<string, unknown> | null,
      createdAt: r.createdAt.getTime(),
    }));
  }
}
