import type { DocumentChunkMatch, DocumentChunkRepository } from "@ai-platform/database";
import type { EmbeddingProvider } from "@ai-platform/embeddings";

export interface RetrieveDeps {
  chunkRepo: DocumentChunkRepository;
  embeddings: EmbeddingProvider;
}

/**
 * Real pgvector cosine-distance retrieval (docs/09_RAG_ARCHITECTURE.md). Ranking quality
 * is bounded by the embedding provider — currently a feature-hashed lexical vector, not
 * a learned semantic one (docs/26_DECISIONS.md ADR-026), so this finds chunks that share
 * vocabulary with the query, not necessarily ones that mean the same thing with
 * different words.
 */
export async function searchDocuments(
  deps: RetrieveDeps,
  query: string,
  topK = 5
): Promise<DocumentChunkMatch[]> {
  const [queryEmbedding] = await deps.embeddings.embed([query]);
  return deps.chunkRepo.search(queryEmbedding, topK);
}
