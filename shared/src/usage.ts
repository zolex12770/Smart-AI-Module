
/**
 * What an embedding call must do besides embedding — docs/26_DECISIONS.md ADR-131.
 *
 * Embedding spend was recorded in exactly one place (the RAG query route, ADR-119) and incurred in
 * four. Document ingestion — by far the largest of them, an entire document's chunks in one batch,
 * re-run from the start on every retry — passed through no budget and left no trace at all, so a
 * ledger that honestly reported "embedding: 1 unit" for a question said nothing about the tens of
 * thousands of tokens an ingestion had just spent.
 *
 * It is an interface rather than a direct dependency on the quota manager because `rag` and
 * `memory` are packages that must not know about HTTP errors or the usage schema; the composition
 * root supplies the one implementation that does. Optional at every call site for the same reason
 * the ledger's aggregates are optional: a test that does not care about budgets should not have to
 * construct one, and an absent meter means "not metered here", which is visible rather than
 * silently permissive — the routes that matter always pass one.
 */
export interface EmbeddingMeter {
  /**
   * Refuse the work BEFORE it is done. Throws when the budget is spent — the caller does not
   * branch, because an embedding that must not happen must not happen.
   */
  check(projectId: string, texts: string[]): Promise<void>;
  /** Record what really happened, after it happened. */
  record(
    projectId: string,
    texts: string[],
    options?: { userId?: string | null; requestId?: string; idempotencyKey?: string | null }
  ): Promise<void>;
}

/**
 * The TEXTS are passed, not a token count, so the estimator lives in one place.
 *
 * `rag` and `memory` would otherwise each need the token estimator — which lives in the model
 * router, a package neither of them has any other reason to depend on. Handing over the strings
 * keeps the counting rule (and any later improvement to it) in the single implementation the
 * composition root builds, and keeps a retrieval package from importing an LLM package to count
 * characters.
 */
