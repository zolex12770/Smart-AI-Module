import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  doublePrecision,
  vector,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Postgres schema (docs/14_DATABASE_ARCHITECTURE.md) — real PostgreSQL via PGlite locally
 * (docs/26_DECISIONS.md ADR-025) or a standalone server via DATABASE_URL (ADR-037).
 *
 * Two schema-wide rules, both introduced by ADR-049 and applied without exception below:
 *
 * 1. **Every row of user content carries `project_id`.** Authorization is enforced in the
 *    SQL `WHERE`, never by fetching a row and then checking its owner — that is the
 *    difference between an access control and an IDOR waiting to happen. Child tables
 *    (messages, task_nodes, document_chunks, video_scenes) inherit scope through a
 *    NOT NULL FK to a parent that carries it, and are always read through that parent.
 * 2. **Every timestamp is `timestamptz`.** `timestamp` without a zone is interpreted in the
 *    client's local time by node-postgres, which would make quota day/month windows depend
 *    on the server's timezone. Storing an instant removes the ambiguity.
 */

/**
 * Vector width. Any embedding provider's output is zero-padded to this width by
 * backend/packages/embeddings before storage; the model and its true width are recorded alongside.
 * Zero-padding is exact for cosine similarity — appending zeros changes neither the dot
 * product nor either norm — so a 384-dim local model and a 1536-dim hosted model can share
 * one column without distorting distances *within* a model. `embedding_model` exists so a
 * query never compares vectors produced by two different models (ADR-048).
 */
export const EMBEDDING_DIMENSIONS = 1536;

// ---------------------------------------------------------------------------------------
// Identity and tenancy (ADR-049)
// ---------------------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    /** scrypt hash, encoded `scrypt$N$r$p$salt$hash`. Never a plaintext or reversible value. */
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status", { enum: ["active", "suspended", "deleted"] }).notNull().default("active"),
    /** Platform operator. Distinct from org `owner`: this is cross-tenant. */
    isSystemAdmin: boolean("is_system_admin").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Consecutive failed logins; reset on success. Drives temporary lockout. */
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)]
);

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("org_members_org_user_unique").on(t.organizationId, t.userId),
    index("org_members_user_idx").on(t.userId),
  ]
);

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** Soft delete: a deleted project's content stays readable to an admin for audit. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("projects_org_idx").on(t.organizationId)]
);

export const projectMembers = pgTable(
  "project_members",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["admin", "editor", "viewer"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("project_members_project_user_unique").on(t.projectId, t.userId),
    index("project_members_user_idx").on(t.userId),
  ]
);

/**
 * Sessions store only a SHA-256 of the token. A database dump therefore cannot be replayed
 * as a set of live sessions — the same reasoning that applies to password hashes.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("sessions_token_hash_unique").on(t.tokenHash), index("sessions_user_idx").on(t.userId)]
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** SHA-256 of the secret. The plaintext is shown exactly once, at creation. */
    keyHash: text("key_hash").notNull(),
    /** Non-secret display prefix, e.g. `aip_live_ab12`, so a user can identify a key. */
    keyPrefix: text("key_prefix").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("api_keys_hash_unique").on(t.keyHash),
    index("api_keys_project_idx").on(t.projectId),
    index("api_keys_user_idx").on(t.userId),
  ]
);

/**
 * Append-only security audit trail (docs/13 §6). Never updated, never deleted by
 * application code. Records the authenticated principal, not a client-supplied name.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    outcome: text("outcome", { enum: ["success", "denied", "failure"] }).notNull(),
    method: text("method", { enum: ["session", "api_key", "system"] }).notNull(),
    ipAddress: text("ip_address"),
    requestId: text("request_id"),
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("audit_project_created_idx").on(t.projectId, t.createdAt),
    index("audit_user_created_idx").on(t.userId, t.createdAt),
    index("audit_action_idx").on(t.action),
  ]
);

// ---------------------------------------------------------------------------------------
// Conversations and chat
// ---------------------------------------------------------------------------------------

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title"),
    /** Rolling summary of turns older than the live window (ADR-051 conversation memory). */
    summary: text("summary"),
    /** How many messages the summary already covers, so summarization is incremental. */
    summarizedMessageCount: integer("summarized_message_count").notNull().default(0),
    /**
     * SHA-256 over the turns the summary covers (ADR-110). A count alone is a POSITION in whatever
     * array the client sent, so an edited, branched or reloaded history silently misaligned it and
     * turns fell into neither the summary nor the live window. The fingerprint lets a request
     * prove the prefix it is about to trust is the prefix that was summarized.
     */
    summaryFingerprint: text("summary_fingerprint"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("conversations_project_created_idx").on(t.projectId, t.createdAt)]
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["system", "user", "assistant", "tool"] }).notNull(),
    content: text("content").notNull(),
    /** Tool calls the assistant asked for, and the id a tool message answers (ADR-047). */
    toolCalls: jsonb("tool_calls"),
    toolCallId: text("tool_call_id"),
    providerUsed: text("provider_used"),
    modelUsed: text("model_used"),
    inputTokens: doublePrecision("input_tokens"),
    outputTokens: doublePrecision("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("messages_conversation_created_idx").on(t.conversationId, t.createdAt)]
);

// ---------------------------------------------------------------------------------------
// Agent task graph — docs/11_AGENT_LOOP.md §4.1
// ---------------------------------------------------------------------------------------

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    taskType: text("task_type").notNull(),
    state: text("state").notNull(),
    input: jsonb("input").notNull(),
    output: jsonb("output"),
    errorMessage: text("error_message"),
    /**
     * Distributed execution lease (ADR-052). A process may only dispatch a task whose lease
     * it holds; the lease expires so a crashed process cannot strand a task forever. This is
     * what makes two API instances against one database safe.
     */
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Optimistic concurrency guard for state transitions. */
    version: integer("version").notNull().default(0),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("tasks_project_created_idx").on(t.projectId, t.createdAt),
    index("tasks_state_idx").on(t.state),
    index("tasks_lease_idx").on(t.leaseExpiresAt),
  ]
);

export const taskNodes = pgTable(
  "task_nodes",
  {
    id: text("id").primaryKey(),
    parentId: text("parent_id"),
    rootTaskId: text("root_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
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
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    /** When a retry becomes eligible — this is what makes `retryPolicy.backoff` real. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /** Set while a node is executing, so a timeout can be enforced and detected. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    failureClass: text("failure_class"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("task_nodes_root_idx").on(t.rootTaskId),
    index("task_nodes_status_idx").on(t.status),
    index("task_nodes_next_attempt_idx").on(t.nextAttemptAt),
  ]
);

export const taskTransitions = pgTable(
  "task_transitions",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    nodeId: text("node_id"),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    actor: text("actor").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("task_transitions_task_created_idx").on(t.taskId, t.createdAt)]
);

// ---------------------------------------------------------------------------------------
// RAG — docs/09_RAG_ARCHITECTURE.md
// ---------------------------------------------------------------------------------------

export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    filename: text("filename").notNull(),
    sourcePath: text("source_path"),
    assetId: text("asset_id").references(() => assets.id),
    status: text("status", { enum: ["scanning", "ingesting", "ready", "failed", "rejected"] }).notNull(),
    scanStatus: text("scan_status", { enum: ["pending", "clean", "infected", "skipped_no_scanner"] }),
    errorMessage: text("error_message"),
    /** Bumped on re-ingest so stale chunks can be identified and removed transactionally. */
    version: integer("version").notNull().default(1),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("documents_project_created_idx").on(t.projectId, t.createdAt),
    index("documents_status_idx").on(t.status),
    index("documents_asset_idx").on(t.assetId),
  ]
);

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** Denormalized from the parent so retrieval can filter by project without a join. */
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    /** Lexical search vector maintained alongside the embedding for hybrid retrieval. */
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingDims: integer("embedding_dims").notNull(),
    tokenCount: integer("token_count"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("document_chunks_document_idx").on(t.documentId),
    index("document_chunks_project_idx").on(t.projectId),
    // ANN index (ADR-048). Without it every retrieval was a sequential scan over every
    // chunk in the database; with it, cosine search stays sub-linear as the corpus grows.
    index("document_chunks_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ]
);

// ---------------------------------------------------------------------------------------
// Memory — docs/08_MEMORY_ARCHITECTURE.md, made real by ADR-051
// ---------------------------------------------------------------------------------------

export const memoryItems = pgTable(
  "memory_items",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Null for project-scoped memory that applies to every member. */
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["conversation", "task", "user", "project", "semantic"] }).notNull(),
    /** Conversation/task id for those scopes, so short-term memory can be retrieved narrowly. */
    subjectId: text("subject_id"),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text("embedding_model"),
    /** How the item came to exist — `user` (typed it) or `extracted` (model proposed it). */
    source: text("source", { enum: ["user", "extracted", "system"] }).notNull().default("user"),
    /** Extraction confidence in [0,1]; 1 for anything a user wrote themselves. */
    confidence: doublePrecision("confidence").notNull().default(1),
    /** Provenance: the message/task this was learned from. */
    provenance: jsonb("provenance"),
    /** Set when a newer item replaces this one, keeping history rather than deleting it. */
    supersededById: text("superseded_by_id"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    useCount: integer("use_count").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("memory_project_scope_idx").on(t.projectId, t.scope),
    index("memory_subject_idx").on(t.subjectId),
    index("memory_user_idx").on(t.userId),
    index("memory_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ]
);

// ---------------------------------------------------------------------------------------
// Assets and media
// ---------------------------------------------------------------------------------------

export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    /** Null only for assets created before a project existed; new rows always carry one. */
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["image", "video", "audio", "document", "other"] }).notNull(),
    mimeType: text("mime_type").notNull(),
    /** bigint-safe: sizes beyond 2 GB must not silently overflow. */
    sizeBytes: doublePrecision("size_bytes").notNull(),
    storagePath: text("storage_path").notNull(),
    checksum: text("checksum").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("assets_project_idx").on(t.projectId), index("assets_kind_idx").on(t.kind)]
);

export const imageGenerations = pgTable(
  "image_generations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    prompt: text("prompt").notNull(),
    request: jsonb("request").notNull(),
    status: text("status", { enum: ["pending", "processing", "succeeded", "failed", "cancelled"] }).notNull(),
    providerName: text("provider_name"),
    modelName: text("model_name"),
    resultAssetId: text("result_asset_id").references(() => assets.id, { onDelete: "set null" }),
    errorMessage: text("error_message"),
    attemptCount: integer("attempt_count").notNull().default(0),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("image_generations_project_created_idx").on(t.projectId, t.createdAt),
    index("image_generations_status_idx").on(t.status),
  ]
);

export const videoProjects = pgTable(
  "video_projects",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    prompt: text("prompt").notNull(),
    /** Model-written script and storyboard (ADR-053), null until that stage completes. */
    script: jsonb("script"),
    targetDurationSeconds: integer("target_duration_seconds").notNull(),
    sceneClipSeconds: integer("scene_clip_seconds").notNull(),
    sceneCount: integer("scene_count").notNull(),
    status: text("status", {
      enum: [
        "planning",
        "generating_scenes",
        "assembling",
        "succeeded",
        "partially_succeeded",
        "failed",
        "cancelled",
      ],
    }).notNull(),
    renderStatus: text("render_status", {
      enum: ["pending", "processing", "succeeded", "skipped_no_ffmpeg", "failed"],
    }),
    renderAssetId: text("render_asset_id").references(() => assets.id, { onDelete: "set null" }),
    renderError: text("render_error"),
    /** Guards against two settling scenes enqueuing two render jobs (ADR-053). */
    renderRequestedAt: timestamp("render_requested_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("video_projects_project_created_idx").on(t.projectId, t.createdAt),
    index("video_projects_status_idx").on(t.status),
  ]
);

export const videoScenes = pgTable(
  "video_scenes",
  {
    id: text("id").primaryKey(),
    videoProjectId: text("video_project_id")
      .notNull()
      .references(() => videoProjects.id, { onDelete: "cascade" }),
    sceneIndex: integer("scene_index").notNull(),
    shotDescription: text("shot_description").notNull(),
    narration: text("narration"),
    durationSeconds: integer("duration_seconds").notNull(),
    status: text("status", { enum: ["pending", "processing", "succeeded", "failed", "cancelled"] }).notNull(),
    jobId: text("job_id"),
    assetId: text("asset_id").references(() => assets.id, { onDelete: "set null" }),
    audioAssetId: text("audio_asset_id").references(() => assets.id, { onDelete: "set null" }),
    retryCount: integer("retry_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("video_scenes_project_index_unique").on(t.videoProjectId, t.sceneIndex),
    index("video_scenes_status_idx").on(t.status),
  ]
);

// ---------------------------------------------------------------------------------------
// Usage and quota
// ---------------------------------------------------------------------------------------

export const usageRecords = pgTable(
  "usage_records",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["llm", "embedding", "image", "video", "tool"] }).notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    units: doublePrecision("units"),
    estimatedCostUsd: doublePrecision("estimated_cost_usd"),
    requestId: text("request_id"),
    /**
     * Caller-supplied natural key. A unique index on it makes usage recording idempotent:
     * a retried job cannot double-charge (ADR-054).
     */
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("usage_project_created_idx").on(t.projectId, t.createdAt),
    index("usage_kind_created_idx").on(t.kind, t.createdAt),
    uniqueIndex("usage_idempotency_unique").on(t.idempotencyKey),
  ]
);

// ---------------------------------------------------------------------------------------
// Rate limiting (ADR-071)
// ---------------------------------------------------------------------------------------

/**
 * Shared counters for the API rate limiter.
 *
 * Deliberately NOT project-scoped, and the only table here that isn't. Every other table
 * carries `project_id` because it holds a tenant's content and the authorization model is a
 * SQL predicate over that column (ADR-049). This holds no content: the key is whatever the
 * limiter names — a client IP for the global limit, a user id for a per-user one — and it is
 * infrastructure state that exists precisely to be shared across API instances, which is the
 * whole point of moving it out of each instance's memory.
 *
 * The counter is advanced by a single atomic upsert (see PgRateLimitStore), so N instances
 * enforce ONE limit rather than N copies of it. `expires_at` both bounds the window and marks
 * rows for reaping; there is no separate "window start" column because a fixed window is fully
 * described by when it ends.
 */
export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("rate_limit_expires_idx").on(t.expiresAt)]
);

// ---------------------------------------------------------------------------------------
// Relations — enables drizzle's relational query API instead of hand-rolled joins.
// ---------------------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  organizationMemberships: many(organizationMembers),
  projectMemberships: many(projectMembers),
  sessions: many(sessions),
  apiKeys: many(apiKeys),
}));

export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(organizationMembers),
  projects: many(projects),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [projects.organizationId],
    references: [organizations.id],
  }),
  members: many(projectMembers),
  conversations: many(conversations),
  documents: many(documents),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  project: one(projects, { fields: [conversations.projectId], references: [projects.id] }),
  messages: many(messages),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  project: one(projects, { fields: [documents.projectId], references: [projects.id] }),
  chunks: many(documentChunks),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  nodes: many(taskNodes),
}));

export const videoProjectsRelations = relations(videoProjects, ({ one, many }) => ({
  project: one(projects, { fields: [videoProjects.projectId], references: [projects.id] }),
  scenes: many(videoScenes),
}));
