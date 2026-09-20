import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  organizations,
  PgUsageRecordRepository,
  projects,
  runMigrations,
  type PgliteDb,
} from "@ai-platform/database";
import { QuotaManager, type QuotaUsageLedger } from "./quota-manager.js";

/**
 * Real in-memory PGlite Postgres, real migrations, real PgUsageRecordRepository — no mocks,
 * matching this project's established testing pattern (e.g. backend/packages/rag's integration
 * test). Quotas are exactly the kind of logic ("did we already cross this line today?")
 * that's easy to get subtly wrong against a fake in-memory counter but must be verified
 * against real SQL aggregation (SUM/COUNT with a real WHERE created_at >= X clause) — and,
 * since ADR-049, a real WHERE project_id = X clause as well.
 */
/** A second project inside an organization that already exists — the bypass, in one call. */
async function seedSiblingProject(db: PgliteDb, organizationId: string, name: string): Promise<string> {
  const now = new Date();
  const id = uuid();
  await db.insert(projects).values({ id, organizationId, name, createdAt: now, updatedAt: now });
  return id;
}

async function organizationOf(db: PgliteDb, projectId: string): Promise<string> {
  const [row] = await db.select({ organizationId: projects.organizationId }).from(projects).where(eq(projects.id, projectId));
  return row!.organizationId;
}

async function seedProject(db: PgliteDb, name: string): Promise<string> {
  const now = new Date();
  const organizationId = uuid();
  await db.insert(organizations).values({ id: organizationId, name: `${name} org`, createdAt: now, updatedAt: now });
  const id = uuid();
  await db.insert(projects).values({ id, organizationId, name, createdAt: now, updatedAt: now });
  return id;
}

/**
 * A ledger that CAN total embedding usage. `PgUsageRecordRepository` cannot yet — embedding
 * spend is recorded (`kind = 'embedding'`) but no aggregate over it exists — which is exactly
 * why `QuotaUsageLedger.sumEmbeddingTokensSince` is optional. This is still real SQL against
 * the same real Postgres, not a stubbed counter: the point is to prove the enforcement path,
 * so the numbers it enforces on have to come from the database.
 */
/**
 * A ledger that genuinely cannot total embedding tokens.
 *
 * `PgUsageRecordRepository` implements `sumEmbeddingTokensSince`, so the fail-closed branch can
 * no longer be reached through it — but the branch still guards every OTHER `QuotaUsageLedger`
 * implementation, and an operator who configures a ceiling must never be silently allowed past
 * it because an aggregate is missing (FR-063). Stripping the method is the only honest way to
 * stand where those implementations stand.
 */
function ledgerWithoutEmbeddingTotals(usage: PgUsageRecordRepository): QuotaUsageLedger {
  return {
    sumLlmTokensForTenantSince: (projectId, since) => usage.sumLlmTokensForTenantSince(projectId, since),
    countImagesForTenantSince: (projectId, since) => usage.countImagesForTenantSince(projectId, since),
    sumVideoSecondsForTenantSince: (projectId, since) => usage.sumVideoSecondsForTenantSince(projectId, since),
  };
}

describe("QuotaManager (real PGlite Postgres + PgUsageRecordRepository)", () => {
  let db: PgliteDb;
  let usage: PgUsageRecordRepository;
  let projectId: string;

  /** Every field is spelled out because `UsageRecord` requires them: `idempotencyKey: null`
   * in particular is a decision to record a second row on retry (ADR-054), not an oversight,
   * which is why the type makes it impossible to leave out. */
  function record(fields: {
    kind: "llm" | "embedding" | "image" | "video";
    projectId: string;
    provider: string;
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    units?: number | null;
    estimatedCostUsd?: number | null;
    requestId: string;
  }) {
    return usage.create({
      id: uuid(),
      projectId: fields.projectId,
      userId: null,
      kind: fields.kind,
      provider: fields.provider,
      model: fields.model ?? null,
      inputTokens: fields.inputTokens ?? null,
      outputTokens: fields.outputTokens ?? null,
      units: fields.units ?? null,
      estimatedCostUsd: fields.estimatedCostUsd ?? null,
      requestId: fields.requestId,
      idempotencyKey: null,
    });
  }

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    usage = new PgUsageRecordRepository(db);
    projectId = await seedProject(db, "Quota Test");
  });

  afterEach(async () => {
    await db.$client.close();
  });

  it("allows a request under an unconfigured limit (opt-in, not a default restriction)", async () => {
    const manager = new QuotaManager(usage, {});
    const result = await manager.checkLlmTokens(projectId, 1_000_000);
    expect(result).toEqual({ allowed: true });
  });

  it("blocks an LLM request that would push daily token usage over the configured limit", async () => {
    await record({ kind: "llm", projectId, provider: "anthropic", model: "claude-sonnet-5", inputTokens: 8000, outputTokens: 1500, estimatedCostUsd: 0.031, requestId: "r1" });
    const manager = new QuotaManager(usage, { dailyTokenLimit: 10_000 });

    const result = await manager.checkLlmTokens(projectId, 1000); // 9500 used + 1000 estimated > 10000
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/daily token limit/i);
  });

  it("allows an LLM request that stays within the daily limit", async () => {
    await record({ kind: "llm", projectId, provider: "anthropic", model: "claude-sonnet-5", inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.007, requestId: "r1" });
    const manager = new QuotaManager(usage, { dailyTokenLimit: 10_000 });

    const result = await manager.checkLlmTokens(projectId, 1000); // 1500 used + 1000 estimated <= 10000
    expect(result.allowed).toBe(true);
  });

  it("never charges one project's spend against another project's limit", async () => {
    const otherProject = await seedProject(db, "Somebody Else");
    await record({ kind: "llm", projectId: otherProject, provider: "anthropic", model: "claude-sonnet-5", inputTokens: 9000, outputTokens: 500, estimatedCostUsd: 0.031, requestId: "r1" });
    const manager = new QuotaManager(usage, { dailyTokenLimit: 10_000 });

    // Same ledger, same day, same limit — only the project differs, and that is enforced in
    // the SQL WHERE (ADR-049), not by filtering rows after the fact.
    expect(await manager.checkLlmTokens(projectId, 1000)).toEqual({ allowed: true });
    expect((await manager.checkLlmTokens(otherProject, 1000)).allowed).toBe(false);
  });

  it("only counts usage from the actual quota window, not records from an earlier day", async () => {
    // usage.create() always stamps a real "now" createdAt. To prove day-boundary exclusion
    // for real (not just that the math is right for a fixed window), push the manager's
    // clock forward past midnight relative to when the record was actually created — from
    // that vantage point, the record now falls strictly before "today" started.
    await record({ kind: "llm", projectId, provider: "anthropic", model: "claude-sonnet-5", inputTokens: 9999, outputTokens: 9999, estimatedCostUsd: 1, requestId: "old" });

    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const manager = new QuotaManager(usage, { dailyTokenLimit: 10 }, () => tomorrow);

    const result = await manager.checkLlmTokens(projectId, 5);
    expect(result.allowed).toBe(true); // yesterday's 19,998 tokens don't count against today's window
  });

  it("blocks image generation once the daily count limit is reached", async () => {
    await record({ kind: "image", projectId, provider: "mock", units: 1, requestId: "i1" });
    await record({ kind: "image", projectId, provider: "mock", units: 1, requestId: "i2" });
    const manager = new QuotaManager(usage, { dailyImageLimit: 2 });

    const result = await manager.checkImageGeneration(projectId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/daily image generation limit/i);
  });

  it("blocks a video request whose duration would exceed the monthly seconds limit", async () => {
    await record({ kind: "video", projectId, provider: "mock", units: 50, requestId: "v1" });
    const manager = new QuotaManager(usage, { monthlyVideoSecondsLimit: 60 });

    const result = await manager.checkVideoSeconds(projectId, 20); // 50 used + 20 requested > 60
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/monthly video-seconds limit/i);
  });

  it("allows a video request that fits within the remaining monthly seconds budget", async () => {
    await record({ kind: "video", projectId, provider: "mock", units: 50, requestId: "v1" });
    const manager = new QuotaManager(usage, { monthlyVideoSecondsLimit: 60 });

    const result = await manager.checkVideoSeconds(projectId, 10); // 50 used + 10 requested == 60, not over
    expect(result.allowed).toBe(true);
  });

  it("allows embedding work when no embedding limit is configured, even on a ledger that cannot total it", async () => {
    // The "unset limit means no limit" rule holds for the new kind too — and an unset limit
    // must never consult (or trip over) the aggregate the base repository does not have.
    const manager = new QuotaManager(ledgerWithoutEmbeddingTotals(usage), { dailyTokenLimit: 1_000_000 });
    expect(await manager.checkEmbeddingTokens(projectId, 500_000)).toEqual({ allowed: true });
  });

  it("meters embedding tokens against their own budget, separately from the chat token budget", async () => {
    // Through the real repository aggregate — a hand-written copy of the SQL in this file would
    // prove only that the copy works.
    await record({ kind: "embedding", projectId, provider: "hash", model: "feature-hash-v2", inputTokens: 900, requestId: "e1" });
    const manager = new QuotaManager(usage, {
      dailyEmbeddingTokenLimit: 1000,
      // Deliberately generous: an ingestion run must be stopped by the embedding limit, not
      // by the chat budget it does not spend from.
      dailyTokenLimit: 1_000_000,
    });

    expect((await manager.checkEmbeddingTokens(projectId, 200)).allowed).toBe(false); // 900 + 200 > 1000
    expect((await manager.checkEmbeddingTokens(projectId, 200)).reason).toMatch(/daily embedding token limit/i);
    expect(await manager.checkEmbeddingTokens(projectId, 100)).toEqual({ allowed: true }); // 900 + 100 == 1000
    // The embedding rows are invisible to the LLM aggregate, which is the point of the split.
    expect(await manager.checkLlmTokens(projectId, 100)).toEqual({ allowed: true });
  });

  /**
   * A ceiling a user can raise by pressing a button — docs/26_DECISIONS.md ADR-126.
   *
   * Every limit was enforced per project, and any authenticated user can create projects. So the
   * whole quota system could be defeated without exploiting anything: make a second project and
   * spend the same budget again, a third and spend it a third time. These fix the scope at the
   * tenant, which is the thing an operator is actually budgeting.
   */
  describe("limits are a ceiling for the TENANT, not for each project separately", () => {
    it("counts a sibling project's spend against the same daily token budget", async () => {
      const organizationId = await organizationOf(db, projectId);
      const sibling = await seedSiblingProject(db, organizationId, "second-project");

      // The first project spends the whole budget.
      await record({ kind: "llm", projectId, provider: "mock", inputTokens: 900, outputTokens: 100, requestId: "t1" });
      const manager = new QuotaManager(usage, { dailyTokenLimit: 1000 });

      // Before ADR-126 the brand-new project started from zero and bought the budget again.
      const result = await manager.checkLlmTokens(sibling, 1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/daily token limit/i);
    });

    it("counts a sibling project's images, video-seconds and speech the same way", async () => {
      const organizationId = await organizationOf(db, projectId);
      const sibling = await seedSiblingProject(db, organizationId, "second-project");

      await record({ kind: "image", projectId, provider: "mock", units: 1, requestId: "i1" });
      await record({ kind: "image", projectId, provider: "mock", units: 1, requestId: "i2" });
      await record({ kind: "video", projectId, provider: "mock", units: 50, requestId: "v1" });
      await usage.create({
        id: uuid(),
        projectId,
        userId: null,
        kind: "speech",
        provider: "piper",
        model: null,
        inputTokens: null,
        outputTokens: null,
        units: 900,
        estimatedCostUsd: null,
        requestId: "s1",
        idempotencyKey: null,
      });

      const manager = new QuotaManager(usage, {
        dailyImageLimit: 2,
        monthlyVideoSecondsLimit: 60,
        dailySpeechCharacterLimit: 1000,
      });

      expect((await manager.checkImageGeneration(sibling)).allowed).toBe(false);
      expect((await manager.checkVideoSeconds(sibling, 20)).allowed).toBe(false);
      expect((await manager.checkSpeechCharacters(sibling, 200)).allowed).toBe(false);
    });

    it("still isolates a DIFFERENT tenant completely", async () => {
      // Scoping to the organization must not turn into scoping to the whole deployment: one
      // customer's spend can never be charged against another's.
      const other = await seedProject(db, "other-tenant");
      await record({ kind: "llm", projectId, provider: "mock", inputTokens: 900, outputTokens: 100, requestId: "t1" });
      const manager = new QuotaManager(usage, { dailyTokenLimit: 1000 });

      expect((await manager.checkLlmTokens(other, 500)).allowed).toBe(true);
      expect((await manager.checkLlmTokens(projectId, 500)).allowed).toBe(false);
    });
  });

  it("refuses embedding work, with a reason naming the gap, when a limit is configured that the ledger cannot measure", async () => {
    // Fail-closed: an operator who configured a ceiling asked for one, and quietly allowing
    // everything because the aggregate is missing is precisely FR-063's "silent overage".
    const manager = new QuotaManager(ledgerWithoutEmbeddingTotals(usage), { dailyEmbeddingTokenLimit: 1000 });

    const result = await manager.checkEmbeddingTokens(projectId, 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/sumEmbeddingTokensForTenantSince/);
  });

  /**
   * Speech, budgeted in characters — ADR-114. Real rows through the real repository, because the
   * question a quota answers ("did we already cross this line today?") is a SQL question.
   */
  it("counts speech characters against the daily and monthly limits, per project", async () => {
    const other = await seedProject(db, "other-tenant");
    const record = async (projectId: string, characters: number) =>
      usage.create({
        id: uuid(),
        projectId,
        userId: null,
        kind: "speech",
        provider: "piper",
        model: "en_US-lessac-medium.onnx",
        inputTokens: null,
        outputTokens: null,
        units: characters,
        estimatedCostUsd: null,
        requestId: null,
        idempotencyKey: `speech:${uuid()}`,
      });

    await record(projectId, 800);
    await record(other, 5000); // another tenant's spend must not count against this one

    const manager = new QuotaManager(usage, { dailySpeechCharacterLimit: 1000 });
    expect((await manager.checkSpeechCharacters(projectId, 300)).allowed).toBe(false); // 800 + 300 > 1000
    expect((await manager.checkSpeechCharacters(projectId, 300)).reason).toMatch(/Daily speech limit of 1000 characters/);
    expect(await manager.checkSpeechCharacters(projectId, 200)).toEqual({ allowed: true }); // 800 + 200 == 1000

    // The monthly window is checked too, and names itself when it is the one that bites.
    const monthly = new QuotaManager(usage, { monthlySpeechCharacterLimit: 900 });
    expect((await monthly.checkSpeechCharacters(projectId, 200)).reason).toMatch(/Monthly speech limit of 900/);

    // No limits configured means no gate at all — quotas are opt-in (FR-063).
    expect(await new QuotaManager(usage, {}).checkSpeechCharacters(projectId, 1_000_000)).toEqual({ allowed: true });
  });

  it("refuses speech, rather than silently allowing it, when the ledger cannot measure it", async () => {
    // Fail-closed, like the embedding budget: an operator who configured a ceiling asked for one.
    /**
     * The names the manager ACTUALLY calls — docs/26_DECISIONS.md ADR-152.
     *
     * This stub implemented `sumLlmTokensSince`/`countImagesSince`/`sumVideoSecondsSince`, which
     * are the PROJECT-scoped aggregates. `QuotaUsageLedger` declares only the `…ForTenantSince`
     * ones (ADR-126 moved every ceiling to the organization), so the object was not a ledger at
     * all — it typechecked nowhere, because no backend test was typechecked by anything, and the
     * fail-closed assertion below was passing for a reason unrelated to the one it names.
     */
    const ledger: QuotaUsageLedger = {
      sumLlmTokensForTenantSince: (p, s) => usage.sumLlmTokensForTenantSince(p, s),
      countImagesForTenantSince: (p, s) => usage.countImagesForTenantSince(p, s),
      sumVideoSecondsForTenantSince: (p, s) => usage.sumVideoSecondsForTenantSince(p, s),
    };
    const manager = new QuotaManager(ledger, { dailySpeechCharacterLimit: 100 });
    const result = await manager.checkSpeechCharacters(projectId, 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/cannot measure speech usage/);
  });
});