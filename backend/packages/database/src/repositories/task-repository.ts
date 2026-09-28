import { and, desc, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Task, TaskState, TaskType } from "@ai-platform/shared";
import type { DrizzleDb } from "../client.js";
import { tasks } from "../schema/index.js";

/**
 * The stored task. `Task` (shared) is the wire/domain shape the agent loop and the
 * frontend already speak; the columns ADR-049 and ADR-052 added are tenancy and execution
 * bookkeeping, so they extend it here rather than leaking into the shared contract. Anything
 * typed `Task` keeps compiling against a `TaskRecord`.
 */
export interface TaskRecord extends Task {
  projectId: string;
  /** Null when the creating user's row was deleted — the task itself survives. */
  createdByUserId: string | null;
  /** ADR-052 lease holder, e.g. `api-7f3c`. Null when no process is executing this task. */
  leaseOwner: string | null;
  /** Epoch millis, matching the rest of `Task`. Null whenever `leaseOwner` is null. */
  leaseExpiresAt: number | null;
  /** Bumped by every state transition; see `updateState`'s `expectedVersion`. */
  version: number;
  /** Set by `requestCancel`; the executing instance is what actually unwinds the task. */
  cancelRequestedAt: number | null;
}

export interface CreateTaskInput {
  id: string;
  projectId: string;
  /** The authenticated principal, never a client-supplied name (docs/13 §6). */
  createdByUserId?: string | null;
  taskType: TaskType;
  input: Record<string, unknown>;
}

export interface UpdateTaskStatePatch {
  output?: Record<string, unknown> | null;
  errorMessage?: string | null;
  /**
   * Optimistic concurrency (schema `tasks.version`). When supplied, the update applies only
   * if the row is still at that version, and `updateState` returns false if it is not —
   * which is how two instances racing the same transition are detected rather than the
   * later write silently clobbering the earlier one.
   */
  expectedVersion?: number;
}

/**
 * Two families of method live here deliberately, and the difference is not stylistic:
 *
 * - **Project-scoped** (`get`, `list`, `requestCancel`) — everything reachable from a request
 *   handler. `projectId` is a predicate in the `WHERE`, so a task in another project is
 *   indistinguishable from one that does not exist (ADR-049). Never fetch, then compare.
 * - **Unscoped** (`getUnscoped`, `updateState`, the lease methods, `listNonTerminal`) — the
 *   engine and crash recovery, which operate across every project by definition and are
 *   never driven by a client-supplied id. These MUST NOT be called from a route handler; a
 *   handler resolves the task with `get(projectId, id)` first and works from that.
 */
export interface TaskRepository {
  create(input: CreateTaskInput): Promise<TaskRecord>;
  get(projectId: string, id: string): Promise<TaskRecord | undefined>;
  /** System-internal read (see the interface docstring) — no tenancy filter. */
  getUnscoped(id: string): Promise<TaskRecord | undefined>;
  /** Returns false only when `expectedVersion` was supplied and lost the race. */
  updateState(id: string, state: TaskState, patch?: UpdateTaskStatePatch): Promise<boolean>;
  /** Tasks not in a terminal state — scanned on boot for crash recovery (docs/11 §4.2). */
  listNonTerminal(): Promise<TaskRecord[]>;
  /** One project's tasks that have not finished — what deleting the project must stop. */
  listNonTerminalForProject(projectId: string): Promise<TaskRecord[]>;
  /** Most recent first — backs the `/tasks` history screen (docs/16_FRONTEND_ARCHITECTURE.md). */
  list(projectId: string, options?: { limit?: number; offset?: number }): Promise<TaskRecord[]>;
  /**
   * ADR-052. Takes the execution lease if it is free or has expired, in ONE conditional
   * UPDATE. Returns whether this caller now owns it. This is the entire reason two API
   * instances can share one database without both dispatching the same task.
   */
  claimLease(taskId: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Extends a lease this caller still holds. False means it lapsed — stop working. */
  renewLease(taskId: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Gives the lease back so another instance can pick the task up immediately. */
  releaseLease(taskId: string, owner: string): Promise<void>;
  /**
   * Cooperative cancellation: records the request; the instance holding the lease is what
   * actually stops the work and writes the CANCELLED state. Returns false when the task is
   * not in this project, is already terminal, or was already asked to cancel.
   */
  requestCancel(projectId: string, taskId: string): Promise<boolean>;
}

const TERMINAL_STATES: TaskState[] = ["COMPLETED", "FAILED", "CANCELLED"];

type TaskRow = typeof tasks.$inferSelect;

export class PgTaskRepository implements TaskRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreateTaskInput): Promise<TaskRecord> {
    const now = new Date();
    const row = {
      id: input.id,
      projectId: input.projectId,
      createdByUserId: input.createdByUserId ?? null,
      taskType: input.taskType,
      state: "IDLE" as TaskState,
      input: input.input,
      output: null,
      errorMessage: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      version: 0,
      cancelRequestedAt: null,
      createdAt: now,
      updatedAt: now,
    } satisfies TaskRow;
    await this.db.insert(tasks).values(row);
    return toTask(row);
  }

  async get(projectId: string, id: string): Promise<TaskRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.projectId, projectId)));
    return row ? toTask(row) : undefined;
  }

  async getUnscoped(id: string): Promise<TaskRecord | undefined> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id));
    return row ? toTask(row) : undefined;
  }

  async updateState(id: string, state: TaskState, patch?: UpdateTaskStatePatch): Promise<boolean> {
    const updated = await this.db
      .update(tasks)
      .set({
        state,
        updatedAt: new Date(),
        // Every state transition moves the version, which is what makes `expectedVersion`
        // meaningful. Lease heartbeats deliberately do not (see `renewLease`).
        version: sql`${tasks.version} + 1`,
        ...(patch?.output !== undefined ? { output: patch.output } : {}),
        ...(patch?.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
      })
      .where(
        patch?.expectedVersion !== undefined
          ? and(eq(tasks.id, id), eq(tasks.version, patch.expectedVersion))
          : eq(tasks.id, id)
      )
      .returning({ id: tasks.id });
    return updated.length > 0;
  }

  async listNonTerminal(): Promise<TaskRecord[]> {
    // Filtered by the database, not by reading every task ever created into this process and
    // dropping most of them — the previous implementation did exactly that, which turned
    // boot-time crash recovery into a full table scan that grew without bound.
    const rows = await this.db.select().from(tasks).where(notInArray(tasks.state, TERMINAL_STATES));
    return rows.map(toTask);
  }

  async listNonTerminalForProject(projectId: string): Promise<TaskRecord[]> {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), notInArray(tasks.state, TERMINAL_STATES)));
    return rows.map(toTask);
  }

  async list(projectId: string, options?: { limit?: number; offset?: number }): Promise<TaskRecord[]> {
    // `desc(createdAt)` matches the composite `tasks_project_created_idx`, so paging through
    // a project's history is an index scan rather than a sort of the whole table.
    let query = this.db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .orderBy(desc(tasks.createdAt))
      .$dynamic();
    if (options?.limit !== undefined) query = query.limit(options.limit);
    if (options?.offset !== undefined) query = query.offset(options.offset);
    const rows = await query;
    return rows.map(toTask);
  }

  async claimLease(taskId: string, owner: string, ttlMs: number): Promise<boolean> {
    // One statement: the condition and the write cannot be interleaved by another instance,
    // which a read-then-write pair emphatically can be — two processes would both read
    // "lease free" and both believe they won. `returning` is how the caller learns the
    // outcome without a second round trip that could already be stale.
    //
    // `now()` rather than a JS `Date`: the lease is compared across processes, so it must be
    // measured against one clock (the database's), not against N application clocks that may
    // disagree by more than the lease TTL.
    const claimed = await this.db
      .update(tasks)
      .set({
        leaseOwner: owner,
        leaseExpiresAt: sql`now() + (${ttlMs}::double precision * interval '1 millisecond')`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(tasks.id, taskId),
          or(
            isNull(tasks.leaseOwner),
            // An expired lease is free: this is what stops a crashed instance from
            // stranding a task forever (ADR-052).
            sql`${tasks.leaseExpiresAt} < now()`,
            // Re-claiming a lease this caller already holds is idempotent, so a retried
            // dispatch does not have to distinguish "I already own it" from "I lost it".
            eq(tasks.leaseOwner, owner)
          )
        )
      )
      .returning({ id: tasks.id });
    return claimed.length > 0;
  }

  async renewLease(taskId: string, owner: string, ttlMs: number): Promise<boolean> {
    // `lease_expires_at > now()` is not redundant with the owner check: once a lease has
    // lapsed, another instance is entitled to take it, so a stalled process must re-claim
    // rather than quietly extend an ownership it no longer has.
    const renewed = await this.db
      .update(tasks)
      .set({
        leaseExpiresAt: sql`now() + (${ttlMs}::double precision * interval '1 millisecond')`,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(tasks.id, taskId), eq(tasks.leaseOwner, owner), sql`${tasks.leaseExpiresAt} > now()`)
      )
      .returning({ id: tasks.id });
    return renewed.length > 0;
  }

  async releaseLease(taskId: string, owner: string): Promise<void> {
    // Scoped to the owner so a process that has already lost its lease cannot clear the
    // lease of whichever instance legitimately took over. A no-op in that case, by design.
    await this.db
      .update(tasks)
      .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: sql`now()` })
      .where(and(eq(tasks.id, taskId), eq(tasks.leaseOwner, owner)));
  }

  async requestCancel(projectId: string, taskId: string): Promise<boolean> {
    const now = new Date();
    const updated = await this.db
      .update(tasks)
      .set({ cancelRequestedAt: now, updatedAt: now })
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.projectId, projectId),
          // Asking twice must not move the timestamp forward — the first request is the one
          // the transition log will be reconciled against.
          isNull(tasks.cancelRequestedAt),
          notInArray(tasks.state, TERMINAL_STATES)
        )
      )
      .returning({ id: tasks.id });
    return updated.length > 0;
  }
}

function toTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    createdByUserId: row.createdByUserId,
    taskType: row.taskType as TaskType,
    state: row.state as TaskState,
    input: row.input as Record<string, unknown>,
    output: row.output as Record<string, unknown> | null,
    errorMessage: row.errorMessage,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt ? row.leaseExpiresAt.getTime() : null,
    version: row.version,
    cancelRequestedAt: row.cancelRequestedAt ? row.cancelRequestedAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}
