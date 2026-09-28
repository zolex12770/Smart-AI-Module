import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { usageRecords, type PgliteDb } from "@ai-platform/database";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import type { ChatStreamEvent, LLMProvider, ProviderCapabilities } from "@ai-platform/shared";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * A provider that dies mid-answer is a failure, not a success — docs/26_DECISIONS.md ADR-151.
 *
 * Once a provider has committed, the router cannot fail over: part of its answer is already on
 * the client's screen. So it converts a later throw into an in-band `error` event and returns
 * rather than throwing. The chat route treated that like any other non-terminal event — forwarded
 * it and kept iterating — so the `for await` ended normally, `completed` stayed false, the signal
 * was not aborted, and neither the cancellation branch nor the catch ran. The span kept
 * `gen_ai.system: "unknown"` and an OK status, nothing was logged at error level, and the half of
 * the answer the user could read was never stored. An outage that cut every stream in half read
 * as a clean day in the traces.
 */
class HalfwayProvider implements LLMProvider {
  readonly name = "halfway";
  readonly isMock = false;
  readonly model = "halfway-1";

  capabilities(): ProviderCapabilities {
    return { streaming: true, toolCalling: false, structuredOutput: false, vision: false, contextWindow: null };
  }

  async *streamChat(): AsyncGenerator<ChatStreamEvent, void, unknown> {
    yield { type: "token", delta: "The first half of the answer" };
    // Committed, and then broken. This is what a dropped upstream connection looks like from
    // the router's side.
    throw new Error("connection reset by peer");
  }
}

describe("a provider that fails partway through a chat stream", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;
  let auth: Awaited<ReturnType<typeof buildTestApp>>["auth"];

  beforeEach(async () => {
    ({ app, db, ctx, auth } = await buildTestApp());
    const registry = new ModelRegistry();
    registry.register(new HalfwayProvider(), { asDefault: true });
    ctx.router = new ModelRouter(registry);
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  const ask = () =>
    app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: auth.headers,
      payload: { messages: [{ role: "user", content: "Tell me about the harbour." }] },
    });

  it("tells the client, and stores the half the user can see", async () => {
    const res = await ask();
    expect(res.statusCode).toBe(200);

    // The client is told, in band, and the stream ends there rather than carrying on.
    expect(res.body).toContain("The first half of the answer");
    expect(res.body).toMatch(/"type":"error"/);

    const conversations = await ctx.conversations.list(auth.projectId);
    expect(conversations).toHaveLength(1);
    const messages = await ctx.messages.listByConversation(auth.projectId, conversations[0].id);
    const assistant = messages.filter((m) => m.role === "assistant");

    // Before the fix there was no assistant row at all: the user saw half an answer and the
    // transcript said the assistant never spoke.
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toContain("The first half of the answer");
    // And it is marked, so a later turn reading this transcript is not told the truncated
    // answer was the whole one.
    expect(assistant[0].content).toMatch(/cut off/i);
  });

  it("does not record the failed turn as a completed one", async () => {
    await ask();
    // Not a COMPLETED turn: there is no `done` event and so no `llm:message:<id>` charge, the
    // key a finished answer is billed under. What the provider did consume — the prompt and the
    // half it streamed — is still charged, as an estimate under its own key (DL-10, superseding
    // ADR-151's "no row at all", which let a failed or abandoned turn cost nothing).
    const rows = await db.select().from(usageRecords);
    expect(rows.filter((r) => r.idempotencyKey?.startsWith("llm:message:"))).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toMatch(/^llm:message-partial:/);
  });
});
