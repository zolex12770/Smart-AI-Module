import { describe, expect, it } from "vitest";
import { HashEmbeddingProvider } from "./hash-embedding.js";

function cosineSimilarity(a: number[], b: number[]): number {
  return a.reduce((sum, v, i) => sum + v * b[i], 0);
}

describe("HashEmbeddingProvider", () => {
  it("produces a unit-length (L2-normalized) vector of the configured dimension", async () => {
    const provider = new HashEmbeddingProvider(64);
    const [vector] = await provider.embed(["hello world"]);
    expect(vector).toHaveLength(64);
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it("is deterministic — the same text always produces the same vector", async () => {
    const provider = new HashEmbeddingProvider(128);
    const [a] = await provider.embed(["the quick brown fox"]);
    const [b] = await provider.embed(["the quick brown fox"]);
    expect(a).toEqual(b);
  });

  it("ranks a lexically-overlapping document higher than an unrelated one — the actual retrieval property RAG depends on", async () => {
    const provider = new HashEmbeddingProvider(256);
    const [query, related, unrelated] = await provider.embed([
      "What is Project Nightingale?",
      "Project Nightingale is a secret codename for the Q3 database migration.",
      "The weather in Tokyo tends to be humid during the summer months.",
    ]);

    const simRelated = cosineSimilarity(query, related);
    const simUnrelated = cosineSimilarity(query, unrelated);

    expect(simRelated).toBeGreaterThan(simUnrelated);
  });
});
