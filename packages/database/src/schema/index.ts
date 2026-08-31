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
