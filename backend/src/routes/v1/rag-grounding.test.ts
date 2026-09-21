import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import type { ChatStreamEvent, LLMProvider, ProviderCapabilities } from "@ai-platform/shared";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * What `POST /api/v1/rag/query` does with the answer a model actually gives — ADR-161.
 *
 * The route's grounding half had no test at all: every existing test of it is in
 * `spend-guards.test.ts` and is about budgets. The fifth audit's real acceptance run found what
 * that gap was hiding. Asked "How many days of paid leave does an engineer get?" over a handbook
 * saying 27, with retrieval working correctly (one passage, cosine distance 0.208), qwen2.5:7b
 * answered with the complete text:
 *
 *   [1]
 *
 * `checkGrounding` passed it — evidence existed, and `[1]` was a real marker — so the endpoint
 * replied `200` with `grounded: true`, and a client rendering `answer` showed its user "[1]".
 * `grounded` is the platform's assurance that the caller holds an evidenced answer; here there
 * was no answer to be evidenced.
 */
class AnsweringProvider implements LLMProvider {
  readonly name = "scripted";
  readonly isMock = false;
  readonly model = "scripted-1";

  constructor(private readonly answer: string) {}

  capabilities(): ProviderCapabilities {
    return { streaming: true, toolCalling: false, structuredOutput: false, vision: false, contextWindow: null };
  }

  async *streamChat(): AsyncGenerator<ChatStreamEvent, void, unknown> {
    yield { type: "token", delta: this.answer };
    yield {
      type: "done",
      message: { role: "assistant", content: this.answer },
      usage: { inputTokens: 40, outputTokens: 2 },
      provider: this.name,
      model: this.model,
      finishReason: "stop",
    };
  }
}

describe("RAG grounding, at the route", () => {
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

  const answerWith = (text: string) => {
    const registry = new ModelRegistry();
    registry.register(new AnsweringProvider(text), { asDefault: true });
    ctx.router = new ModelRouter(registry);
  };

  /** One retrievable passage that really does contain the answer. */
  const seedHandbook = async () => {
    await ctx.documents.create({
      id: "doc-handbook",
      projectId: auth.projectId,
      uploadedByUserId: auth.userId,
      filename: "handbook.txt",
      sourcePath: "handbook.txt",
    });
    await ctx.documents.updateStatus(auth.projectId, "doc-handbook", "ready");
    const content = "Vacation policy: every engineer receives 27 days of paid leave per calendar year.";
    const [vector] = await ctx.embeddings.embed([content]);
    await ctx.documentChunks.createMany([
      {
        id: "chunk-handbook",
        documentId: "doc-handbook",
        projectId: auth.projectId,
        chunkIndex: 0,
        content,
        embedding: vector.vector,
        embeddingModel: vector.model,
        embeddingDims: vector.vector.length,
      },
    ]);
  };

  const ask = (question = "How many days of paid leave does an engineer get?") =>
    app.inject({ method: "POST", url: "/api/v1/rag/query", headers: auth.headers, payload: { question } });

  it("refuses to call a bare citation marker a grounded answer", async () => {
    await seedHandbook();
    answerWith("[1]");

    const res = await ask();
    expect(res.statusCode).toBe(200);
    const body = res.json() as { answer: string; grounded: boolean; groundingViolation?: string; sources: unknown[] };

    expect(body.grounded).toBe(false);
    expect(body.groundingViolation).toBe("citation_without_answer");
    // And the caller is still given the passages that really were retrieved.
    expect(body.sources.length).toBeGreaterThan(0);
  });

  it("does not tell the caller their documents lack an answer those documents contain", async () => {
    // The wrong sentence here is worse than useless: it sends an operator off to add a document
    // they already have. The failure was the model's, and the message has to say so.
    await seedHandbook();
    answerWith("[1]");

    const body = (await ask()).json() as { answer: string };
    expect(body.answer).not.toMatch(/do not contain the answer/i);
    expect(body.answer).toMatch(/did not write an answer/i);
  });

  it("still says 'the documents do not contain it' when a citation was fabricated", async () => {
    // The other violation keeps the cautious sentence: repeating an answer built on an invented
    // source would be the original ADR-075 defect with better manners.
    await seedHandbook();
    answerWith("According to [7], engineers get 40 days.");

    const body = (await ask()).json() as { answer: string; grounded: boolean; groundingViolation?: string };
    expect(body.grounded).toBe(false);
    expect(body.groundingViolation).toBe("fabricated_citation");
    expect(body.answer).toMatch(/do not contain the answer/i);
  });

  it("passes a real answer through untouched", async () => {
    // The control. A rule that rejected everything would satisfy the assertions above.
    await seedHandbook();
    answerWith("Every engineer receives 27 days of paid leave per calendar year [1].");

    const body = (await ask()).json() as { answer: string; grounded: boolean; retrievedCount: number };
    expect(body.grounded).toBe(true);
    expect(body.answer).toContain("27 days");
    expect(body.retrievedCount).toBeGreaterThan(0);
  });

  it("passes a one-word answer through — brevity is not the defect", async () => {
    await seedHandbook();
    answerWith("27 [1]");

    const body = (await ask()).json() as { answer: string; grounded: boolean };
    expect(body.grounded).toBe(true);
    expect(body.answer).toBe("27 [1]");
  });
});
