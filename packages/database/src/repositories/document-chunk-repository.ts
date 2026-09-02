import { eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { documentChunks } from "../schema/index.js";

export interface DocumentChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  createdAt: Date;
}

export interface DocumentChunkMatch extends DocumentChunk {
  distance: number;
}

export interface DocumentChunkRepository {
  createMany(rows: Array<{ id: string; documentId: string; chunkIndex: number; content: string; embedding: number[] }>): Promise<void>;
  /** Real pgvector cosine-distance search (`<=>`) — docs/09_RAG_ARCHITECTURE.md. Lower distance = more similar. */
  search(queryEmbedding: number[], limit: number): Promise<DocumentChunkMatch[]>;
  deleteByDocument(documentId: string): Promise<void>;
}

export class PgDocumentChunkRepository implements DocumentChunkRepository {
  constructor(private readonly db: DrizzleDb) {}

  async createMany(
    rows: Array<{ id: string; documentId: string; chunkIndex: number; content: string; embedding: number[] }>
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(documentChunks).values(
      rows.map((r) => ({
        id: r.id,
        documentId: r.documentId,
        chunkIndex: r.chunkIndex,
        content: r.content,
        embedding: r.embedding,
        createdAt: new Date(),
      }))
    );
  }

  async search(queryEmbedding: number[], limit: number): Promise<DocumentChunkMatch[]> {
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    // `.execute()`'s return type is generic over the driver's query-result HKT, which
    // DrizzleDb (docs/26_DECISIONS.md ADR-037) deliberately leaves abstract so repositories
    // stay dialect-agnostic — both PGlite's and node-postgres's real result objects carry
    // `.rows` at runtime (the standard `pg`-style convention both follow), so this cast
    // reflects an actual stable shape, not a fudge.
    const result = (await this.db.execute(
      sql`select id, document_id, chunk_index, content, created_at,
                 embedding <=> ${vectorLiteral}::vector as distance
          from document_chunks
          order by distance asc
          limit ${limit}`
    )) as {
      rows: Array<{
        id: string;
        document_id: string;
        chunk_index: number;
        content: string;
        created_at: Date;
        distance: number;
      }>;
    };
    return result.rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      chunkIndex: r.chunk_index,
      content: r.content,
      createdAt: r.created_at,
      distance: r.distance,
    }));
  }

  async deleteByDocument(documentId: string): Promise<void> {
    await this.db.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
  }
}
