import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { EmbeddingService } from "@ai-platform/embeddings";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import type { ChatStreamEvent, LLMProvider, ProviderCapabilities } from "@ai-platform/shared";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * A RAG answer has a deadline — audit finding 19. `POST /rag/query` called the router with no
 * signal, so a provider that stalled held the request open for as long as the connection lived.
 */
class StalledProvider implements LLMProvider {
  readonly name = "stalled";
  readonly isMock = false;
  readonly model = "stalled-1";
  capabilities(): ProviderCapabilities {
    return { streaming: true, toolCalling: false, structuredOutput: false, vision: false, contextWindow: null };
  }
  async *streamChat(): AsyncGenerator<ChatStreamEvent, void, unknown> {
    await new Promise(() => undefined); // never answers
    yield { type: "error", message: "unreachable" };
  }
}

describe("POST /api/v1/rag/query deadline", () => {
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

  it("answers 503 at the deadline instead of hanging", async () => {
    ctx.embeddings = new EmbeddingService({
      name: "local",
      model: "nomic-embed-text",
      dimensions: 8,
      isDeterministicFallback: false,
      embed: async (texts: string[]) => texts.map(() => Array.from({ length: 8 }, (_, i) => (i + 1) / 10)),
    });
    await ctx.documents.create({ id: "doc-1", projectId: auth.projectId, uploadedByUserId: auth.userId, filename: "a.md", sourcePath: "a.md" });
    await ctx.documents.updateStatus(auth.projectId, "doc-1", "ready");
    const [vector] = await ctx.embeddings.embed(["The harbour closes at 22:00."]);
    await ctx.documentChunks.createMany([
      {
        id: "chunk-1",
        documentId: "doc-1",
        projectId: auth.projectId,
        chunkIndex: 0,
        content: "The harbour closes at 22:00.",
        embedding: vector.vector,
        embeddingModel: vector.model,
        embeddingDims: vector.vector.length,
      },
    ]);
    const registry = new ModelRegistry();
    registry.register(new StalledProvider(), { asDefault: true });
    ctx.router = new ModelRouter(registry);
    ctx.auxiliaryCallTimeoutMs = 300;

    const started = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/rag/query",
      headers: auth.headers,
      payload: { question: "When does the harbour close?" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toMatch(/did not answer within/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
