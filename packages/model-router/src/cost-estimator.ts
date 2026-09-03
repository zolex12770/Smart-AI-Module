/**
 * Real, dated, sourced per-token pricing for the exact model each real adapter currently
 * defaults to (docs/22_COST_AND_QUOTA_STRATEGY.md's `CostEstimator`) — not invented numbers.
 * Two of the three needed live research beyond docs/04_MODEL_PROVIDER_RESEARCH.md (written
 * before these exact model IDs shipped): OpenAI's `gpt-5.6-terra` short-context standard
 * tier and Google's `gemini-3.5-flash`, both confirmed via web search on 2026-09-02 (see
 * docs/26_DECISIONS.md ADR-038 for the citations). Prices are USD per 1,000,000 tokens.
 *
 * Deliberately not a database-backed `models.cost_profile` column as docs/14's target design
 * describes — a real provider's actual price changes independently of a deploy (both entries
 * researched below had already changed since docs/04 was written), so a config file that's
 * easy to update without a schema migration is the honest MVP here; a DB-backed table is a
 * real, larger undertaking (an admin UI to edit it, a migration on every price change) that
 * FR-063's P2 priority doesn't justify yet.
 */
export interface TokenPricing {
  /** USD per 1,000,000 input tokens. */
  inputPerMillion: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMillion: number;
}

const LLM_PRICING: Record<string, Record<string, TokenPricing>> = {
  anthropic: {
    // docs/04_MODEL_PROVIDER_RESEARCH.md, dated 2026-08-31.
    "claude-sonnet-5": { inputPerMillion: 2, outputPerMillion: 10 },
  },
  openai: {
    // Short-context standard tier, confirmed via web search 2026-09-02 (post the 2026-07-30
    // price cut) — docs/04 predates this model's release and has no figure for it.
    "gpt-5.6-terra": { inputPerMillion: 2, outputPerMillion: 12 },
  },
  google: {
    // Confirmed via web search 2026-09-02 — docs/04 predates this model's release. (Note:
    // a cheaper $0.75/$3.75 introductory rate reported elsewhere applies to the newer
    // gemini-3.6-flash/3.7-flash, not this model.)
    "gemini-3.5-flash": { inputPerMillion: 1.5, outputPerMillion: 9 },
  },
};

/**
 * Real cost math against the table above. Returns `null` — never a fabricated number — for
 * any provider/model combination without a researched price (e.g. the mock provider, or a
 * real provider model swapped in via `LLM_PROVIDER_MODEL` env overrides that isn't in the
 * table yet). Callers must treat `null` as "cost unknown," not "free."
 */
/**
 * A pre-flight token estimate for quota checks (docs/22_COST_AND_QUOTA_STRATEGY.md:
 * "computed via the provider's tokenizer or a close approximation") — used only to decide
 * "would this request likely push us over quota," never to record actual usage. The
 * ~4-characters-per-token heuristic is the same rough approximation OpenAI's own docs cite
 * for English text, and matches `packages/providers/llm-mock`'s own usage estimate.
 */
export function estimatePromptTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateLlmCostUsd(
  provider: string,
  model: string,
  usage: { inputTokens: number; outputTokens: number }
): number | null {
  const pricing = LLM_PRICING[provider]?.[model];
  if (!pricing) return null;
  // docs/26_DECISIONS.md ADR-045 — a real call always consumes tokens, so all-zero usage
  // means the telemetry was missing (a provider that omitted its usage block, a truncated
  // stream), not that the call was free. Returning 0 would write a confident "$0.00, priced"
  // row into the ledger; null says "unknown", which is what `pricedCallsOnly` on
  // GET /api/v1/usage already exists to make visible.
  if (usage.inputTokens <= 0 && usage.outputTokens <= 0) return null;
  return (usage.inputTokens / 1_000_000) * pricing.inputPerMillion + (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
}
