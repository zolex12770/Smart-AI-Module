import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { usageRecords, type PgliteDb } from "@ai-platform/database";
import { like } from "drizzle-orm";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * Every real summarization call is charged — docs/26_DECISIONS.md ADR-110.
 *
 * The usage key for a summary was the conversation id plus the stored summary count, which two real
 * provider calls share whenever they start from the same count. The case exercised here is the one
 * the audit reproduced: a pass whose summary fails to persist, so the next request re-summarizes from
 * the unchanged count. The second call's real tokens hit the unique index and were silently dropped
 * from the ledger and from quota.
 */
describe("POST /api/v1/chat conversation summarization", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;
  let auth: Awaited<ReturnType<typeof buildTestApp>>["auth"];

  beforeEach(async () => {
    ({ app, db, ctx, auth } = await buildTestApp());
    ctx.conversationWindow.maxPromptTokens = 200;
    ctx.conversationWindow.liveWindowMessages = 4;
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  it("records a usage row for each summarization call, even when two start from the same stored count", async () => {
    const history = Array.from({ length: 11 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn ${i} ` + "x".repeat(300),
    }));

    const original = ctx.conversations.updateSummary.bind(ctx.conversations);
    let failNext = true;
    ctx.conversations.updateSummary = async (...args: Parameters<typeof original>) => {
      if (failNext) {
        failNext = false;
        throw new Error("simulated write failure");
      }
      return original(...args);
    };

    const first = await app.inject({ method: "POST", url: "/api/v1/chat", headers: auth.headers, payload: { messages: history } });
    expect(first.statusCode).toBe(200);
    const conversationId = first.headers["x-conversation-id"] as string;
    expect(conversationId).toBeTruthy();

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: auth.headers,
      payload: { conversationId, messages: history },
    });
    expect(second.statusCode).toBe(200);

    const summaryRows = await db.select().from(usageRecords).where(like(usageRecords.idempotencyKey, "llm:summary:%"));
    expect(summaryRows).toHaveLength(2);
  });
});
