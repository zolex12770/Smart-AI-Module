import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { usageRecords, type PgliteDb } from "@ai-platform/database";
import { EmbeddingService } from "@ai-platform/embeddings";
import { QuotaManager } from "@ai-platform/quota";
import { PgUsageRecordRepository } from "@ai-platform/database";
import { eq } from "drizzle-orm";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * Every expensive path is gated and recorded — docs/26_DECISIONS.md ADR-119.
 *
 * Three holes the audit found, each of which let a project spend past its budget or spend
 * unrecorded: retrieval embedded the question with no quota check and wrote no ledger row; the
 * video RETRY button re-enqueued exactly the paid work the create route gates, with neither a
 * quota check nor a rate limit; and dead-letter replay enqueued real work with neither.
 *
 * A fourth: the RAG route handed the provider's own error text to the caller.
 */
describe("spend guards", () => {
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

  /** A real EmbeddingService over a provider that is NOT the lexical fallback. */
  const realEmbedder = () =>
    new EmbeddingService({
      name: "local",
      model: "nomic-embed-text",
      dimensions: 8,
      isDeterministicFallback: false,
      embed: async (texts: string[]) => texts.map(() => Array.from({ length: 8 }, (_, i) => (i + 1) / 10)),
    });

  /**
   * One retrievable chunk. Without it the route answers "no evidence" and never calls a model,
   * so a test about the model's error would pass while proving nothing.
   */
  const seedRetrievableChunk = async () => {
    await ctx.documents.create({
      id: "doc-guard",
      projectId: auth.projectId,
      uploadedByUserId: auth.userId,
      filename: "runbook.md",
      sourcePath: "runbook.md",
    });
    await ctx.documents.updateStatus(auth.projectId, "doc-guard", "ready");
    const [vector] = await ctx.embeddings.embed(["Roll back with the documented script."]);
    await ctx.documentChunks.createMany([
      {
        id: "chunk-guard",
        documentId: "doc-guard",
        projectId: auth.projectId,
        chunkIndex: 0,
        content: "Roll back with the documented script.",
        embedding: vector.vector,
        embeddingModel: vector.model,
        embeddingDims: vector.vector.length,
      },
    ]);
  };

  it("refuses a retrieval query when the project's embedding budget is spent, before embedding anything", async () => {
    ctx.embeddings = realEmbedder();
    const usage = new PgUsageRecordRepository(db);
    // Real prior spend, counted by the real aggregate — not the fail-closed branch.
    await usage.create({
      id: "prior-embedding",
      projectId: auth.projectId,
      userId: auth.userId,
      kind: "embedding",
      provider: "local",
      model: "local:nomic-embed-text",
      inputTokens: 95,
      outputTokens: null,
      units: 1,
      estimatedCostUsd: null,
      requestId: null,
      idempotencyKey: "embedding:prior",
    });
    ctx.quota = new QuotaManager(usage, { dailyEmbeddingTokenLimit: 100 });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rag/query",
      headers: auth.headers,
      payload: { question: "What does the runbook say about rollbacks?" },
    });

    expect(res.statusCode).toBe(429);
    expect((res.json() as { error: { code: string } }).error.code).toBe("QUOTA_EXCEEDED");
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/daily embedding token limit/i);
    // Only the row that was already there: the refused query embedded nothing and charged nothing.
    expect(await db.select().from(usageRecords)).toHaveLength(1);
  });

  it("records the embedding a retrieval actually performed", async () => {
    ctx.embeddings = realEmbedder();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rag/query",
      headers: auth.headers,
      payload: { question: "What does the runbook say about rollbacks?" },
    });
    expect(res.statusCode).toBe(200);

    const rows = await db.select().from(usageRecords).where(eq(usageRecords.kind, "embedding"));
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("local");
    expect(rows[0].projectId).toBe(auth.projectId);
    expect(Number(rows[0].inputTokens)).toBeGreaterThan(0);
    // The person who asked, so the ledger can attribute the spend.
    expect(rows[0].userId).toBe(auth.userId);
  });

  it("does not record a charge for the lexical fallback, which costs nothing", async () => {
    // The harness's default embedder IS the fallback.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rag/query",
      headers: auth.headers,
      payload: { question: "anything at all" },
    });
    expect(res.statusCode).toBe(200);
    expect(await db.select().from(usageRecords).where(eq(usageRecords.kind, "embedding"))).toHaveLength(0);
  });

  it("refuses a video retry that would exceed the project's video budget", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/videos",
      headers: auth.headers,
      payload: { prompt: "a short film about rollbacks", targetDurationSeconds: 8, sceneClipSeconds: 4 },
    });
    expect(created.statusCode).toBe(202);
    const { project } = created.json() as { project: { id: string } };

    // Budget exhausted between creation and the retry — exactly the state the create route
    // refuses and the retry route used to ignore.
    ctx.quota = new QuotaManager(new PgUsageRecordRepository(db), { monthlyVideoSecondsLimit: 1 });

    const retried = await app.inject({
      method: "POST",
      url: `/api/v1/videos/${project.id}/retry`,
      headers: auth.headers,
      payload: {},
    });
    expect(retried.statusCode).toBe(429);
    expect((retried.json() as { error: { code: string } }).error.code).toBe("QUOTA_EXCEEDED");
  });

  it("caps the retry and replay routes, which re-enqueue paid work", async () => {
    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/videos/7d8f3c2e-1b4a-4c6d-9e8f-0a1b2c3d4e5f/retry",
      headers: auth.headers,
      payload: {},
    });
    // 404 for the unknown id, but the limit header proves the cap is applied to this route.
    expect(retry.headers["x-ratelimit-limit"]).toBe("5");

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/jobs/dead-letter/image.generate/7d8f3c2e-1b4a-4c6d-9e8f-0a1b2c3d4e5f/replay",
      headers: auth.headers,
      payload: {},
    });
    expect(replay.headers["x-ratelimit-limit"]).toBe("10");
  });

  it("refuses to replay an image generation when the daily image budget is spent", async () => {
    ctx.quota = new QuotaManager(new PgUsageRecordRepository(db), { dailyImageLimit: 0 });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/jobs/dead-letter/image.generate/7d8f3c2e-1b4a-4c6d-9e8f-0a1b2c3d4e5f/replay",
      headers: auth.headers,
      payload: {},
    });
    // The budget is checked before the dead letter is even looked up: no quota, no replay.
    expect(res.statusCode).toBe(429);
  });

  /**
   * Replay prices what it re-runs, and only re-runs dead letters — docs/26_DECISIONS.md ADR-130.
   *
   * Only `image.generate` was ever checked, so replaying a speech job or a video scene passed
   * through no budget at all — the dead-letter screen was a way around the ceiling the create
   * routes enforce. And the queue name came straight from the URL, so a LIVE queue could be
   * addressed by name and a completed job re-sent to it, repeatedly.
   */
  it("refuses to replay a speech job when the speech budget is spent", async () => {
    /**
     * This test could only ever take the 404 branch — docs/26_DECISIONS.md ADR-159.
     *
     * It posted a UUID that was never inserted, so `getDeadLettered` returned null, the route's
     * `sourceQueue === "audio.generate" && payload` arm was never entered, and the assertion
     * `expect([429, 404]).toContain(...)` was satisfied by the 404 that a missing job produces
     * whatever the pricing code does. The branch it is named for — ADR-130's speech pricing —
     * was executed by nothing.
     *
     * A REAL dead letter now: an `audio.generate` job whose payload names a real generation row
     * with real text, failed into its dead-letter queue, replayed against a zero-character
     * ceiling. The disjunction is gone: this asserts 429.
     */
    const generation = await ctx.audioGenerations.create({
      id: "dead-letter-speech",
      projectId: auth.projectId,
      createdByUserId: auth.userId,
      request: { text: "a hundred characters of narration that will be priced on replay", speed: 1 },
    });

    /**
     * The dead letter is seeded directly onto the dead-letter QUEUE, which is what a dead letter
     * IS: `getDeadLettered` reads `pgboss.job where name = 'audio.generate.dlq'`. Driving a
     * real failure through pg-boss's retry and archive machinery takes tens of seconds and adds
     * nothing — the route under test reads this row and nothing else.
     */
    await ctx.jobQueue.ensureQueueWithDeadLetter("audio.generate", { retryLimit: 0, expireInSeconds: 5 });
    const deadLetterId = await ctx.jobQueue.enqueue("audio.generate.dlq", {
      projectId: auth.projectId,
      generationId: generation.id,
    });
    expect(deadLetterId).toBeTruthy();

    ctx.quota = new QuotaManager(new PgUsageRecordRepository(db), { dailySpeechCharacterLimit: 0 });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/jobs/dead-letter/audio.generate.dlq/${deadLetterId}/replay`,
      headers: auth.headers,
      payload: {},
    });

    expect(res.statusCode).toBe(429);
    expect((res.json() as { error: { code: string } }).error.code).toBe("QUOTA_EXCEEDED");
  });

  it("refuses to replay from a live queue name, not only from a dead-letter queue", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/jobs/dead-letter/image.generate/7d8f3c2e-1b4a-4c6d-9e8f-0a1b2c3d4e5f/replay",
      headers: auth.headers,
      payload: {},
    });
    // Not a replay: a name that is not a `.dlq` addresses nothing at all now.
    expect(res.statusCode).toBe(404);
  });

  it("does not hand the model provider's own error text to the caller", async () => {
    // A provider failure that names its host, model and account — none of which belongs in a
    // response to a tenant.
    const leaky = "upstream https://api.internal.example/v1 model gpt-internal-7 org_id=acct_9f3 failed: quota exhausted";
    ctx.router = {
      ...ctx.router,
      streamChat: async function* () {
        yield { type: "error" as const, message: leaky };
      },
    } as unknown as typeof ctx.router;

    await seedRetrievableChunk();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rag/query",
      headers: auth.headers,
      // The chunk's own words, so the match is exact and this test cannot pass on a miss.
      payload: { question: "Roll back with the documented script.", retrieveOnly: false },
    });

    // The model WAS reached — otherwise this test would pass on the no-evidence short circuit.
    expect(res.statusCode).toBe(503);
    const body = res.body;
    expect(body).not.toContain("api.internal.example");
    expect(body).not.toContain("acct_9f3");
    expect(body).not.toContain("gpt-internal-7");
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/could not answer/i);
  });
});
