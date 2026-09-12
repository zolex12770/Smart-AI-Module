import { z } from "zod";

/**
 * Task graph + state machine types — implements docs/11_AGENT_LOOP.md.
 *
 * Scope note (honest, not a silent gap): this increment implements `atomic` nodes
 * scheduled purely via `dependsOn`, which docs/11_AGENT_LOOP.md §3.2 explains is
 * sufficient to express sequential AND parallel execution without a special
 * container type. `sequential_group` / `parallel_group` / `conditional` / `loop` /
 * `sub_agent` are reserved in the enum for schema stability but NOT yet executed by
 * the dispatcher (backend/packages/agent-core/src/dispatcher.ts) — see PROJECT_STATUS.md.
 */

export const taskStateSchema = z.enum([
  "IDLE",
  "UNDERSTANDING",
  "PLANNING",
  "WAITING_FOR_APPROVAL",
  "EXECUTING",
  "WAITING_FOR_MODEL",
  "WAITING_FOR_TOOL",
  "VERIFYING",
  "RETRYING",
  "PAUSED",
  "CANCELLED",
  "COMPLETED",
  "FAILED",
]);
export type TaskState = z.infer<typeof taskStateSchema>;

export const nodeStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "waiting_approval",
  "waiting_tool",
  "waiting_model",
  "needs_reconciliation", // docs/11 §4.3 — crash recovery found an in-flight mutating tool call
  "verifying",
  "retrying",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

export const nodeTypeSchema = z.enum([
  "atomic",
  "sequential_group",
  "parallel_group",
  "conditional",
  "loop",
  "sub_agent",
]);
export type NodeType = z.infer<typeof nodeTypeSchema>;

export const verificationMethodSchema = z.enum([
  "none",
  "schema_check",
  "deterministic_compare",
  /**
   * Is the answer supported by the passages retrieval actually returned? (ADR-075)
   *
   * Distinct from `schema_check`, which only proves a `content` key exists. A real model asked
   * a question with zero retrieved passages answered by citing "Document 12" — a document that
   * did not exist — so shape alone is not evidence of grounding.
   */
  "grounding_check",
  "test_suite",
  "model_judge",
  "human",
]);
export type VerificationMethod = z.infer<typeof verificationMethodSchema>;

export const failureClassSchema = z.enum(["retryable-execution", "plan-invalidating"]);
export type FailureClass = z.infer<typeof failureClassSchema>;

export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).default(1),
  backoff: z.enum(["none", "fixed", "exponential"]).default("none"),
  classifyFailureAs: failureClassSchema.nullable().default(null),
});
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

/**
 * The three atomic executors. `reasoning` is what unifies the two agent architectures
 * (docs/26_DECISIONS.md ADR-064): a `model_call` node asks the model once and takes what it
 * says, whereas a `reasoning` node hands the model the project's tools and lets it decide for
 * itself how many turns and which actions the task needs. The task graph remains the
 * orchestration and state layer; the intelligence inside one node is the model's.
 */
export const nodeKindSchema = z.enum(["model_call", "tool_call", "reasoning"]);
export type NodeKind = z.infer<typeof nodeKindSchema>;

export const taskNodeSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  rootTaskId: z.string(),
  type: nodeTypeSchema,
  kind: nodeKindSchema, // which of the two atomic executors this node uses
  status: nodeStatusSchema,
  dependsOn: z.array(z.string()),

  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).nullable(),

  toolId: z.string().nullable(), // set when kind === "tool_call"
  modelProvider: z.string().nullable(), // set when kind === "model_call"; null = router default

  retryPolicy: retryPolicySchema,
  timeoutMs: z.number().int().positive(),

  verificationMethod: verificationMethodSchema,
  verificationSpec: z.record(z.string(), z.unknown()).nullable(),

  approvalRequired: z.boolean(),
  approvedBy: z.string().nullable(),
  approvedAt: z.number().nullable(),

  attemptCount: z.number().int().min(0),
  errorMessage: z.string().nullable(),

  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TaskNode = z.infer<typeof taskNodeSchema>;

export const createTaskNodeInputSchema = taskNodeSchema.pick({
  id: true,
  parentId: true,
  type: true,
  kind: true,
  dependsOn: true,
  input: true,
  toolId: true,
  modelProvider: true,
  timeoutMs: true,
  verificationMethod: true,
  verificationSpec: true,
  approvalRequired: true,
}).partial({
  parentId: true,
  toolId: true,
  modelProvider: true,
  verificationSpec: true,
}).extend({
  retryPolicy: retryPolicySchema.partial().optional(),
});
export type CreateTaskNodeInput = z.infer<typeof createTaskNodeInputSchema>;

export const taskTypeSchema = z.enum([
  "echo_chat",
  "read_and_summarize",
  "delete_sandbox_file",
  "mcp_read_and_summarize",
  "fix_failing_test",
  "answer_from_documents",
  /**
   * The open-ended type: no fixed plan, no hardcoded steps. The model receives the goal and
   * the tools it is allowed to use and drives the task itself (ADR-064). Every other type
   * above is a deterministic recipe kept because it is cheap, predictable and well-tested;
   * this one is what the platform does when the work is not known in advance.
   */
  "autonomous",
]);
export type TaskType = z.infer<typeof taskTypeSchema>;

export const createTaskRequestSchema = z.object({
  taskType: taskTypeSchema,
  input: z.record(z.string(), z.unknown()),
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export interface Task {
  id: string;
  taskType: TaskType;
  state: TaskState;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Append-only per docs/11_AGENT_LOOP.md §4.1 — never updated or deleted, only inserted. */
export interface TaskTransition {
  id: string;
  taskId: string;
  nodeId: string | null; // null = root-task-level transition
  fromState: string | null;
  toState: string;
  actor: string; // e.g. "engine", "user:<id>", "system:crash-recovery"
  payload: Record<string, unknown> | null;
  createdAt: number;
}

export type TaskEvent =
  | { type: "state"; taskId: string; state: TaskState }
  | { type: "node"; taskId: string; node: TaskNode }
  | { type: "transition"; taskId: string; transition: TaskTransition }
  | { type: "completed"; taskId: string; output: Record<string, unknown> }
  | { type: "failed"; taskId: string; error: string };
