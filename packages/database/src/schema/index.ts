import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/**
 * Phase 1 subset of the full schema in docs/14_DATABASE_ARCHITECTURE.md — only what the
 * minimal chat loop needs. Remaining tables (tasks, jobs, memory, documents, assets, ...)
 * are added as the phases that need them land, per docs/25_IMPLEMENTATION_ROADMAP.md.
 */

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  title: text("title"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

/**
 * Task graph tables — docs/11_AGENT_LOOP.md §4.1. `taskTransitions` is append-only
 * (never UPDATE/DELETE'd): it is the source of truth for crash recovery and audit,
 * while `tasks`/`taskNodes` hold the materialized "current status" for fast reads.
 */
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  taskType: text("task_type").notNull(),
  state: text("state").notNull(),
  input: text("input", { mode: "json" }).notNull(),
  output: text("output", { mode: "json" }),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const taskNodes = sqliteTable("task_nodes", {
  id: text("id").primaryKey(),
  parentId: text("parent_id"),
  rootTaskId: text("root_task_id")
    .notNull()
    .references(() => tasks.id),
  type: text("type").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  dependsOn: text("depends_on", { mode: "json" }).notNull(),
  input: text("input", { mode: "json" }).notNull(),
  output: text("output", { mode: "json" }),
  toolId: text("tool_id"),
  modelProvider: text("model_provider"),
  retryPolicy: text("retry_policy", { mode: "json" }).notNull(),
  timeoutMs: integer("timeout_ms").notNull(),
  verificationMethod: text("verification_method").notNull(),
  verificationSpec: text("verification_spec", { mode: "json" }),
  approvalRequired: integer("approval_required", { mode: "boolean" }).notNull(),
  approvedBy: text("approved_by"),
  approvedAt: integer("approved_at", { mode: "timestamp" }),
  attemptCount: integer("attempt_count").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const taskTransitions = sqliteTable("task_transitions", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  nodeId: text("node_id"),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  actor: text("actor").notNull(),
  payload: text("payload", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id),
  role: text("role", { enum: ["system", "user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  providerUsed: text("provider_used"),
  modelUsed: text("model_used"),
  inputTokens: real("input_tokens"),
  outputTokens: real("output_tokens"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
