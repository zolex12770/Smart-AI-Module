import { v4 as uuid } from "uuid";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, PgUsageRecordRepository, runMigrations, type DrizzleDb } from "@ai-platform/database";
import { QuotaManager } from "./quota-manager.js";

/**
 * Real in-memory PGlite Postgres, real migrations, real PgUsageRecordRepository — no mocks,
 * matching this project's established testing pattern (e.g. packages/rag's integration
 * test). Quotas are exactly the kind of logic ("did we already cross this line today?")
 * that's easy to get subtly wrong against a fake in-memory counter but must be verified
 * against real SQL aggregation (SUM/COUNT with a real WHERE createdAt >= X clause).
 */
describe("QuotaManager (real PGlite Postgres + PgUsageRecordRepository)", () => {
  let db: DrizzleDb;
  let usage: PgUsageRecordRepository;

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    usage = new PgUsageRecordRepository(db);
  });

  afterAll(async () => {
    await db.$client.close();
  });

  it("allows a request under an unconfigured limit (opt-in, not a default restriction)", async () => {
    const manager = new QuotaManager(usage, {});
    const result = await manager.checkLlmTokens(1_000_000);
    expect(result).toEqual({ allowed: true });
  });

  it("blocks an LLM request that would push daily token usage over the configured limit", async () => {
    await usage.create({ id: uuid(), kind: "llm", provider: "anthropic", model: "claude-sonnet-5", inputTokens: 8000, outputTokens: 1500, units: null, estimatedCostUsd: 0.031, requestId: "r1" });
    const manager = new QuotaManager(usage, { dailyTokenLimit: 10_000 });

    const result = await manager.checkLlmTokens(1000); // 9500 used + 1000 estimated > 10000
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/daily token limit/i);
  });

  it("allows an LLM request that stays within the daily limit", async () => {
    await usage.create({ id: uuid(), kind: "llm", provider: "anthropic", model: "claude-sonnet-5", inputTokens: 1000, outputTokens: 500, units: null, estimatedCostUsd: 0.007, requestId: "r1" });
    const manager = new QuotaManager(usage, { dailyTokenLimit: 10_000 });

    const result = await manager.checkLlmTokens(1000); // 1500 used + 1000 estimated <= 10000
    expect(result.allowed).toBe(true);
  });

  it("only counts usage from the actual quota window, not records from an earlier day", async () => {
    // usage.create() always stamps a real "now" createdAt. To prove day-boundary exclusion
    // for real (not just that the math is right for a fixed window), push the manager's
    // clock forward past midnight relative to when the record was actually created — from
    // that vantage point, the record now falls strictly before "today" started.
    await usage.create({ id: uuid(), kind: "llm", provider: "anthropic", model: "claude-sonnet-5", inputTokens: 9999, outputTokens: 9999, units: null, estimatedCostUsd: 1, requestId: "old" });

    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const manager = new QuotaManager(usage, { dailyTokenLimit: 10 }, () => tomorrow);

    const result = await manager.checkLlmTokens(5);
    expect(result.allowed).toBe(true); // yesterday's 19,998 tokens don't count against today's window
  });

  it("blocks image generation once the daily count limit is reached", async () => {
    await usage.create({ id: uuid(), kind: "image", provider: "mock", model: null, inputTokens: null, outputTokens: null, units: 1, estimatedCostUsd: null, requestId: "i1" });
    await usage.create({ id: uuid(), kind: "image", provider: "mock", model: null, inputTokens: null, outputTokens: null, units: 1, estimatedCostUsd: null, requestId: "i2" });
    const manager = new QuotaManager(usage, { dailyImageLimit: 2 });

    const result = await manager.checkImageGeneration();
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/daily image generation limit/i);
  });

  it("blocks a video request whose duration would exceed the monthly seconds limit", async () => {
    await usage.create({ id: uuid(), kind: "video", provider: "mock", model: null, inputTokens: null, outputTokens: null, units: 50, estimatedCostUsd: null, requestId: "v1" });
    const manager = new QuotaManager(usage, { monthlyVideoSecondsLimit: 60 });

    const result = await manager.checkVideoSeconds(20); // 50 used + 20 requested > 60
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/monthly video-seconds limit/i);
  });

  it("allows a video request that fits within the remaining monthly seconds budget", async () => {
    await usage.create({ id: uuid(), kind: "video", provider: "mock", model: null, inputTokens: null, outputTokens: null, units: 50, estimatedCostUsd: null, requestId: "v1" });
    const manager = new QuotaManager(usage, { monthlyVideoSecondsLimit: 60 });

    const result = await manager.checkVideoSeconds(10); // 50 used + 10 requested == 60, not over
    expect(result.allowed).toBe(true);
  });
});
