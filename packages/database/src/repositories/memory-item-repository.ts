import { and, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { memoryItems, EMBEDDING_DIMENSIONS } from "../schema/index.js";

export type MemoryScope = "conversation" | "task" | "user" | "project" | "semantic";
/** How the item came to exist — see docs/08_MEMORY_ARCHITECTURE.md §4 promotion triggers. */
export type MemorySource = "user" | "extracted" | "system";

/**
 * Why the agent believes an item — docs/08 §7's "provenance visibility" control. Kept as an
 * open-ended shape rather than a closed union because a memory can be promoted from several
 * kinds of origin, and a field this store does not understand should survive a round trip.
 */
export interface MemoryProvenance {
  messageId?: string;
  conversationId?: string;
  taskId?: string;
  /** Free-form note, e.g. the extraction prompt or rule that proposed the fact. */
  note?: string;
  [key: string]: unknown;
}

/**
 * The stored fact. `ownerId` is gone (ADR-049): ownership is now two columns, because the two
 * questions it used to conflate have different answers — `projectId` is the tenant boundary
 * every read filters on, and `userId` is whose fact it is, null for project-wide memory that
 * applies to every member.
 *
 * `embedding` is deliberately NOT part of this type. It is 1536 doubles per row; returning it
 * from every list would dominate the payload, and no caller outside this repository has a use
 * for the raw vector — similarity is computed in the database (docs/08 §6), not in Node.
 */
export interface MemoryItem {
  id: string;
  projectId: string;
  userId: string | null;
  scope: MemoryScope;
  /** Conversation/task id for those scopes, so short-term memory can be retrieved narrowly. */
  subjectId: string | null;
  content: string;
  /** Null when the item was stored without a vector — it is then reachable only via listRecent. */
  embeddingModel: string | null;
  source: MemorySource;
  confidence: number;
  provenance: MemoryProvenance | null;
  /** Set when a newer item replaces this one (docs/08 §4 corrections): history, not deletion. */
  supersededById: string | null;
  lastUsedAt: Date | null;
  useCount: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryItemMatch extends MemoryItem {
  /** pgvector cosine distance in [0, 2]. Lower = more similar. */
  distance: number;
}

export interface CreateMemoryItemInput {
  id: string;
  projectId: string;
  /** Null for project-scoped memory visible to every member of the project. */
  userId?: string | null;
  scope: MemoryScope;
  subjectId?: string | null;
  content: string;
  /** Zero-padded to EMBEDDING_DIMENSIONS by packages/embeddings; omit for a non-retrievable item. */
  embedding?: number[] | null;
  /** Required whenever `embedding` is given — an unlabelled vector is unusable (ADR-048). */
  embeddingModel?: string | null;
  source?: MemorySource;
  confidence?: number;
  provenance?: MemoryProvenance | null;
}

export interface MemorySemanticSearch {
  projectId: string;
  /**
   * The requesting user. Rows belonging to a *different* user are never returned: docs/08 §6
   * states the isolation requirement in the strongest terms — "a memory fact about User A must
   * never be retrievable into a conversation with User B". Pass null for a system/background
   * caller with no user identity; it then sees only project-wide (`user_id IS NULL`) items.
   */
  userId: string | null;
  queryEmbedding: number[];
  /** Only rows embedded by this same model participate — never compare across models. */
  embeddingModel: string;
  /** Which memory levels to draw on. Empty means "none", not "all". */
  scopes: MemoryScope[];
  limit: number;
  /**
   * Cosine-distance ceiling. Without one, top-K always returns K facts, so an unrelated turn
   * gets injected with the least-irrelevant memories the store happens to hold — exactly the
   * over-retrieval docs/08 §6 warns about when it says to pull what is relevant to *this* turn.
   */
  maxDistance: number;
  /**
   * Subjects the caller is entitled to see for the *thread-scoped* levels
   * (`conversation`, `task`). Those rows belong to one thread, so semantic similarity alone
   * must not surface them elsewhere: a fact recorded in conversation A is not background for
   * conversation B, however alike the two turns read. Long-term levels (`user`, `project`,
   * `semantic`) are unaffected — they are about the user, not about a thread.
   *
   * Omit it and thread-scoped rows are excluded from semantic search entirely, which is the
   * safe default: a caller that did not say which thread it is in cannot be entitled to any.
   */
  subjectIds?: string[];
}

export interface MemoryRecentQuery {
  projectId: string;
  scope?: MemoryScope;
  /** Narrows to one conversation/task — the short-term memory levels of docs/08 §2. */
  subjectId?: string;
  /**
   * Applies the same "mine or project-wide" visibility filter as the semantic path. Optional
   * only because a project-admin listing (docs/08 §7's "view" control, scoped to project
   * memory) legitimately has no single user; omitting it inside a chat turn would leak one
   * member's `user`-scope memory to another.
   */
  userId?: string | null;
  limit?: number;
}

/**
 * Real storage and retrieval for the memory store (docs/08_MEMORY_ARCHITECTURE.md), made a
 * memory system rather than a CRUD table by ADR-051.
 *
 * Honest scope note, unchanged from before: this does not *generate* summaries or decide what
 * deserves promotion — items are created by callers. The promotion rules of docs/08 §4 live
 * above this layer; what changed is that the store now supports them (confidence, provenance,
 * supersession, use counts) instead of losing them.
 */
export interface MemoryItemRepository {
  create(input: CreateMemoryItemInput): Promise<MemoryItem>;
  /** Embedding-based retrieval — docs/08 §6. Excludes soft-deleted and superseded rows. */
  searchSemantic(params: MemorySemanticSearch): Promise<MemoryItemMatch[]>;
  /** Non-semantic retrieval: newest first, for the short-term levels and the "view" UI. */
  listRecent(query: MemoryRecentQuery): Promise<MemoryItem[]>;
  /** Feeds the recency/frequency-of-use signal docs/08 §6 pairs with similarity. */
  markUsed(ids: string[]): Promise<void>;
  /** Correction without erasure (docs/08 §4): the old item stays, pointing at its replacement. */
  supersede(projectId: string, oldId: string, newId: string): Promise<boolean>;
  softDelete(projectId: string, id: string): Promise<boolean>;
}

/**
 * The projection every read shares. Listing the columns explicitly — rather than `select()` —
 * is what keeps the embedding out of every result set; adding a column to the table will not
 * silently start shipping vectors to callers.
 */
const MEMORY_COLUMNS = {
  id: memoryItems.id,
  projectId: memoryItems.projectId,
  userId: memoryItems.userId,
  scope: memoryItems.scope,
  subjectId: memoryItems.subjectId,
  content: memoryItems.content,
  embeddingModel: memoryItems.embeddingModel,
  source: memoryItems.source,
  confidence: memoryItems.confidence,
  provenance: memoryItems.provenance,
  supersededById: memoryItems.supersededById,
  lastUsedAt: memoryItems.lastUsedAt,
  useCount: memoryItems.useCount,
  deletedAt: memoryItems.deletedAt,
  createdAt: memoryItems.createdAt,
  updatedAt: memoryItems.updatedAt,
};

/** `jsonb` comes back as `unknown`; this is the one place that narrowing happens. */
function toMemoryItem(row: Omit<MemoryItem, "provenance"> & { provenance: unknown }): MemoryItem {
  return { ...row, provenance: (row.provenance ?? null) as MemoryProvenance | null };
}

export class PgMemoryItemRepository implements MemoryItemRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: CreateMemoryItemInput): Promise<MemoryItem> {
    const embedding = input.embedding ? this.checkedEmbedding(input.embedding) : null;
    if (embedding && !input.embeddingModel) {
      throw new Error(
        "A memory item with an embedding must record `embeddingModel`: an unlabelled vector can never be safely " +
          "compared against a query vector, because there is no way to tell which model produced it (ADR-048)."
      );
    }
    const now = new Date();
    const row: MemoryItem = {
      id: input.id,
      projectId: input.projectId,
      userId: input.userId ?? null,
      scope: input.scope,
      subjectId: input.subjectId ?? null,
      content: input.content,
      embeddingModel: input.embeddingModel ?? null,
      // Defaults mirror the schema's: anything a user typed is a fact, not an inference.
      source: input.source ?? "user",
      confidence: input.confidence ?? 1,
      provenance: input.provenance ?? null,
      supersededById: null,
      lastUsedAt: null,
      useCount: 0,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(memoryItems).values({ ...row, embedding });
    return row;
  }

  async searchSemantic(params: MemorySemanticSearch): Promise<MemoryItemMatch[]> {
    // "No scopes" means no memory levels were opened for this turn — an empty IN list, not a
    // missing filter. Returning early keeps that unambiguous.
    if (params.scopes.length === 0 || params.limit <= 0) return [];
    const vectorLiteral = toVectorLiteral(this.checkedEmbedding(params.queryEmbedding));
    // Raw `<=>` through drizzle's sql template, matching `memory_embedding_hnsw`'s
    // vector_cosine_ops so the ordering uses the ANN index.
    const distance = sql<number>`${memoryItems.embedding} <=> ${vectorLiteral}::vector`;

    const rows = await this.db
      .select({ ...MEMORY_COLUMNS, distance })
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.projectId, params.projectId),
          // Ownership: mine, or the project's. Never another member's.
          params.userId === null
            ? isNull(memoryItems.userId)
            : or(eq(memoryItems.userId, params.userId), isNull(memoryItems.userId)),
          inArray(memoryItems.scope, params.scopes),
          // Thread containment — see MemorySemanticSearch.subjectIds.
          threadScopePredicate(params.subjectIds),
          isNull(memoryItems.deletedAt),
          // A superseded item is history kept for "why did it think X" (docs/08 §4/§7); it
          // must not be retrieved into a prompt, or a correction would never take effect.
          isNull(memoryItems.supersededById),
          isNotNull(memoryItems.embedding),
          eq(memoryItems.embeddingModel, params.embeddingModel),
          sql`${distance} <= ${params.maxDistance}`
        )
      )
      .orderBy(distance)
      .limit(params.limit);

    return rows.map((r) => ({ ...toMemoryItem(r), distance: r.distance }));
  }

  async listRecent(query: MemoryRecentQuery): Promise<MemoryItem[]> {
    const rows = await this.db
      .select(MEMORY_COLUMNS)
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.projectId, query.projectId),
          query.scope !== undefined ? eq(memoryItems.scope, query.scope) : undefined,
          query.subjectId !== undefined ? eq(memoryItems.subjectId, query.subjectId) : undefined,
          query.userId === undefined
            ? undefined
            : query.userId === null
              ? isNull(memoryItems.userId)
              : or(eq(memoryItems.userId, query.userId), isNull(memoryItems.userId)),
          isNull(memoryItems.deletedAt),
          isNull(memoryItems.supersededById)
        )
      )
      .orderBy(desc(memoryItems.createdAt))
      .limit(query.limit ?? 50);

    return rows.map(toMemoryItem);
  }

  async markUsed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const now = new Date();
    // One statement, not a read-modify-write per id: `use_count + 1` is evaluated by Postgres,
    // so two turns retrieving the same fact concurrently both count instead of one clobbering
    // the other's value. No project filter here on purpose — these ids come straight out of an
    // already project-scoped search, and the columns touched are usage counters that carry no
    // user content, so there is nothing a wrong id could disclose.
    await this.db
      .update(memoryItems)
      .set({ useCount: sql`${memoryItems.useCount} + 1`, lastUsedAt: now, updatedAt: now })
      .where(inArray(memoryItems.id, ids));
  }

  async supersede(projectId: string, oldId: string, newId: string): Promise<boolean> {
    const now = new Date();
    // `projectId` is in the WHERE even though both ids are expected to be siblings: that
    // expectation is exactly the kind of thing an authorization bug is made of. Scoping the
    // write makes a cross-tenant supersession impossible rather than merely unlikely.
    const updated = await this.db
      .update(memoryItems)
      .set({ supersededById: newId, updatedAt: now })
      .where(
        and(
          eq(memoryItems.projectId, projectId),
          eq(memoryItems.id, oldId),
          isNull(memoryItems.deletedAt),
          isNull(memoryItems.supersededById)
        )
      )
      .returning({ id: memoryItems.id });
    return updated.length > 0;
  }

  async softDelete(projectId: string, id: string): Promise<boolean> {
    const now = new Date();
    // docs/08 §7 asks for deletion that actually stops influencing retrieval. `deletedAt` does
    // that — every read above filters it out — while leaving the row for audit. If a hard
    // erase is ever required for a data-subject request, it is a separate, deliberate purge,
    // not the everyday delete button.
    const deleted = await this.db
      .update(memoryItems)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(memoryItems.projectId, projectId), eq(memoryItems.id, id), isNull(memoryItems.deletedAt)))
      .returning({ id: memoryItems.id });
    return deleted.length > 0;
  }

  /** Same contract as the RAG chunk store's: fail with a message that names the real mistake. */
  private checkedEmbedding(embedding: number[]): number[] {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding has ${embedding.length} dimensions but memory_items.embedding is vector(${EMBEDDING_DIMENSIONS}). ` +
          "packages/embeddings is responsible for zero-padding a narrower model's output to this width."
      );
    }
    if (!embedding.every((v) => Number.isFinite(v))) {
      throw new Error("Embedding contains a non-finite value (NaN or Infinity); pgvector cannot store it.");
    }
    return embedding;
  }
}

/** pgvector's text input format. Bound as a parameter and cast with `::vector`, never spliced. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Restricts the thread-scoped memory levels to subjects the caller is actually in. Returns a
 * predicate rather than a boolean so it composes into the same `and(...)` as every other
 * access-control clause — the containment is part of the query, not a filter applied after.
 */
function threadScopePredicate(subjectIds: string[] | undefined) {
  const notThreadScoped = notInArray(memoryItems.scope, ["conversation", "task"]);
  if (!subjectIds || subjectIds.length === 0) return notThreadScoped;
  return or(notThreadScoped, inArray(memoryItems.subjectId, subjectIds));
}
