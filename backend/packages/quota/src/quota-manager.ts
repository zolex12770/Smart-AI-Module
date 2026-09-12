/**
 * The slice of the usage ledger the quota manager reads. `UsageRecordRepository`
 * (packages/database) satisfies it structurally, so nothing needs to adapt anything — but
 * declaring it here keeps the dependency to "four aggregates", not the whole repository.
 *
 * `sumEmbeddingTokensSince` is optional because that aggregate does not exist on the
 * repository yet: embedding spend *is* recorded (`usage_records.kind = 'embedding'`,
 * ADR-049) but nothing sums it. Marking it required would make the package unimplementable;
 * pretending embeddings were unmeterable would drop the kind entirely. Optional states the
 * situation exactly, and `checkEmbeddingTokens` below refuses rather than guesses when an
 * operator configures a limit this ledger cannot measure.
 */
export interface QuotaUsageLedger {
  sumLlmTokensSince(projectId: string, since: Date): Promise<number>;
  countImagesSince(projectId: string, since: Date): Promise<number>;
  sumVideoSecondsSince(projectId: string, since: Date): Promise<number>;
  sumEmbeddingTokensSince?(projectId: string, since: Date): Promise<number>;
}

/**
 * The kinds of spend this manager gates. A subset of the ledger's `UsageKind`: `tool` usage
 * is recorded but has no quota, because there is no unit of tool spend an operator could
 * meaningfully budget yet.
 */
export type QuotaUsageKind = "llm" | "embedding" | "image" | "video";

/**
 * docs/22_COST_AND_QUOTA_STRATEGY.md's `QuotaManager`, now genuinely per-project (ADR-049)
 * rather than the single global budget ADR-008's single-operator scope allowed: every
 * aggregate below filters on `projectId` in SQL, so one project's spend can never be charged
 * against another's — which is what FR-063's per-tenant wording asked for all along.
 *
 * Every field is optional and `undefined` means "no limit configured" — quotas are opt-in
 * (FR-063 says limits "CAN be configured"), not a default restriction imposed on an operator
 * who never asked for one.
 */
export interface QuotaLimits {
  dailyTokenLimit?: number;
  monthlyTokenLimit?: number;
  /** Embedding spend is metered separately from chat: it is driven by ingestion volume, not
   * by conversation, and a runaway re-index should not be able to eat the chat budget. */
  dailyEmbeddingTokenLimit?: number;
  monthlyEmbeddingTokenLimit?: number;
  dailyImageLimit?: number;
  monthlyVideoSecondsLimit?: number;
}

export interface QuotaCheckResult {
  allowed: boolean;
  /** Present only when `allowed` is false — a clear, specific reason (FR-063's acceptance
   * criterion: "a clear error, not a silent overage"), not a generic "quota exceeded". */
  reason?: string;
}

/**
 * Window boundaries are the deployment's local midnight / first-of-month, because "today" is
 * a thing the operator reading the dashboard experiences locally. The stored timestamps are
 * `timestamptz` (ADR-049), so the comparison is between two unambiguous instants — before
 * that, the same boundary meant different things to the database and to this process.
 */
function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/**
 * Checked BEFORE enqueueing a job or making a model call, never after (docs/22) — a request
 * that would exceed quota is rejected synchronously, so it never starts and fails/bills
 * partway through. Token quotas use a caller-supplied estimate (an exact count isn't known
 * until the provider responds) purely to decide "would this likely push us over" — the usage
 * actually *recorded* against the quota (via the ledger) is always the real post-call figure,
 * matching docs/22's "only actuals count against quota."
 *
 * `projectId` is threaded in from the caller's authenticated scope on every check (ADR-049).
 * There is no unscoped variant on purpose: a quota check that forgot the project would
 * silently budget the whole platform as one tenant.
 */
export class QuotaManager {
  constructor(
    private readonly usage: QuotaUsageLedger,
    private readonly limits: QuotaLimits,
    private readonly now: () => Date = () => new Date()
  ) {}

  async checkLlmTokens(projectId: string, estimatedTokens: number): Promise<QuotaCheckResult> {
    return this.checkTokenWindows({
      projectId,
      estimatedTokens,
      label: "token",
      dailyLimit: this.limits.dailyTokenLimit,
      monthlyLimit: this.limits.monthlyTokenLimit,
      sumSince: (id, since) => this.usage.sumLlmTokensSince(id, since),
    });
  }

  /**
   * Embedding tokens — ingestion and retrieval both spend them (packages/rag), and before
   * ADR-049 that spend was invisible to every budget.
   *
   * If a limit is configured but the ledger cannot aggregate `kind = 'embedding'`, this
   * denies with a reason naming exactly what is missing. Fail-closed is the right way round:
   * an operator who set a ceiling asked for one, and quietly ignoring it is precisely the
   * "silent overage" FR-063 forbids. With no limit configured — the default — the missing
   * aggregate is never consulted and nothing changes.
   */
  async checkEmbeddingTokens(projectId: string, estimatedTokens: number): Promise<QuotaCheckResult> {
    const { dailyEmbeddingTokenLimit: daily, monthlyEmbeddingTokenLimit: monthly } = this.limits;
    if (daily === undefined && monthly === undefined) return { allowed: true };

    const sumSince = this.usage.sumEmbeddingTokensSince?.bind(this.usage);
    if (!sumSince) {
      return {
        allowed: false,
        reason:
          "An embedding token limit is configured, but this usage ledger cannot total " +
          "embedding usage (no sumEmbeddingTokensSince aggregate), so the limit cannot be " +
          "enforced. Remove the limit or use a ledger that reports embedding usage.",
      };
    }

    return this.checkTokenWindows({
      projectId,
      estimatedTokens,
      label: "embedding token",
      dailyLimit: daily,
      monthlyLimit: monthly,
      sumSince,
    });
  }

  async checkImageGeneration(projectId: string): Promise<QuotaCheckResult> {
    if (this.limits.dailyImageLimit === undefined) return { allowed: true };
    const used = await this.usage.countImagesSince(projectId, startOfDay(this.now()));
    if (used + 1 > this.limits.dailyImageLimit) {
      return { allowed: false, reason: `Daily image generation limit of ${this.limits.dailyImageLimit} reached (${used} generated today).` };
    }
    return { allowed: true };
  }

  async checkVideoSeconds(projectId: string, requestedSeconds: number): Promise<QuotaCheckResult> {
    if (this.limits.monthlyVideoSecondsLimit === undefined) return { allowed: true };
    const used = await this.usage.sumVideoSecondsSince(projectId, startOfMonth(this.now()));
    if (used + requestedSeconds > this.limits.monthlyVideoSecondsLimit) {
      return {
        allowed: false,
        reason: `Monthly video-seconds limit of ${this.limits.monthlyVideoSecondsLimit} would be exceeded (${used}s used so far this month).`,
      };
    }
    return { allowed: true };
  }

  /** Read-only access to the configured limits — used by GET /api/v1/usage to show the
   * operator what's currently configured (`null` per field left unset), not just usage. */
  getLimits(): Readonly<QuotaLimits> {
    return this.limits;
  }

  /**
   * The daily-then-monthly token check, shared by the LLM and embedding budgets: identical
   * window arithmetic over a different ledger aggregate and a different pair of limits. The
   * daily window is checked first so the reason names the tighter limit that actually bit.
   */
  private async checkTokenWindows(params: {
    projectId: string;
    estimatedTokens: number;
    label: string;
    dailyLimit?: number;
    monthlyLimit?: number;
    sumSince: (projectId: string, since: Date) => Promise<number>;
  }): Promise<QuotaCheckResult> {
    const now = this.now();
    if (params.dailyLimit !== undefined) {
      const used = await params.sumSince(params.projectId, startOfDay(now));
      if (used + params.estimatedTokens > params.dailyLimit) {
        return { allowed: false, reason: `Daily ${params.label} limit of ${params.dailyLimit} would be exceeded (${used} used so far today).` };
      }
    }
    if (params.monthlyLimit !== undefined) {
      const used = await params.sumSince(params.projectId, startOfMonth(now));
      if (used + params.estimatedTokens > params.monthlyLimit) {
        return { allowed: false, reason: `Monthly ${params.label} limit of ${params.monthlyLimit} would be exceeded (${used} used so far this month).` };
      }
    }
    return { allowed: true };
  }
}
