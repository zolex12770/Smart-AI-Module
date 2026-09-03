import { pgTable, text, timestamp, jsonb, boolean, integer, doublePrecision, vector } from "drizzle-orm/pg-core";

/**
 * Postgres schema (docs/14_DATABASE_ARCHITECTURE.md) — real PostgreSQL via PGlite
 * (docs/26_DECISIONS.md ADR-025), not SQLite (superseded ADR-006/ADR-016 as of Phase 6).
 * Embedding dimension (256) matches packages/embeddings' feature-hashed vector size
 * (ADR-026) — a real embeddings API would need a different, provider-specific dimension,
 * tracked as part of that future migration, not assumed compatible with this column.
 */
const EMBEDDING_DIMENSIONS = 256;

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  title: text("title"),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * Task graph tables — docs/11_AGENT_LOOP.md §4.1. `taskTransitions` is append-only
 * (never UPDATE/DELETE'd): it is the source of truth for crash recovery and audit,
 * while `tasks`/`taskNodes` hold the materialized "current status" for fast reads.
 */
export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  taskType: text("task_type").notNull(),
  state: text("state").notNull(),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const taskNodes = pgTable("task_nodes", {
  id: text("id").primaryKey(),
  parentId: text("parent_id"),
  rootTaskId: text("root_task_id")
    .notNull()
    .references(() => tasks.id),
  type: text("type").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  dependsOn: jsonb("depends_on").notNull(),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  toolId: text("tool_id"),
  modelProvider: text("model_provider"),
  retryPolicy: jsonb("retry_policy").notNull(),
  timeoutMs: integer("timeout_ms").notNull(),
  verificationMethod: text("verification_method").notNull(),
  verificationSpec: jsonb("verification_spec"),
  approvalRequired: boolean("approval_required").notNull(),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at"),
  attemptCount: integer("attempt_count").notNull().default(0),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const taskTransitions = pgTable("task_transitions", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  nodeId: text("node_id"),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  actor: text("actor").notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").notNull(),
});

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id),
  role: text("role", { enum: ["system", "user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  providerUsed: text("provider_used"),
  modelUsed: text("model_used"),
  inputTokens: doublePrecision("input_tokens"),
  outputTokens: doublePrecision("output_tokens"),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * RAG tables (docs/09_RAG_ARCHITECTURE.md) — pgvector co-located with the owning row,
 * per that doc's §5.3 reasoning (same transactional unit, no dual-write consistency
 * problem). `embedding` is the feature-hashed vector from packages/embeddings
 * (docs/26_DECISIONS.md ADR-026) — lexical/keyword similarity, not learned semantic
 * similarity, until a real embeddings provider is configured.
 */
export const documents = pgTable("documents", {
  id: text("id").primaryKey(),
  filename: text("filename").notNull(),
  sourcePath: text("source_path").notNull(),
  status: text("status", { enum: ["ingesting", "ready", "failed"] }).notNull(),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * No ANN index (HNSW/IVFFlat) yet — a plain sequential cosine-distance scan is correct
 * and fast enough at current data volumes; adding one requires the vector extension to
 * already be enabled before migration, and is a scale optimization, not a correctness
 * requirement. Revisit alongside the pgvector-vs-dedicated-vector-DB migration trigger
 * already documented in docs/09_RAG_ARCHITECTURE.md.
 */
export const documentChunks = pgTable("document_chunks", {
  id: text("id").primaryKey(),
  documentId: text("document_id")
    .notNull()
    .references(() => documents.id),
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * Memory items (docs/08_MEMORY_ARCHITECTURE.md, FR-030/FR-032) — user-visible,
 * user-deletable facts/summaries. Honest scope note (PROJECT_STATUS.md): this stores and
 * serves memory items for real, but does not yet *generate* them via LLM summarization
 * (needs a real model, same constraint as the planner/coding agent — ADR-018/ADR-022).
 */
export const memoryItems = pgTable("memory_items", {
  id: text("id").primaryKey(),
  scope: text("scope", { enum: ["conversation", "task", "user", "project", "semantic"] }).notNull(),
  ownerId: text("owner_id").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * Generic asset storage record (docs/14_DATABASE_ARCHITECTURE.md's `assets` table, rule
 * 20 of the original brief). `storagePath` is whatever the `AssetStore` that wrote the row
 * understands (docs/26_DECISIONS.md ADR-040): an absolute local path from `LocalAssetStore`,
 * a `gs://bucket/object` URI from `CloudStorageAssetStore` — exactly as this comment
 * predicted, the column's interpretation changed, not the schema. Only those stores may
 * read it.
 */
export const assets = pgTable("assets", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["image", "video", "audio", "document", "other"] }).notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storagePath: text("storage_path").notNull(),
  checksum: text("checksum").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * One row per image generation request (docs/05_IMAGE_GENERATION_RESEARCH.md). Every
 * call — mock or real — runs through the async job system (docs/07 §1.6 "mock-provider
 * parity"), so this mirrors `documents`' pending/ready/failed pattern rather than
 * resolving inline.
 */
export const imageGenerations = pgTable("image_generations", {
  id: text("id").primaryKey(),
  prompt: text("prompt").notNull(),
  request: jsonb("request").notNull(),
  status: text("status", { enum: ["pending", "processing", "succeeded", "failed"] }).notNull(),
  providerName: text("provider_name"),
  resultAssetId: text("result_asset_id"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * Long-form video pipeline (docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md Part 2), narrowed for
 * the Phase 9 MVP (docs/26_DECISIONS.md ADR-030): this is a deliberately smaller data model
 * than docs/07 §2.4's full design (`SceneManifest`/`Timeline`/`AudioTrack`/`SubtitleTrack`/
 * `RenderJob`). There is no real LLM key to write a script (stage 1) or reference
 * images/seeds to enforce cross-scene consistency (stage 4), and no `AudioProvider`/
 * `MusicProvider`/subtitle stage exists yet — so this table folds "timeline" and "render"
 * concerns directly onto the project row instead of the full separate-table model, and
 * `video_scenes` carries only what stage 2/3/resumability actually need today. Revisit
 * this narrowing once a real LLM key and audio/subtitle providers exist.
 */
export const videoProjects = pgTable("video_projects", {
  id: text("id").primaryKey(),
  prompt: text("prompt").notNull(),
  targetDurationSeconds: integer("target_duration_seconds").notNull(),
  sceneClipSeconds: integer("scene_clip_seconds").notNull(),
  sceneCount: integer("scene_count").notNull(),
  status: text("status", {
    enum: ["generating_scenes", "assembling", "succeeded", "partially_succeeded", "failed"],
  }).notNull(),
  renderStatus: text("render_status", {
    enum: ["pending", "processing", "succeeded", "skipped_no_ffmpeg", "failed"],
  }),
  renderAssetId: text("render_asset_id"),
  renderError: text("render_error"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * One row per scene (docs/07 §2.2 stages 2/3, §2.3 resumability) — `status` transitions are
 * checked by the orchestrator *before* (re-)enqueuing a scene's generation job so an
 * already-`succeeded` scene is never regenerated as a side effect of re-running the project
 * (docs/07 §2.3 point 3), which is the literal mechanism behind "only scene 37 regenerates".
 */
export const videoScenes = pgTable("video_scenes", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => videoProjects.id),
  sceneIndex: integer("scene_index").notNull(),
  shotDescription: text("shot_description").notNull(),
  durationSeconds: integer("duration_seconds").notNull(),
  status: text("status", { enum: ["pending", "processing", "succeeded", "failed"] }).notNull(),
  jobId: text("job_id"),
  assetId: text("asset_id"),
  retryCount: integer("retry_count").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * One row per real generation call (docs/22_COST_AND_QUOTA_STRATEGY.md "Usage recording"),
 * normalized across the three kinds this platform makes so quota checks (FR-063) and a
 * usage dashboard (FR-061) can run one query pattern instead of three different ones —
 * kept deliberately separate from `messages.inputTokens/outputTokens` (which already
 * records LLM usage per-message for a different purpose, the conversation audit trail) and
 * from `image_generations`/`video_scenes` (which have no usage/cost columns at all). Single-
 * operator scope (docs/26_DECISIONS.md ADR-008, matching `rag.ts`'s `SINGLE_OPERATOR_OWNER_ID`
 * pattern) — no `user_id`/`project_id` column, since there is exactly one operator today;
 * add one the same day real multi-user auth exists, not before.
 */
export const usageRecords = pgTable("usage_records", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["llm", "image", "video"] }).notNull(),
  provider: text("provider").notNull(),
  model: text("model"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  units: integer("units"),
  // Null, not zero, when no researched price exists for this provider/model
  // (packages/model-router's cost-estimator.ts) — never a fabricated cost.
  estimatedCostUsd: doublePrecision("estimated_cost_usd"),
  requestId: text("request_id"),
  createdAt: timestamp("created_at").notNull(),
});
