import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { conversations, PgUsageRecordRepository, type PgliteDb } from "@ai-platform/database";
import { QuotaManager } from "@ai-platform/quota";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * What a chat caller may choose, and what the operator chooses — audit finding 4
 * (docs/DECISION_LOG.md).
 *
 * The public chat body accepted `model` (sent verbatim by every adapter, so any model the
 * operator's key reaches, at any price) and `maxOutputTokens` up to 200,000, while the quota
 * pre-check counted only the prompt. One request could spend far past a project's allowance.
 */
describe("POST /api/v1/chat — per-request overrides", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;
  let auth: Awaited<ReturnType<typeof buildTestApp>>["auth"];

  beforeEach(async () => {
    ({ app, db, ctx, auth } = await buildTestApp());
    ctx.chatMaxOutputTokens = 1000;
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  const chat = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: auth.headers,
      payload: { messages: [{ role: "user", content: "hello" }], ...payload },
    });

  it("refuses a per-request model, before any provider call or stored conversation", async () => {
    const stream = vi.spyOn(ctx.router, "streamChat");
    const res = await chat({ model: "the-most-expensive-model" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/model/);
    expect(stream).not.toHaveBeenCalled();
    expect(await db.select().from(conversations)).toHaveLength(0);
  });

  it("refuses maxOutputTokens above CHAT_MAX_OUTPUT_TOKENS", async () => {
    const stream = vi.spyOn(ctx.router, "streamChat");
    const res = await chat({ maxOutputTokens: 1001 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/at most 1000/);
    expect(stream).not.toHaveBeenCalled();
  });

  it("holds the provider to the cap when the caller asks for none, and to the caller's smaller value", async () => {
    const stream = vi.spyOn(ctx.router, "streamChat");
    expect((await chat({})).statusCode).toBe(200);
    expect(stream.mock.calls[0][0].maxOutputTokens).toBe(1000);
    expect((await chat({ maxOutputTokens: 50 })).statusCode).toBe(200);
    expect(stream.mock.calls[1][0].maxOutputTokens).toBe(50);
  });

  it("counts the output the turn may produce in the quota pre-check, not just the prompt", async () => {
    // 600 tokens left today: a one-word prompt fits, a 1000-token reply does not.
    ctx.quota = new QuotaManager(new PgUsageRecordRepository(db), { dailyTokenLimit: 600 });
    const stream = vi.spyOn(ctx.router, "streamChat");

    const refused = await chat({});
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("QUOTA_EXCEEDED");
    expect(stream).not.toHaveBeenCalled();

    const allowed = await chat({ maxOutputTokens: 100 });
    expect(allowed.statusCode).toBe(200);
    expect(stream).toHaveBeenCalledTimes(1);
  });
});
