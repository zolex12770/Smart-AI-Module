import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { conversations, messages, PgUsageRecordRepository, usageRecords, type PgliteDb } from "@ai-platform/database";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import { QuotaManager } from "@ai-platform/quota";
import type { ChatRequest, ChatStreamEvent, LLMProvider, ProviderCapabilities } from "@ai-platform/shared";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * Every turn a provider started is charged — audit findings 12, 13 and 25 (docs/DECISION_LOG.md
 * DL-10).
 *
 * Usage was written on `done` only, so a client that disconnected just before the end, or a
 * provider that failed halfway, consumed tokens that reached neither the ledger nor the quota.
 * Memory extraction charged itself LAST, after a parse and a store that could throw. And the
 * quota was checked only after the conversation and message had been written.
 */
class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  readonly isMock = false;
  readonly model = "scripted-1";
  constructor(private readonly script: (request: ChatRequest) => AsyncGenerator<ChatStreamEvent, void, unknown>) {}
  capabilities(): ProviderCapabilities {
    return { streaming: true, toolCalling: false, structuredOutput: true, vision: false, contextWindow: null };
  }
  streamChat(request: ChatRequest) {
    return this.script(request);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("chat billing for turns that do not finish", () => {
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

  const useProvider = (script: (request: ChatRequest) => AsyncGenerator<ChatStreamEvent, void, unknown>) => {
    const registry = new ModelRegistry();
    registry.register(new ScriptedProvider(script), { asDefault: true });
    ctx.router = new ModelRouter(registry);
  };

  const rows = () => db.select().from(usageRecords);

  it("charges the prompt and the streamed text when the provider fails partway", async () => {
    useProvider(async function* () {
      yield { type: "token", delta: "The first half of a long answer about harbours" };
      throw new Error("connection reset by peer");
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: auth.headers,
      payload: { messages: [{ role: "user", content: "Tell me about the harbour." }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("event: error");
    const charged = await rows();
    expect(charged).toHaveLength(1);
    expect(charged[0]).toMatchObject({ kind: "llm", provider: "scripted", model: "scripted-1" });
    expect(charged[0].idempotencyKey).toMatch(/^llm:message-partial:/);
    expect(charged[0].inputTokens).toBeGreaterThan(0);
    expect(charged[0].outputTokens).toBeGreaterThan(0);
  });

  it("charges a turn the client walked away from", async () => {
    useProvider(async function* () {
      for (let i = 0; i < 200; i++) {
        yield { type: "token", delta: `word${i} ` };
        await sleep(20);
      }
      yield {
        type: "done",
        message: { role: "assistant", content: "unreachable" },
        usage: { inputTokens: 1, outputTokens: 1 },
        provider: "scripted",
        model: "scripted-1",
        finishReason: "stop",
      };
    });
    // A real socket: a client disconnect is what the route listens for, and inject cannot close one.
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/v1/chat`, {
      method: "POST",
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Count for me." }] }),
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    let seen = "";
    while (!seen.includes("word5")) seen += new TextDecoder().decode((await reader.read()).value);
    controller.abort();

    let charged = await rows();
    for (let i = 0; i < 50 && charged.length === 0; i++) {
      await sleep(100);
      charged = await rows();
    }
    expect(charged).toHaveLength(1);
    expect(charged[0].idempotencyKey).toMatch(/^llm:message-partial:/);
    expect(charged[0].outputTokens).toBeGreaterThan(0);
  });

  it("charges a memory extraction even when storing what it found fails", async () => {
    ctx.memoryExtractionEnabled = true;
    useProvider(async function* (request) {
      const extracting = request.messages[0]?.role === "system" && request.responseFormat === "json_object";
      const content = extracting ? '{"facts":[{"content":"The user keeps a boat called Tern"}]}' : "Noted.";
      yield { type: "token", delta: content };
      yield {
        type: "done",
        message: { role: "assistant", content },
        usage: { inputTokens: 40, outputTokens: 12 },
        provider: "scripted",
        model: "scripted-1",
        finishReason: "stop",
      };
    });
    ctx.memory.recordExtracted = async () => {
      throw new Error("simulated store failure");
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: auth.headers,
      payload: { messages: [{ role: "user", content: "I keep a boat called Tern." }] },
    });
    expect(res.statusCode).toBe(200);
    let keys: string[] = [];
    for (let i = 0; i < 50 && !keys.some((k) => k.startsWith("llm:memory-extraction:")); i++) {
      await sleep(50);
      keys = (await rows()).map((r) => r.idempotencyKey ?? "");
    }
    expect(keys.some((k) => k.startsWith("llm:memory-extraction:"))).toBe(true);
  });

  it("refuses an over-quota turn before writing a conversation or a message", async () => {
    ctx.quota = new QuotaManager(new PgUsageRecordRepository(db), { dailyTokenLimit: 10 });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: auth.headers,
      payload: { messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.statusCode).toBe(429);
    expect(await db.select().from(conversations)).toHaveLength(0);
    expect(await db.select().from(messages)).toHaveLength(0);
  });
});
