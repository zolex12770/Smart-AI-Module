
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
 * LLM spend for a model call made outside the chat route — ADR-150.
 *
 * The video storyboard is one: every `POST /api/v1/videos` runs a real model call through the
 * router, and the route checked only video-seconds. No `checkLlmTokens`, no usage row — so the
 * one model call the platform makes on a user's behalf outside chat was both unbudgeted and
 * invisible in the ledger the dashboard reads.
 *
 * The PROMPT is passed to `check`, not a token count, for the same reason `EmbeddingMeter` takes
 * texts: the estimator lives in the model router, and the media package has no other reason to
 * depend on it.
 */
export interface ModelCallMeter {
  /** Refuse before spending. Throws when the budget is spent. */
  check(projectId: string, prompt: string): Promise<void>;
  record(
    projectId: string,
    call: { provider: string; model: string; inputTokens: number; outputTokens: number },
    options?: { userId?: string | null; requestId?: string; idempotencyKey?: string | null }
  ): Promise<void>;
}

/**
 * Speech spend, for the paths that synthesise outside the speech route — ADR-150.
 *
 * `processVideoScene` synthesises a narration track per scene, and nothing checked or recorded
 * it: `grep -rn "usage|quota|Meter" backend/packages/media/src` returned two prose comments and
 * no code. A long-form video is a per-scene synthesiser call for as many scenes as the user
 * asked for, so the one media path that can spend the most speech was the one path outside the
 * budget — and it wrote no `kind: "speech"` row either, so the spend was invisible as well as
 * unlimited. Same shape as `EmbeddingMeter`: the media package stays free of the usage schema
 * and the composition root owns pricing.
 */
export interface SpeechMeter {
  /** Refuse before synthesising. Throws when the budget is spent. */
  check(projectId: string, characters: number): Promise<void>;
  record(
    projectId: string,
    characters: number,
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
