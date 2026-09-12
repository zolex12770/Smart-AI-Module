import { and, desc, eq, isNull } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { DrizzleDb } from "../client.js";
import { conversations } from "../schema/index.js";

export interface Conversation {
  id: string;
  /**
   * ADR-049: every row of user content carries its tenant, and every read below filters on
   * this column in the `WHERE`. It is not optional and there is no "global" conversation.
   */
  projectId: string;
  /** Null when the author's user row was deleted — the conversation itself survives. */
  createdByUserId: string | null;
  title: string | null;
  /**
   * Rolling summary of the turns older than the live window (ADR-051 conversation memory).
   * Null until a conversation is long enough to need one.
   */
  summary: string | null;
  /** How many messages `summary` already covers, so summarization stays incremental. */
  summarizedMessageCount: number;
  createdAt: Date;
  updatedAt: Date;
  /** Always null on anything a read returns — soft-deleted rows are excluded in SQL. */
  deletedAt: Date | null;
}

export interface CreateConversationInput {
  projectId: string;
  /** The authenticated principal, never a client-supplied name (docs/13 §6). */
  createdByUserId?: string | null;
  title?: string | null;
}

/**
 * Interface application code depends on — never the Drizzle table directly.
 * This is what makes the SQLite -> Postgres swap in Phase 6 (docs/26_DECISIONS.md
 * ADR-006) a new implementation of this interface, not a rewrite of callers.
 *
 * Every method that touches a stored conversation takes `projectId` first. That is not
 * ceremony: it is the only reason `GET /api/v1/conversations/:id/messages` cannot be turned
 * into a cross-tenant read by guessing an id (ADR-049). A conversation belonging to another
 * project is reported exactly the same way a non-existent one is — the caller gets no
 * existence oracle to probe with.
 */
export interface ConversationRepository {
  create(input: CreateConversationInput): Promise<Conversation>;
  get(projectId: string, id: string): Promise<Conversation | undefined>;
  /** Most recent first — backs the `/chat` sidebar (docs/16_FRONTEND_ARCHITECTURE.md). */
  list(projectId: string, options?: { limit?: number; offset?: number }): Promise<Conversation[]>;
  /**
   * Replaces the rolling summary and records how much of the history it covers (ADR-051).
   * Returns false when the conversation is not in this project or is already deleted, so a
   * caller can distinguish "nothing to update" from "updated" without a second read.
   */
  updateSummary(projectId: string, id: string, summary: string, summarizedMessageCount: number): Promise<boolean>;
  /**
   * Soft delete (schema `deleted_at`): the row stays readable to an admin for audit, and
   * `messages` rows are not orphaned by a cascade. Returns false if nothing matched.
   */
  delete(projectId: string, id: string): Promise<boolean>;
}

export class PgConversationRepository implements ConversationRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreateConversationInput): Promise<Conversation> {
    const now = new Date();
    const row: Conversation = {
      id: uuid(),
      projectId: input.projectId,
      createdByUserId: input.createdByUserId ?? null,
      title: input.title ?? null,
      summary: null,
      summarizedMessageCount: 0,
      createdAt: now,
      // Set on create as well as on every update (ADR-049) — a row whose `updated_at` is
      // null-or-absent until the first edit makes "recently active" queries lie.
      updatedAt: now,
      deletedAt: null,
    };
    await this.db.insert(conversations).values(row);
    return row;
  }

  async get(projectId: string, id: string): Promise<Conversation | undefined> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, id),
          // The scope check is a predicate, not a post-fetch `if (row.projectId !== ...)`.
          // Fetching first and comparing after is the shape every IDOR has (ADR-049).
          eq(conversations.projectId, projectId),
          isNull(conversations.deletedAt)
        )
      );
    return row;
  }

  async list(projectId: string, options?: { limit?: number; offset?: number }): Promise<Conversation[]> {
    // Ordered by `created_at` rather than `updated_at` so the scan rides the composite
    // `conversations_project_created_idx` instead of sorting the whole project's history.
    let query = this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.projectId, projectId), isNull(conversations.deletedAt)))
      .orderBy(desc(conversations.createdAt))
      .$dynamic();
    if (options?.limit !== undefined) query = query.limit(options.limit);
    if (options?.offset !== undefined) query = query.offset(options.offset);
    return query;
  }

  async updateSummary(
    projectId: string,
    id: string,
    summary: string,
    summarizedMessageCount: number
  ): Promise<boolean> {
    const updated = await this.db
      .update(conversations)
      .set({ summary, summarizedMessageCount, updatedAt: new Date() })
      .where(
        and(eq(conversations.id, id), eq(conversations.projectId, projectId), isNull(conversations.deletedAt))
      )
      .returning({ id: conversations.id });
    return updated.length > 0;
  }

  async delete(projectId: string, id: string): Promise<boolean> {
    const now = new Date();
    const deleted = await this.db
      .update(conversations)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(conversations.id, id),
          eq(conversations.projectId, projectId),
          // Re-deleting must not silently move `deleted_at` forward and rewrite history.
          isNull(conversations.deletedAt)
        )
      )
      .returning({ id: conversations.id });
    return deleted.length > 0;
  }
}
