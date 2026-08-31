import { eq } from "drizzle-orm";
import type { CreateTaskNodeInput, NodeStatus, TaskNode } from "@ai-platform/shared";
import type { DrizzleDb } from "../client.js";
import { taskNodes } from "../schema/index.js";

export interface TaskNodePatch {
  status?: NodeStatus;
  output?: Record<string, unknown> | null;
  errorMessage?: string | null;
  attemptCount?: number;
  approvedBy?: string | null;
  approvedAt?: number | null;
}

export interface TaskNodeRepository {
  create(rootTaskId: string, input: CreateTaskNodeInput): Promise<TaskNode>;
  get(id: string): Promise<TaskNode | undefined>;
  update(id: string, patch: TaskNodePatch): Promise<void>;
  listByRoot(rootTaskId: string): Promise<TaskNode[]>;
  /** Nodes left in an in-flight status — scanned on boot for crash recovery (docs/11 §4.2-4.3). */
  listInFlight(): Promise<TaskNode[]>;
}

const IN_FLIGHT_STATUSES: NodeStatus[] = ["waiting_model", "waiting_tool", "verifying", "retrying"];

export class PgTaskNodeRepository implements TaskNodeRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(rootTaskId: string, input: CreateTaskNodeInput): Promise<TaskNode> {
    const now = new Date();
    const retryPolicy = {
      maxAttempts: input.retryPolicy?.maxAttempts ?? 1,
      backoff: input.retryPolicy?.backoff ?? "none",
      classifyFailureAs: input.retryPolicy?.classifyFailureAs ?? null,
    };
    const row = {
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
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(taskNodes).values(row);
    return toNode(row);
  }

  async get(id: string): Promise<TaskNode | undefined> {
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
      })
      .where(eq(taskNodes.id, id));
  }

  async listByRoot(rootTaskId: string): Promise<TaskNode[]> {
    const rows = await this.db.select().from(taskNodes).where(eq(taskNodes.rootTaskId, rootTaskId));
    return rows.map(toNode);
  }

  async listInFlight(): Promise<TaskNode[]> {
    const rows = await this.db.select().from(taskNodes);
    return rows.filter((r) => IN_FLIGHT_STATUSES.includes(r.status as NodeStatus)).map(toNode);
  }
}

interface Row {
  id: string;
  parentId: string | null;
  rootTaskId: string;
  type: string;
  kind: string;
  status: string;
  dependsOn: unknown;
  input: unknown;
  output: unknown;
  toolId: string | null;
  modelProvider: string | null;
  retryPolicy: unknown;
  timeoutMs: number;
  verificationMethod: string;
  verificationSpec: unknown;
  approvalRequired: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  attemptCount: number;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toNode(row: Row): TaskNode {
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
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}
