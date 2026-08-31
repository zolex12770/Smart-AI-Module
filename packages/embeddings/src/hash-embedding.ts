/**
 * Real, deterministic feature-hashed embedding — docs/26_DECISIONS.md ADR-026. Not a
 * neural/learned embedding: this captures lexical (word-overlap) similarity, not
 * semantic meaning. Chosen over a local ML model (`@huggingface/transformers`) because
 * that library's dependency tree carries real, currently-unpatched high-severity
 * vulnerabilities (see ADR-026) — this has zero dependencies and no such risk.
 *
 * Technique: the "hashing trick" (Weinberger et al.) — each token hashes to one of N
 * buckets with a random-looking sign, term-frequency-weighted contributions accumulate
 * per bucket, and the result is L2-normalized so cosine distance behaves predictably.
 * This is a real, known information-retrieval technique, not a placeholder — documents
 * sharing vocabulary genuinely score as more similar.
 */
export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

const TOKEN_PATTERN = /[a-z0-9]+/g;

export class HashEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly dimensions = 256) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array(this.dimensions).fill(0);
    const tokens = text.toLowerCase().match(TOKEN_PATTERN) ?? [];

    for (const token of tokens) {
      const h = hash32(token);
      const bucket = h % this.dimensions;
      const sign = h & 1 ? 1 : -1;
      vector[bucket] += sign;
    }

    return l2Normalize(vector);
  }
}

function hash32(str: string): number {
  // FNV-1a — a small, fast, well-distributed non-cryptographic hash. Not used for any
  // security purpose, only bucket assignment.
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function l2Normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vector;
  return vector.map((v) => v / magnitude);
}
