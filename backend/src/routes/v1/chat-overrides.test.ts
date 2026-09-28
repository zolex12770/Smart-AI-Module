import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { conversations, PgUsageRecordRepository, type PgliteDb } from "@ai-platform/database";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import { QuotaManager } from "@ai-platform/quota";
import { TRUNCATION_MARKER } from "./chat.js";
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

describe("POST /api/v1/chat — an answer cut off at the output limit", () => {
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

  it("is stored with the same marker the screen shows, so a reload does not present it as complete", async () => {
    const registry = new ModelRegistry();
    registry.register(
      {
        name: "capped",
        isMock: false,
        model: "capped-1",
        capabilities: () => ({ streaming: true, toolCalling: false, structuredOutput: false, vision: false, contextWindow: null }),
        async *streamChat() {
          yield { type: "token", delta: "The first three steps are" };
          yield {
            type: "done",
            message: { role: "assistant", content: "The first three steps are" },
            usage: { inputTokens: 5, outputTokens: 7 },
            provider: "capped",
            model: "capped-1",
            finishReason: "length",
          };
        },
      },
      { asDefault: true }
    );
    ctx.router = new ModelRouter(registry);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: auth.headers,
      payload: { messages: [{ role: "user", content: "List every step" }] },
    });
    const conversationId = res.headers["x-conversation-id"] as string;
    const stored = (
      await app.inject({ method: "GET", url: `/api/v1/conversations/${conversationId}/messages`, headers: auth.headers })
    ).json() as { messages: Array<{ role: string; content: string }> };
    const answer = stored.messages.find((m) => m.role === "assistant")!;
    expect(answer.content).toBe(`The first three steps are${TRUNCATION_MARKER}`);
    // The frontend cannot import this constant (it imports nothing from the backend); it must
    // carry the same words.
    const view = readFileSync(fileURLToPath(new URL("../../../../frontend/app/chat/ChatView.tsx", import.meta.url)), "utf8");
    expect(view).toContain(TRUNCATION_MARKER.trim());
  });
});
