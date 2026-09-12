import { EMBEDDING_DIMENSIONS } from "@ai-platform/database";
import { ProviderError, type EmbeddingProvider } from "@ai-platform/shared";

/**
 * The embedding boundary — docs/26_DECISIONS.md ADR-048.
 *
 * Two things happen here, and both exist because of findings in the ADR-047 audit:
 *
 * 1. **Width normalization.** Every provider produces a different width (384 for
 *    all-MiniLM, 768 for nomic-embed-text, 1536 for text-embedding-3-small, 3072 for
 *    -large). The column is a single `vector(1536)`, so vectors are zero-padded to that
 *    width. Padding with zeros is *exact* for cosine similarity — it changes neither the
 *    dot product nor either L2 norm — so distances within one model are unaffected. A model
 *    wider than the column is a hard error, never a silent truncation, because truncating
 *    would distort every distance.
 *
 * 2. **Model tagging.** The model name is stored with every vector, and retrieval filters on
 *    it. Comparing a vector from one model against a vector from another is meaningless, and
 *    the old schema had no way to prevent it. Switching models therefore does not corrupt
 *    search results — it makes the old rows invisible until they are re-embedded.
 */
export interface EmbeddedVector {
  /** Zero-padded to EMBEDDING_DIMENSIONS, ready for storage. */
  vector: number[];
  model: string;
  /** The provider's true output width, before padding. */
  dimensions: number;
}

export class EmbeddingService {
  constructor(private readonly provider: EmbeddingProvider) {}

  get model(): string {
    return this.provider.model;
  }

  get isDeterministicFallback(): boolean {
    return this.provider.isDeterministicFallback;
  }

  /** The tag stored alongside each vector and used to filter retrieval. */
  get modelTag(): string {
    return `${this.provider.name}:${this.provider.model}`;
  }

  async embed(texts: string[]): Promise<EmbeddedVector[]> {
    if (texts.length === 0) return [];
    const raw = await this.provider.embed(texts);
    if (raw.length !== texts.length) {
      throw new ProviderError(`Embedding provider returned ${raw.length} vectors for ${texts.length} inputs.`);
    }
    return raw.map((vector) => ({
      vector: padToColumnWidth(vector, this.modelTag),
      model: this.modelTag,
      dimensions: vector.length,
    }));
  }

  async embedOne(text: string): Promise<EmbeddedVector> {
    const [only] = await this.embed([text]);
    return only;
  }
}

export function padToColumnWidth(vector: number[], modelTag: string): number[] {
  if (vector.length > EMBEDDING_DIMENSIONS) {
    throw new ProviderError(
      `Embedding model ${modelTag} produces ${vector.length} dimensions, wider than the ${EMBEDDING_DIMENSIONS}-wide ` +
        `column. Truncating would distort every distance, so this is refused: widen the column and re-embed instead.`
    );
  }
  if (vector.length === EMBEDDING_DIMENSIONS) return vector;
  const padded = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (let i = 0; i < vector.length; i++) padded[i] = vector[i];
  return padded;
}

/**
 * Cosine distance, matching pgvector's `<=>` exactly, for use in tests and in any in-memory
 * ranking. Returns 1 - cosine similarity, so 0 means identical and 2 means opposite.
 */
export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 1;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
