import type { Document, DocumentChunkRepository, DocumentRepository } from "@ai-platform/database";
import type { EmbeddingService } from "@ai-platform/embeddings";

/**
 * Cosine-distance ceiling for RAG retrieval, and the fix for the audit's sharpest finding:
 * `ORDER BY distance LIMIT k` *always* returns k rows, so a question with nothing relevant
 * in the corpus still came back with the k least-irrelevant chunks — which the agent then
 * quoted as evidence. A threshold makes "no sufficiently similar chunk" expressible, and an
 * empty result set is the honest answer to an unanswerable question.
 *
 * 0.6 rather than the repository's laxer `DEFAULT_MAX_COSINE_DISTANCE` (0.85, a backstop for
 * any caller of the table) because these chunks are fed to a model *as evidence*: the cost of
 * admitting a weak match here is a confidently-cited wrong answer, not a slightly worse list.
 * With the feature-hashed lexical vectors of ADR-026 — L2-normalized, so distance is 1.0 for
 * "no shared vocabulary at all" — a real topical match lands around 0.3-0.5 and unrelated
 * text sits at 0.9-1.0, so 0.6 separates them with room to spare. The right value is a
 * property of the embedding model, so it is a knob (`RetrieveDeps.maxDistance`), not a
 * constant: a learned model needs its own calibration.
 */
export const DEFAULT_RAG_MAX_DISTANCE = 0.6;

export interface RetrieveDeps {
  chunkRepo: DocumentChunkRepository;
  /**
   * Needed to answer "which document is this chunk from?" — a citation that cannot be
   * resolved to a source is not a citation (docs/09_RAG_ARCHITECTURE.md §6). It is also the
   * only thing that keeps a soft-deleted document out of retrieval: `softDelete` leaves the
   * chunks in place, so the parent lookup below is what actually removes it from results.
   */
  documentRepo: DocumentRepository;
  /** The ADR-048 embedding service: zero-pads to the column width and carries the model tag. */
  embeddings: EmbeddingService;
  /** Operator-level override of `DEFAULT_RAG_MAX_DISTANCE` for the whole deployment. */
  maxDistance?: number;
}

/** One retrieved chunk, carrying everything needed to cite it back to a real document. */
export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  /** The source document's display filename — what a human sees in a citation. */
  filename: string;
  /** Position within that document, so a citation points at a passage and not just a file. */
  chunkIndex: number;
  content: string;
  /** pgvector cosine distance in [0, 2]. Lower = more similar. */
  distance: number;
}

export interface SearchDocumentsOptions {
  /**
   * The tenant boundary (ADR-049). Threaded from the caller's authenticated scope — the tool
   * invocation context, or the API request's `AuthContext` — never defaulted, because a
   * retrieval without one reads every tenant's corpus.
   */
  projectId: string;
  query: string;
  topK?: number;
  /** Per-call override, for a caller that genuinely wants a wider or narrower net. */
  maxDistance?: number;
}

/**
 * Real pgvector cosine-distance retrieval (docs/09_RAG_ARCHITECTURE.md §5), scoped to one
 * project, filtered to one embedding model, and bounded by a distance threshold.
 *
 * Ranking quality is bounded by the embedding provider — currently a feature-hashed lexical
 * vector, not a learned semantic one (docs/26_DECISIONS.md ADR-026), so this finds chunks
 * that share vocabulary with the query, not necessarily ones that mean the same thing with
 * different words.
 */
export async function searchDocuments(
  deps: RetrieveDeps,
  options: SearchDocumentsOptions
): Promise<RetrievedChunk[]> {
  const topK = options.topK ?? 5;
  if (topK <= 0) return [];

  // A query with no tokens embeds to the zero vector, which has no direction: pgvector's
  // `<=>` yields NaN against it and every comparison with NaN is false, so the query would
  // return nothing anyway — but for a reason no one reading the code would guess. Say it here.
  if (options.query.trim() === "") return [];

  const embedded = await deps.embeddings.embedOne(options.query);
  const matches = await deps.chunkRepo.search({
    projectId: options.projectId,
    queryEmbedding: embedded.vector,
    // Vectors from two different models occupy different spaces; a distance between them is
    // a number with no meaning (ADR-048). Passing the tag makes the mismatch invisible rather
    // than wrong: rows embedded by another model simply do not match.
    embeddingModel: embedded.model,
    limit: topK,
    maxDistance: options.maxDistance ?? deps.maxDistance ?? DEFAULT_RAG_MAX_DISTANCE,
  });
  if (matches.length === 0) return [];

  // One project-scoped read per distinct source document (at most `topK`), in parallel. The
  // chunk row denormalizes `projectId` but not the filename, and a citation needs the name.
  const documentIds = [...new Set(matches.map((m) => m.documentId))];
  const documents = new Map<string, Document>();
  await Promise.all(
    documentIds.map(async (id) => {
      const document = await deps.documentRepo.get(options.projectId, id);
      if (document) documents.set(id, document);
    })
  );

  return matches.flatMap((match) => {
    const document = documents.get(match.documentId);
    // Unresolvable parent = soft-deleted (or, impossibly, another project's). Dropping the
    // chunk is the fail-closed choice twice over: a deleted document must stop being quoted,
    // and a chunk with no resolvable source could only ever be cited as `[1]` with nothing
    // behind it — the exact positional-marker problem this shape exists to end.
    if (!document) return [];
    return [
      {
        chunkId: match.id,
        documentId: match.documentId,
        filename: document.filename,
        chunkIndex: match.chunkIndex,
        content: match.content,
        distance: match.distance,
      },
    ];
  });
}

/**
 * A citation the reader can follow. `marker` is the token the model is told to write (`[1]`),
 * and the rest is what that marker resolves to — docs/09 §6: "citation that can't be verified
 * by the user is not meaningfully different from no citation."
 */
export interface RagCitation {
  marker: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
}

/** Markers are 1-based and positional *within one result set*, which is why they always
 * travel with the list that defines them rather than being stored or reused. */
export function buildCitations(results: readonly RetrievedChunk[]): RagCitation[] {
  return results.map((r, i) => ({
    marker: `[${i + 1}]`,
    documentId: r.documentId,
    filename: r.filename,
    chunkIndex: r.chunkIndex,
  }));
}

/**
 * The retrieved passages as one prompt-ready block, each prefixed with its citation marker
 * and the source it stands for. Pre-joined because packages/agent-core's template renderer
 * interpolates field paths only (see template.ts) and cannot format a list itself.
 *
 * When nothing cleared the distance threshold this says so in words. An empty string would
 * leave the model to fill the silence, which is how "no relevant documents" turns into an
 * invented answer.
 */
export function buildRagContext(results: readonly RetrievedChunk[]): string {
  if (results.length === 0) {
    return "No document passages matched this query closely enough to be used as evidence.";
  }
  return results
    .map((r, i) => `[${i + 1}] ${r.filename} (chunk ${r.chunkIndex}):\n${r.content}`)
    .join("\n\n");
}
