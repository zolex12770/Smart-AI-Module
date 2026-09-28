import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { PgUsageRecordRepository } from "@ai-platform/database";
import { QuotaManager } from "@ai-platform/quota";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

describe("GET /api/v1/usage and quota enforcement (real buildServer() app, app.inject())", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;
  /** Session cookie + CSRF pair + x-project-id for the seeded test user (ADR-049).
   * Every request in these suites is authenticated and project-scoped, because every real
   * request is — an unauthenticated inject would only ever assert a 401. */
  let auth: Awaited<ReturnType<typeof buildTestApp>>["auth"];

  beforeEach(async () => {
    ({ app, db, ctx, auth } = await buildTestApp());
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  it("reports zero usage and null limits on a fresh app", async () => {
    const res = await app.inject({ headers: auth.headers, method: "GET", url: "/api/v1/usage" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      usage: {
        llm: { tokensToday: 0, tokensThisMonth: 0, estimatedCostUsdThisMonth: 0, pricedCallsOnly: true },
        images: { generatedToday: 0 },
        video: { secondsGeneratedThisMonth: 0 },
      },
      limits: { dailyTokenLimit: null, monthlyTokenLimit: null, dailyImageLimit: null, monthlyVideoSecondsLimit: null },
    });
  });

  it("reflects real usage recorded by a real chat request through the full HTTP stack", async () => {
    const chatRes = await app.inject({ headers: auth.headers,
      method: "POST",
      url: "/api/v1/chat",
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(chatRes.statusCode).toBe(200);

    const usageRes = await app.inject({ headers: auth.headers, method: "GET", url: "/api/v1/usage" });
    const usage = usageRes.json().usage;
    expect(usage.llm.tokensToday).toBeGreaterThan(0);
    expect(usage.llm.tokensThisMonth).toBe(usage.llm.tokensToday);
  });

  it("rejects a chat request over a configured daily token limit with a real 429", async () => {
    // Swapping ctx.quota after buildTestApp() returns is valid: route handlers read
    // ctx.quota at request time, not at registration time (confirmed by this test passing).
    ctx.quota = new QuotaManager(new PgUsageRecordRepository(db), { dailyTokenLimit: 1 });

    const res = await app.inject({ headers: auth.headers,
      method: "POST",
      url: "/api/v1/chat",
      payload: { messages: [{ role: "user", content: "this message is long enough to exceed a 1-token daily limit" }] },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("QUOTA_EXCEEDED");
  });

  it("rejects an image generation request over a configured daily image limit with a real 429", async () => {
    ctx.quota = new QuotaManager(new PgUsageRecordRepository(db), { dailyImageLimit: 0 });

    const res = await app.inject({ headers: auth.headers, method: "POST", url: "/api/v1/images", payload: { prompt: "a lighthouse" } });

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("QUOTA_EXCEEDED");
  });

  it("rejects a video project request over a configured monthly video-seconds limit with a real 429", async () => {
    ctx.quota = new QuotaManager(new PgUsageRecordRepository(db), { monthlyVideoSecondsLimit: 4 });

    const res = await app.inject({ headers: auth.headers,
      method: "POST",
      url: "/api/v1/videos",
      payload: { prompt: "a sunset", targetDurationSeconds: 8, sceneClipSeconds: 4 },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("QUOTA_EXCEEDED");
  });

  it("reports cost, embeddings and speech per organization, and this project's share apart", async () => {
    // Audit finding 22: the cost inside the ORGANIZATION block was summed over this project only,
    // and embedding and speech limits were enforced but never reported.
    const other = await app.inject({ method: "POST", url: "/api/v1/projects", headers: auth.headers, payload: { name: "Second" } });
    const otherId = (other.json() as { project: { id: string } }).project.id;
    const repo = new PgUsageRecordRepository(db);
    const row = (projectId: string, kind: "llm" | "embedding" | "speech", key: string, over: Record<string, unknown>) =>
      repo.create({
        id: key,
        projectId,
        userId: auth.userId,
        kind,
        provider: "p",
        model: "m",
        inputTokens: null,
        outputTokens: null,
        units: null,
        estimatedCostUsd: null,
        requestId: null,
        idempotencyKey: key,
        ...over,
      });
    await row(auth.projectId, "llm", "a", { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.25 });
    await row(otherId, "llm", "b", { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.5 });
    await row(auth.projectId, "embedding", "c", { inputTokens: 40 });
    await row(otherId, "embedding", "d", { inputTokens: 60 });
    await row(otherId, "speech", "e", { units: 300 });
    ctx.quota = new QuotaManager(repo, { monthlyEmbeddingTokenLimit: 1000, dailySpeechCharacterLimit: 5000 });

    const body = (await app.inject({ method: "GET", url: "/api/v1/usage", headers: auth.headers })).json();
    expect(body.usage.llm.estimatedCostUsdThisMonth).toBeCloseTo(0.75);
    expect(body.projectUsage.llm.estimatedCostUsdThisMonth).toBeCloseTo(0.25);
    expect(body.usage.embeddings).toEqual({ tokensToday: 100, tokensThisMonth: 100 });
    expect(body.projectUsage.embeddings).toEqual({ tokensThisMonth: 40 });
    expect(body.usage.speech).toEqual({ charactersToday: 300, charactersThisMonth: 300 });
    expect(body.projectUsage.speech).toEqual({ charactersThisMonth: 0 });
    expect(body.limits).toMatchObject({ monthlyEmbeddingTokenLimit: 1000, dailySpeechCharacterLimit: 5000 });
  });
});
