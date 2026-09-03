import type { UsageRecordRepository } from "@ai-platform/database";

/**
 * docs/22_COST_AND_QUOTA_STRATEGY.md's `QuotaManager` — single-operator scope
 * (docs/26_DECISIONS.md ADR-008), so these are global limits, not per-user/per-project as
 * FR-063's original multi-tenant wording envisions; the same narrowing `rag.ts`'s
 * `SINGLE_OPERATOR_OWNER_ID` already applies elsewhere. Every field is optional and
 * `undefined` means "no limit configured" — quotas are opt-in (FR-063 says limits "CAN be
 * configured"), not a default restriction imposed on an operator who never asked for one.
 */
export interface QuotaLimits {
  dailyTokenLimit?: number;
  monthlyTokenLimit?: number;
  dailyImageLimit?: number;
  monthlyVideoSecondsLimit?: number;
}

export interface QuotaCheckResult {
  allowed: boolean;
  /** Present only when `allowed` is false — a clear, specific reason (FR-063's acceptance
   * criterion: "a clear error, not a silent overage"), not a generic "quota exceeded". */
  reason?: string;
}

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
 * actually *recorded* against the quota (via `UsageRecordRepository`) is always the real
 * post-call figure, matching docs/22's "only actuals count against quota."
 */
export class QuotaManager {
  constructor(
    private readonly usage: UsageRecordRepository,
    private readonly limits: QuotaLimits,
    private readonly now: () => Date = () => new Date()
  ) {}

  async checkLlmTokens(estimatedTokens: number): Promise<QuotaCheckResult> {
    const now = this.now();
    if (this.limits.dailyTokenLimit !== undefined) {
      const used = await this.usage.sumLlmTokensSince(startOfDay(now));
      if (used + estimatedTokens > this.limits.dailyTokenLimit) {
        return { allowed: false, reason: `Daily token limit of ${this.limits.dailyTokenLimit} would be exceeded (${used} used so far today).` };
      }
    }
    if (this.limits.monthlyTokenLimit !== undefined) {
      const used = await this.usage.sumLlmTokensSince(startOfMonth(now));
      if (used + estimatedTokens > this.limits.monthlyTokenLimit) {
        return { allowed: false, reason: `Monthly token limit of ${this.limits.monthlyTokenLimit} would be exceeded (${used} used so far this month).` };
      }
    }
    return { allowed: true };
  }

  async checkImageGeneration(): Promise<QuotaCheckResult> {
    if (this.limits.dailyImageLimit === undefined) return { allowed: true };
    const used = await this.usage.countImagesSince(startOfDay(this.now()));
    if (used + 1 > this.limits.dailyImageLimit) {
      return { allowed: false, reason: `Daily image generation limit of ${this.limits.dailyImageLimit} reached (${used} generated today).` };
    }
    return { allowed: true };
  }

  /** Read-only access to the configured limits — used by GET /api/v1/usage to show the
   * operator what's currently configured (`null` per field left unset), not just usage. */
  getLimits(): Readonly<QuotaLimits> {
    return this.limits;
  }

  async checkVideoSeconds(requestedSeconds: number): Promise<QuotaCheckResult> {
    if (this.limits.monthlyVideoSecondsLimit === undefined) return { allowed: true };
    const used = await this.usage.sumVideoSecondsSince(startOfMonth(this.now()));
    if (used + requestedSeconds > this.limits.monthlyVideoSecondsLimit) {
      return {
        allowed: false,
        reason: `Monthly video-seconds limit of ${this.limits.monthlyVideoSecondsLimit} would be exceeded (${used}s used so far this month).`,
      };
    }
    return { allowed: true };
  }
}
