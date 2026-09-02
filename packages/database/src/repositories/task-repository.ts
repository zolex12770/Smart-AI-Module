import { desc, eq } from "drizzle-orm";
import type { Task, TaskState, TaskType } from "@ai-platform/shared";
import type { DrizzleDb } from "../client.js";
import { tasks } from "../schema/index.js";

export interface CreateTaskInput {
  id: string;
  taskType: TaskType;
  input: Record<string, unknown>;
}

export interface TaskRepository {
  create(input: CreateTaskInput): Promise<Task>;
  get(id: string): Promise<Task | undefined>;
  updateState(
    id: string,
    state: TaskState,
    patch?: { output?: Record<string, unknown> | null; errorMessage?: string | null }
  ): Promise<void>;
  /** Tasks not in a terminal state — scanned on boot for crash recovery (docs/11 §4.2). */
  listNonTerminal(): Promise<Task[]>;
  /** Most recent first — backs the `/tasks` history screen (docs/16_FRONTEND_ARCHITECTURE.md). */
  list(): Promise<Task[]>;
}

const TERMINAL_STATES: TaskState[] = ["COMPLETED", "FAILED", "CANCELLED"];

export class PgTaskRepository implements TaskRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreateTaskInput): Promise<Task> {
    const now = new Date();
    const row = {
      id: input.id,
      taskType: input.taskType,
      state: "IDLE" as TaskState,
      input: input.input,
      output: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(tasks).values(row);
    return toTask(row);
  }

  async get(id: string): Promise<Task | undefined> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id));
    return row ? toTask(row) : undefined;
  }

  async updateState(
    id: string,
    state: TaskState,
    patch?: { output?: Record<string, unknown> | null; errorMessage?: string | null }
  ): Promise<void> {
    await this.db
      .update(tasks)
      .set({
        state,
        updatedAt: new Date(),
        ...(patch?.output !== undefined ? { output: patch.output } : {}),
        ...(patch?.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      })
      .where(eq(tasks.id, id));
  }

  async listNonTerminal(): Promise<Task[]> {
    const rows = await this.db.select().from(tasks);
    return rows.filter((r) => !TERMINAL_STATES.includes(r.state as TaskState)).map(toTask);
  }

  async list(): Promise<Task[]> {
    const rows = await this.db.select().from(tasks).orderBy(desc(tasks.createdAt));
    return rows.map(toTask);
  }
}

function toTask(row: {
  id: string;
  taskType: string;
  state: string;
  input: unknown;
  output: unknown;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Task {
  return {
    id: row.id,
    taskType: row.taskType as TaskType,
    state: row.state as TaskState,
    input: row.input as Record<string, unknown>,
    output: row.output as Record<string, unknown> | null,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}
