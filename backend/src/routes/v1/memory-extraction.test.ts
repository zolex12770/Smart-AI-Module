import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * The platform forms a memory from a conversation — docs/26_DECISIONS.md ADR-141.
 *
 * `MEMORY_EXTRACTION_PROMPT`, `parseExtractedFacts` and `MemoryService.recordExtracted` all
 * shipped, all had tests, and nothing in production called any of them: a grep across the whole
 * repository found the three definitions and their own unit tests, and no other caller. So memory
 * held only what somebody typed into the Memory screen by hand — the platform retrieved memories
 * and injected them, and never formed one. "It remembers what you tell it across conversations"
 * was true the way a notebook remembers.
 *
 * The extraction is deliberately not awaited by the response, so these wait for it.
 */
describe("a finished chat turn can form a memory", () => {
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

  /** A router whose SECOND call (the extraction) returns facts; the first is the chat answer. */
  function routerReturning(answers: string[]): void {
    let call = 0;
    const original = ctx.router;
    ctx.router = {
      ...original,
      streamChat: async function* () {
        const content = answers[Math.min(call++, answers.length - 1)]!;
        yield { type: "token", delta: content };
        yield {
          type: "done",
          message: { role: "assistant", content },
          usage: { inputTokens: 10, outputTokens: 5 },
          provider: "scripted",
          model: "scripted-1",
          finishReason: "stop",
        };
      },
    } as typeof ctx.router;
  }

  async function sendChat(message: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: auth.headers,
      payload: { messages: [{ role: "user", content: message }] },
    });
  }

  async function waitForMemories(atLeast: number) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const items = await ctx.memoryItems.listRecent({ projectId: auth.projectId, userId: auth.userId, limit: 20 });
      if (items.length >= atLeast) return items;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return ctx.memoryItems.listRecent({ projectId: auth.projectId, userId: auth.userId, limit: 20 });
  }

  it("stores a fact the model extracted from the exchange", async () => {
    ctx.memoryExtractionEnabled = true;
    routerReturning([
      "TypeScript is a good choice for that.",
      JSON.stringify({ facts: [{ content: "Prefers TypeScript over JavaScript for new projects", scope: "user" }] }),
    ]);

    const res = await sendChat("I always use TypeScript for new projects, never plain JS.");
    expect(res.statusCode).toBe(200);

    const items = await waitForMemories(1);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.map((i) => i.content).join(" ")).toMatch(/TypeScript/);
    // Recorded as EXTRACTED, not as something the user typed: provenance is the difference
    // between a fact the platform inferred and one it was told.
    expect(items[0]!.source).toBe("extracted");
  });

  it("forms nothing when extraction is switched off", async () => {
    // The switch exists because this is a second model call per turn; it must really switch off.
    ctx.memoryExtractionEnabled = false;
    routerReturning([
      "Noted.",
      JSON.stringify({ facts: [{ content: "Prefers TypeScript over JavaScript", scope: "user" }] }),
    ]);

    const res = await sendChat("I always use TypeScript.");
    expect(res.statusCode).toBe(200);

    // Given time to have happened, and it did not.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await ctx.memoryItems.listRecent({ projectId: auth.projectId, userId: auth.userId, limit: 20 })).toEqual([]);
  });

  it("forms nothing when the model returns no facts, rather than storing the reply", async () => {
    ctx.memoryExtractionEnabled = true;
    routerReturning(["Sure.", JSON.stringify({ facts: [] })]);

    expect((await sendChat("what time is it?")).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await ctx.memoryItems.listRecent({ projectId: auth.projectId, userId: auth.userId, limit: 20 })).toEqual([]);
  });

  it("leaves the turn successful when extraction fails", async () => {
    // The turn has already been answered and billed. Losing a fact is small; failing a completed
    // answer over it would not be.
    ctx.memoryExtractionEnabled = true;
    let call = 0;
    const original = ctx.router;
    ctx.router = {
      ...original,
      streamChat: async function* () {
        if (call++ === 1) throw new Error("the extraction provider exploded");
        yield { type: "token", delta: "Fine." };
        yield {
          type: "done",
          message: { role: "assistant", content: "Fine." },
          usage: { inputTokens: 1, outputTokens: 1 },
          provider: "scripted",
          model: "scripted-1",
          finishReason: "stop",
        };
      },
    } as typeof ctx.router;

    const res = await sendChat("hello");
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/Fine\./);
  });

  it("does not extract when the daily token budget is spent", async () => {
    // An unbudgeted background call would be a way to spend past a ceiling the turn respected.
    ctx.memoryExtractionEnabled = true;
    routerReturning([
      "Noted.",
      JSON.stringify({ facts: [{ content: "Prefers TypeScript over JavaScript", scope: "user" }] }),
    ]);
    const realCheck = ctx.quota.checkLlmTokens.bind(ctx.quota);
    let calls = 0;
    ctx.quota = {
      ...ctx.quota,
      // The chat turn's own check passes; the extraction's is refused.
      checkLlmTokens: async (projectId: string, tokens: number) =>
        ++calls > 1 ? { allowed: false, reason: "Daily token limit reached." } : realCheck(projectId, tokens),
    } as typeof ctx.quota;

    expect((await sendChat("I always use TypeScript.")).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await ctx.memoryItems.listRecent({ projectId: auth.projectId, userId: auth.userId, limit: 20 })).toEqual([]);
  });
});
