import { and, count, eq, gte, inArray, sum } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { projects, usageRecords } from "../schema/index.js";

/** `embedding` and `tool` joined the ledger in ADR-049: both spend, so both are recorded. */
export type UsageKind = "llm" | "embedding" | "image" | "video" | "speech" | "tool";

export interface UsageRecord {
  id: string;
  /** Tenant scope (ADR-049) — every aggregate below filters on it, so one project's spend can
   * never be reported as, or charged against, another's. */
  projectId: string;
  /** Who incurred it. Null for platform work with no user behind it (a scheduled re-index). */
  userId: string | null;
  kind: UsageKind;
  provider: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** `double precision`: video seconds and tool units are not whole numbers. */
  units: number | null;
  estimatedCostUsd: number | null;
  requestId: string | null;
  /**
   * Caller-supplied natural key for the unit of work being charged — e.g. the scene id for a
   * per-scene video charge. A unique index makes the insert idempotent (ADR-054): a job that
   * is retried after its usage row was already written cannot charge twice.
   *
   * Explicitly `null` when a caller genuinely has no natural key, which is a decision to
   * record a second row on retry, not an oversight — so it is a required field, not optional.
   */
  idempotencyKey: string | null;
  createdAt: Date;
}

export interface UsageRecordRepository {
  /**
   * Idempotent on `idempotencyKey` (ADR-054). The retry path the audit described — re-running
   * orchestration re-enqueues `pending` scenes, "causing duplicate provider calls and
   * duplicate usage rows" — is exactly the double-charge this closes: the second insert
   * conflicts on the unique index, does nothing, and the row that already exists is returned.
   * With a null key nothing conflicts (Postgres treats NULLs as distinct in a unique index),
   * so a caller that opted out of a key still gets a plain insert.
   */
  create(input: Omit<UsageRecord, "createdAt">): Promise<UsageRecord>;
  /** Real token totals for one project since `since` (docs/22_COST_AND_QUOTA_STRATEGY.md's
   * QuotaManager) — used for the daily/monthly LLM token quota. Sums both input and output
   * tokens, matching FR-063's "daily/monthly token... limits" wording (one combined figure,
   * not two separate input/output quotas). */
  sumLlmTokensSince(projectId: string, since: Date): Promise<number>;
  /** Real image-generation count for one project since `since` — the daily image quota. */
  countImagesSince(projectId: string, since: Date): Promise<number>;
  /** Real total video seconds for one project since `since` — the monthly video-seconds quota. */
  sumVideoSecondsSince(projectId: string, since: Date): Promise<number>;
  /** Real total estimated LLM spend for one project since `since` — null-priced calls
   * (docs/26_DECISIONS.md ADR-038, e.g. the mock provider) simply don't contribute, never
   * treated as $0 of real spend vs. "no data," so this can undercount when pricing is missing
   * — an honest limitation surfaced in the /api/v1/usage response itself, not hidden. */
  sumLlmCostUsdSince(projectId: string, since: Date): Promise<number>;
  /**
   * The same three totals across the whole ORGANIZATION the project belongs to — ADR-150.
   *
   * These are what `QuotaManager` enforces against (ADR-126 moved the ceilings to the tenant,
   * because a per-project limit made "create a project" a button that bought more budget), and
   * they were reachable only from the quota package's own `QuotaUsageLedger` view of this
   * repository. `/api/v1/usage` therefore showed per-project totals under organization limits,
   * so the dashboard and the enforcement disagreed with each other.
   */
  sumLlmTokensForTenantSince(projectId: string, since: Date): Promise<number>;
  countImagesForTenantSince(projectId: string, since: Date): Promise<number>;
  sumVideoSecondsForTenantSince(projectId: string, since: Date): Promise<number>;
  /** Audit finding 22: cost, embeddings and speech, organization-wide, for `/api/v1/usage`. */
  sumLlmCostUsdForTenantSince(projectId: string, since: Date): Promise<number>;
  /** This project's share of the same two. */
  sumEmbeddingTokensSince(projectId: string, since: Date): Promise<number>;
  sumSpeechCharactersSince(projectId: string, since: Date): Promise<number>;
  sumEmbeddingTokensForTenantSince(projectId: string, since: Date): Promise<number>;
  sumSpeechCharactersForTenantSince(projectId: string, since: Date): Promise<number>;
}

export class PgUsageRecordRepository implements UsageRecordRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: Omit<UsageRecord, "createdAt">): Promise<UsageRecord> {
    const row: UsageRecord = { ...input, createdAt: new Date() };
    const [inserted] = await this.db
      .insert(usageRecords)
      .values(row)
      .onConflictDoNothing({ target: usageRecords.idempotencyKey })
      .returning();
    if (inserted) return inserted as UsageRecord;

    // Nothing was inserted, which the unique index only permits for a repeated non-null key:
    // this unit of work was already charged. Return the row that won rather than the one we
    // tried to write, so the caller sees the ledger entry that actually exists.
    if (row.idempotencyKey !== null) {
      const [existing] = await this.db
        .select()
        .from(usageRecords)
        .where(
          and(eq(usageRecords.idempotencyKey, row.idempotencyKey), eq(usageRecords.projectId, row.projectId))
        );
      if (existing) return existing as UsageRecord;
    }
    // The key is global, so a conflict with no matching row in this project means two projects
    // built the same key. Charging the wrong project — or silently dropping the charge — would
    // both be worse than telling the caller its keys are not unique.
    throw new Error(
      `Usage record "${row.id}" conflicted on idempotency key "${row.idempotencyKey}", which belongs to ` +
        `another project. Idempotency keys must be unique across projects.`
    );
  }

  async sumLlmTokensSince(projectId: string, since: Date): Promise<number> {
    const inputSum = await this.sumColumnSince(projectId, "llm", usageRecords.inputTokens, since);
    const outputSum = await this.sumColumnSince(projectId, "llm", usageRecords.outputTokens, since);
    return inputSum + outputSum;
  }

  async countImagesSince(projectId: string, since: Date): Promise<number> {
    // COUNT in SQL, not `rows.length` — the previous implementation selected every matching
    // row into memory to measure its length, which the audit called out as an in-memory scan
    // standing in for a query. The `(kind, created_at)` index answers this one directly.
    const [row] = await this.db
      .select({ total: count() })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.projectId, projectId),
          eq(usageRecords.kind, "image"),
          gte(usageRecords.createdAt, since)
        )
      );
    return row?.total ?? 0;
  }

  async sumVideoSecondsSince(projectId: string, since: Date): Promise<number> {
    return this.sumColumnSince(projectId, "video", usageRecords.units, since);
  }

  /**
   * Embedding tokens, so a configured embedding budget can actually be enforced — ADR-119.
   *
   * Without this aggregate `QuotaManager.checkEmbeddingTokens` fails CLOSED, which is the right
   * default for a limit it cannot measure but means an operator who sets one refuses every
   * retrieval. Embedding rows carry their tokens in `input_tokens` (there is no output).
   */
  async sumEmbeddingTokensSince(projectId: string, since: Date): Promise<number> {
    return this.sumColumnSince(projectId, "embedding", usageRecords.inputTokens, since);
  }

  /** Characters synthesised, recorded as `units` on speech rows (ADR-114). */
  async sumSpeechCharactersSince(projectId: string, since: Date): Promise<number> {
    return this.sumColumnSince(projectId, "speech", usageRecords.units, since);
  }

  async sumLlmCostUsdSince(projectId: string, since: Date): Promise<number> {
    return this.sumColumnSince(projectId, "llm", usageRecords.estimatedCostUsd, since);
  }

  /**
   * The same aggregates, totalled across every project of the OWNING ORGANIZATION — ADR-126.
   *
   * Per-project ceilings were the whole enforcement story, and any authenticated user can create
   * projects, so every configured limit could be multiplied by simply making another one: N
   * projects bought N times the daily tokens, images, video-seconds and speech. A ceiling that a
   * user can raise by pressing a button is not a ceiling.
   *
   * The scope moves into SQL rather than into the call signature deliberately. Twelve callers
   * pass a project id, and one of them is a job worker that has no organization id to hand — a
   * `projectId` parameter that resolves to its tenant keeps every one of them correct without
   * threading a second identifier through the workers.
   */
  private tenantProjects(projectId: string) {
    return inArray(
      usageRecords.projectId,
      this.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          inArray(
            projects.organizationId,
            this.db.select({ organizationId: projects.organizationId }).from(projects).where(eq(projects.id, projectId))
          )
        )
    );
  }

  async sumLlmTokensForTenantSince(projectId: string, since: Date): Promise<number> {
    const input = await this.sumTenantColumnSince(projectId, "llm", usageRecords.inputTokens, since);
    const output = await this.sumTenantColumnSince(projectId, "llm", usageRecords.outputTokens, since);
    return input + output;
  }

  async countImagesForTenantSince(projectId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(usageRecords)
      .where(and(this.tenantProjects(projectId), eq(usageRecords.kind, "image"), gte(usageRecords.createdAt, since)));
    return row?.total ?? 0;
  }

  async sumVideoSecondsForTenantSince(projectId: string, since: Date): Promise<number> {
    return this.sumTenantColumnSince(projectId, "video", usageRecords.units, since);
  }

  async sumLlmCostUsdForTenantSince(projectId: string, since: Date): Promise<number> {
    return this.sumTenantColumnSince(projectId, "llm", usageRecords.estimatedCostUsd, since);
  }

  async sumEmbeddingTokensForTenantSince(projectId: string, since: Date): Promise<number> {
    return this.sumTenantColumnSince(projectId, "embedding", usageRecords.inputTokens, since);
  }

  async sumSpeechCharactersForTenantSince(projectId: string, since: Date): Promise<number> {
    return this.sumTenantColumnSince(projectId, "speech", usageRecords.units, since);
  }

  private async sumTenantColumnSince(
    projectId: string,
    kind: UsageKind,
    column: Parameters<typeof sum>[0],
    since: Date
  ): Promise<number> {
    const [row] = await this.db
      .select({ total: sum(column) })
      .from(usageRecords)
      .where(and(this.tenantProjects(projectId), eq(usageRecords.kind, kind), gte(usageRecords.createdAt, since)));
    return row?.total ? Number(row.total) : 0;
  }

  private async sumColumnSince(
    projectId: string,
    kind: UsageKind,
    column: Parameters<typeof sum>[0],
    since: Date
  ): Promise<number> {
    const [row] = await this.db
      .select({ total: sum(column) })
      .from(usageRecords)
      .where(
        and(eq(usageRecords.projectId, projectId), eq(usageRecords.kind, kind), gte(usageRecords.createdAt, since))
      );
    // drizzle's sum() returns a string (Postgres NUMERIC, to avoid precision loss) or null
    // when no rows matched — never a fabricated 0 vs. "genuinely summed to 0" ambiguity,
    // but callers here only need the count so both collapse to 0 safely.
    return row?.total ? Number(row.total) : 0;
  }
}
