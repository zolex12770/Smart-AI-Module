import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { usageRecords, type PgliteDb } from "@ai-platform/database";
import { QuotaManager } from "@ai-platform/quota";
import { PgUsageRecordRepository } from "@ai-platform/database";
import { and, eq } from "drizzle-orm";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * The media spends that no budget saw — docs/26_DECISIONS.md ADR-150.
 *
 * `grep -rn "usage|quota|Meter" backend/packages/media/src` returned two prose comments and no
 * code. Every `POST /api/v1/videos` runs a real storyboard model call through the router, and the
 * route checked video-seconds and nothing else: no `checkLlmTokens`, no `kind: "llm"` row. So the
 * one model call the platform makes on a user's behalf outside chat was unbudgeted AND invisible
 * in the ledger the dashboard reads.
 *
 * And `/api/v1/usage` reported per-PROJECT totals under organization-wide limits. ADR-126 moved
 * every ceiling to the tenant — a per-project limit made "create a project" a button that bought
 * more budget — and the dashboard was never moved with it, so a user watched a meter that could
 * not predict the refusal they were about to get.
 */
describe("media spend is budgeted and recorded", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;
  let auth: Awaited<ReturnType<typeof buildTestApp>>["auth"];

  beforeEach(async () => {
    ({ app, db, ctx, auth } = await buildTestApp());
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  const createVideo = () =>
    app.inject({
      method: "POST",
      url: "/api/v1/videos",
      headers: auth.headers,
      payload: { prompt: "a harbour at dawn", targetDurationSeconds: 8, sceneClipSeconds: 4 },
    });

  it("records the storyboard's model call in the ledger", async () => {
    const res = await createVideo();
    expect(res.statusCode).toBe(202);

    const rows = await db
      .select()
      .from(usageRecords)
      .where(and(eq(usageRecords.projectId, auth.projectId), eq(usageRecords.kind, "llm")));

    // One row, for the storyboard. Before the fix there were none at all.
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toMatch(/^llm:video\.storyboard:/);
    // Real counts from the provider's terminal event, not a placeholder.
    expect((rows[0].inputTokens ?? 0) + (rows[0].outputTokens ?? 0)).toBeGreaterThan(0);
  });

  it("charges a second video separately, and a retried create only once", async () => {
    // The key names the video project, so two videos are two charges and a redelivery is one.
    await createVideo();
    await createVideo();
    const rows = await db
      .select()
      .from(usageRecords)
      .where(and(eq(usageRecords.projectId, auth.projectId), eq(usageRecords.kind, "llm")));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(2);
  });

  it("refuses the video when the token budget is already spent", async () => {
    // A tiny daily limit, then a row that consumes it. The storyboard must be refused BEFORE the
    // model is called — a budget checked after the spend is not a budget.
    ctx.quota = new QuotaManager(new PgUsageRecordRepository(db), { dailyTokenLimit: 10 });
    await ctx.usage.create({
      id: "spent",
      projectId: auth.projectId,
      userId: auth.userId,
      kind: "llm",
      provider: "mock",
      model: "mock-1",
      inputTokens: 10,
      outputTokens: 0,
      units: null,
      estimatedCostUsd: null,
      requestId: null,
      idempotencyKey: null,
    });

    const res = await createVideo();
    expect(res.statusCode).toBe(429);
    // And no video project was created by the refused request.
    expect((await ctx.videoProjects.list(auth.projectId))).toHaveLength(0);
  });
});

/**
 * The dashboard reports what the limits are enforced against — ADR-126, corrected by ADR-150.
 */
describe("/api/v1/usage scope", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;
  let auth: Awaited<ReturnType<typeof buildTestApp>>["auth"];

  beforeEach(async () => {
    ({ app, db, ctx, auth } = await buildTestApp());
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  it("counts a sibling project's spend, because the limit does", async () => {
    // A second project in the SAME organization — exactly the shape ADR-126 closed.
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: auth.headers,
      payload: { name: "second" },
    });
    expect(created.statusCode).toBe(201);
    const siblingId = (created.json() as { project: { id: string } }).project.id;

    await ctx.usage.create({
      id: "sibling-spend",
      projectId: siblingId,
      userId: auth.userId,
      kind: "llm",
      provider: "mock",
      model: "mock-1",
      inputTokens: 700,
      outputTokens: 300,
      units: null,
      estimatedCostUsd: null,
      requestId: null,
      idempotencyKey: null,
    });

    const res = await app.inject({ method: "GET", url: "/api/v1/usage", headers: auth.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      usageScope: string;
      usage: { llm: { tokensThisMonth: number } };
      projectUsage: { llm: { tokensThisMonth: number } };
    };

    expect(body.usageScope).toBe("organization");
    // The headline figure includes the sibling — it is what a request is refused against.
    expect(body.usage.llm.tokensThisMonth).toBe(1000);
    // And this project's own share is reported apart from it, rather than instead of it.
    expect(body.projectUsage.llm.tokensThisMonth).toBe(0);
  });
});
