import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { documentChunks, documents, EMBEDDING_DIMENSIONS } from "../schema/index.js";
import type { DocumentStatus } from "./document-repository.js";

/** Chunk-level metadata (page number, section heading, source offsets) — free-form jsonb. */
export type DocumentChunkMetadata = Record<string, unknown>;

export interface DocumentChunk {
  id: string;
  documentId: string;
  /** Denormalized from the parent (ADR-049) so retrieval filters by tenant without a join. */
  projectId: string;
  chunkIndex: number;
  content: string;
  /** Which model produced `embedding`. Never compare vectors across two of these (ADR-048). */
  embeddingModel: string;
  /** The model's true width before zero-padding to EMBEDDING_DIMENSIONS. */
  embeddingDims: number;
  tokenCount: number | null;
  metadata: DocumentChunkMetadata | null;
  createdAt: Date;
}

export interface DocumentChunkMatch extends DocumentChunk {
  /** pgvector cosine distance in [0, 2]. Lower = more similar. */
  distance: number;
}

/** A chunk whose parent document and project are supplied by the call, not by the row. */
export interface NewDocumentChunk {
  id: string;
  chunkIndex: number;
  content: string;
  /** Zero-padded to EMBEDDING_DIMENSIONS by packages/embeddings before it gets here. */
  embedding: number[];
  embeddingModel: string;
  embeddingDims: number;
  tokenCount?: number | null;
  metadata?: DocumentChunkMetadata | null;
}

export interface CreateDocumentChunkInput extends NewDocumentChunk {
  documentId: string;
  projectId: string;
}

export interface DocumentChunkSearch {
  /** Required. A retrieval that forgets this reads every tenant's corpus. */
  projectId: string;
  queryEmbedding: number[];
  /**
   * Required, and filtered on in SQL. Two models' vectors live in one column (schema comment
   * on EMBEDDING_DIMENSIONS); a cosine distance between them is a number with no meaning, so
   * mixing them silently degrades every ranking rather than failing loudly.
   */
  embeddingModel: string;
  limit: number;
  /**
   * Cosine-distance ceiling. Without it, `ORDER BY distance LIMIT k` always returns k rows —
   * a query with nothing relevant in the corpus still yields "top" matches, which the agent
   * then cites as evidence. With it, "no sufficiently similar chunk" is expressible, and the
   * honest answer to an unanswerable question is an empty result set.
   */
  maxDistance: number;
}

/**
 * A sane default ceiling for the feature-hashed lexical embeddings of ADR-026: those vectors
 * are L2-normalized, so cosine distance is 1 for "no shared vocabulary at all" and drops
 * toward 0 as overlap grows. 0.85 therefore admits real lexical overlap and rejects the
 * near-orthogonal noise that used to be returned as a top hit. Callers using a learned
 * embedding model should tune their own value — the right threshold is a property of the
 * model, not of this table.
 */
export const DEFAULT_MAX_COSINE_DISTANCE = 0.85;

/**
 * Parent-document transition applied inside `replaceForDocument`'s transaction. Passing this
 * is what makes a re-ingest atomic end to end: chunks and the status the API reports become
 * visible in the same commit, so a poller can never see `ready` next to a half-written index.
 */
export interface ReingestDocumentTransition {
  status: DocumentStatus;
  /** Bumps `documents.version` — the ingest generation these chunks belong to. */
  bumpVersion?: boolean;
  errorMessage?: string | null;
}

export interface DocumentChunkRepository {
  createMany(rows: CreateDocumentChunkInput[]): Promise<void>;
  /**
   * Real pgvector cosine-distance search (`<=>`) — docs/09_RAG_ARCHITECTURE.md §5. Filtered
   * by project and by embedding model, bounded by a distance threshold, ordered by distance.
   */
  search(params: DocumentChunkSearch): Promise<DocumentChunkMatch[]>;
  /**
   * The re-ingest primitive: drop this document's chunks and write the new set in ONE
   * transaction, optionally transitioning the parent document in the same commit. Between an
   * un-transactional delete and insert the document is silently unsearchable, and a crash in
   * the gap leaves it that way permanently.
   */
  replaceForDocument(
    documentId: string,
    projectId: string,
    rows: NewDocumentChunk[],
    document?: ReingestDocumentTransition
  ): Promise<void>;
  /** A hard delete: `document_chunks` has no `deletedAt`, and a derived index has no history
   * worth keeping — the parent document's soft delete is the record that it existed. */
  deleteByDocument(documentId: string, projectId: string): Promise<void>;
}

export class PgDocumentChunkRepository implements DocumentChunkRepository {
  constructor(private readonly db: DrizzleDb) {}

  async createMany(rows: CreateDocumentChunkInput[]): Promise<void> {
    if (rows.length === 0) return;
    const now = new Date();
    await this.db.insert(documentChunks).values(
      rows.map((r) => ({
        id: r.id,
        documentId: r.documentId,
        projectId: r.projectId,
        chunkIndex: r.chunkIndex,
        content: r.content,
        embedding: this.checkedEmbedding(r.embedding),
        embeddingModel: r.embeddingModel,
        embeddingDims: r.embeddingDims,
        tokenCount: r.tokenCount ?? null,
        metadata: r.metadata ?? null,
        createdAt: now,
      }))
    );
  }

  async search(params: DocumentChunkSearch): Promise<DocumentChunkMatch[]> {
    if (params.limit <= 0) return [];
    const vectorLiteral = toVectorLiteral(this.checkedEmbedding(params.queryEmbedding));
    // The raw `<=>` cosine operator, through drizzle's sql template so the vector is a bound
    // parameter rather than string-concatenated SQL. Built once and reused in the projection,
    // the threshold predicate and the ordering — SQL has no way to reference a select alias
    // from its own WHERE, so the expression genuinely has to appear more than once.
    const distance = sql<number>`${documentChunks.embedding} <=> ${vectorLiteral}::vector`;

    const rows = await this.db
      .select({
        id: documentChunks.id,
        documentId: documentChunks.documentId,
        projectId: documentChunks.projectId,
        chunkIndex: documentChunks.chunkIndex,
        content: documentChunks.content,
        embeddingModel: documentChunks.embeddingModel,
        embeddingDims: documentChunks.embeddingDims,
        tokenCount: documentChunks.tokenCount,
        metadata: documentChunks.metadata,
        createdAt: documentChunks.createdAt,
        distance,
      })
      .from(documentChunks)
      .where(
        and(
          eq(documentChunks.projectId, params.projectId),
          eq(documentChunks.embeddingModel, params.embeddingModel),
          sql`${distance} <= ${params.maxDistance}`
        )
      )
      // Matches `document_chunks_embedding_hnsw`'s vector_cosine_ops, so this stays an ANN
      // index scan instead of the sequential scan every retrieval used to be (ADR-048).
      .orderBy(distance)
      .limit(params.limit);

    return rows.map((r) => ({ ...r, metadata: (r.metadata ?? null) as DocumentChunkMetadata | null }));
  }

  async replaceForDocument(
    documentId: string,
    projectId: string,
    rows: NewDocumentChunk[],
    document?: ReingestDocumentTransition
  ): Promise<void> {
    const now = new Date();
    // Validate before opening the transaction: a bad vector should abort the re-ingest without
    // having taken a write lock on the document's existing chunks.
    const values = rows.map((r) => ({
      id: r.id,
      // Scope comes from the arguments, never from the row, so a caller physically cannot
      // write a chunk into a project it did not name.
      documentId,
      projectId,
      chunkIndex: r.chunkIndex,
      content: r.content,
      embedding: this.checkedEmbedding(r.embedding),
      embeddingModel: r.embeddingModel,
      embeddingDims: r.embeddingDims,
      tokenCount: r.tokenCount ?? null,
      metadata: r.metadata ?? null,
      createdAt: now,
    }));

    await this.db.transaction(async (tx) => {
      await tx
        .delete(documentChunks)
        .where(and(eq(documentChunks.documentId, documentId), eq(documentChunks.projectId, projectId)));
      if (values.length > 0) await tx.insert(documentChunks).values(values);
      if (document) {
        await tx
          .update(documents)
          .set({
            status: document.status,
            updatedAt: now,
            ...(document.bumpVersion ? { version: sql`${documents.version} + 1` } : {}),
            ...(document.errorMessage !== undefined ? { errorMessage: document.errorMessage } : {}),
          })
          .where(and(eq(documents.projectId, projectId), eq(documents.id, documentId)));
      }
    });
  }

  async deleteByDocument(documentId: string, projectId: string): Promise<void> {
    await this.db
      .delete(documentChunks)
      .where(and(eq(documentChunks.documentId, documentId), eq(documentChunks.projectId, projectId)));
  }

  /**
   * The column is `vector(1536)` (schema `EMBEDDING_DIMENSIONS`). Postgres would reject a
   * mismatch anyway, but with a message about dimensions that says nothing about which
   * provider produced the vector; NaN/Infinity would be rejected at parse time with even
   * less context. Failing here names the actual mistake.
   */
  private checkedEmbedding(embedding: number[]): number[] {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding has ${embedding.length} dimensions but document_chunks.embedding is vector(${EMBEDDING_DIMENSIONS}). ` +
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
