import { and, eq, gte, sum } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { usageRecords } from "../schema/index.js";

export type UsageKind = "llm" | "image" | "video";

export interface UsageRecord {
  id: string;
  kind: UsageKind;
  provider: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  units: number | null;
  estimatedCostUsd: number | null;
  requestId: string | null;
  createdAt: Date;
}

export interface UsageRecordRepository {
  create(input: Omit<UsageRecord, "createdAt">): Promise<UsageRecord>;
  /** Real token totals since `since` (docs/22_COST_AND_QUOTA_STRATEGY.md's QuotaManager) —
   * used for the daily/monthly LLM token quota. Sums both input and output tokens, matching
   * FR-063's "daily/monthly token... limits" wording (one combined figure, not two separate
   * input/output quotas). */
  sumLlmTokensSince(since: Date): Promise<number>;
  /** Real image-generation count since `since` — the daily image quota. */
  countImagesSince(since: Date): Promise<number>;
  /** Real total video seconds since `since` — the monthly video-seconds quota. */
  sumVideoSecondsSince(since: Date): Promise<number>;
  /** Real total estimated LLM spend since `since` — null-priced calls (docs/26_DECISIONS.md
   * ADR-038, e.g. the mock provider) simply don't contribute, never treated as $0 of real
   * spend vs. "no data," so this can undercount when pricing is missing — an honest
   * limitation surfaced in the /api/v1/usage response itself, not hidden. */
  sumLlmCostUsdSince(since: Date): Promise<number>;
}

export class PgUsageRecordRepository implements UsageRecordRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: Omit<UsageRecord, "createdAt">): Promise<UsageRecord> {
    const row = { ...input, createdAt: new Date() };
    await this.db.insert(usageRecords).values(row);
    return row;
  }

  async sumLlmTokensSince(since: Date): Promise<number> {
    const inputSum = await this.sumColumnSince("llm", usageRecords.inputTokens, since);
    const outputSum = await this.sumColumnSince("llm", usageRecords.outputTokens, since);
    return inputSum + outputSum;
  }

  async countImagesSince(since: Date): Promise<number> {
    const rows = await this.db
      .select()
      .from(usageRecords)
      .where(and(eq(usageRecords.kind, "image"), gte(usageRecords.createdAt, since)));
    return rows.length;
  }

  async sumVideoSecondsSince(since: Date): Promise<number> {
    return this.sumColumnSince("video", usageRecords.units, since);
  }

  async sumLlmCostUsdSince(since: Date): Promise<number> {
    return this.sumColumnSince("llm", usageRecords.estimatedCostUsd, since);
  }

  private async sumColumnSince(
    kind: UsageKind,
    column: Parameters<typeof sum>[0],
    since: Date
  ): Promise<number> {
    const [row] = await this.db
      .select({ total: sum(column) })
      .from(usageRecords)
      .where(and(eq(usageRecords.kind, kind), gte(usageRecords.createdAt, since)));
    // drizzle's sum() returns a string (Postgres NUMERIC, to avoid precision loss) or null
    // when no rows matched — never a fabricated 0 vs. "genuinely summed to 0" ambiguity,
    // but callers here only need the count so both collapse to 0 safely.
    return row?.total ? Number(row.total) : 0;
  }
}
