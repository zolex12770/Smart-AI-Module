import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DrizzleDb } from "@ai-platform/database";
import { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import type {
  ChatMessage,
  ChatRequest,
  ChatStreamEvent,
  LLMProvider,
  ProviderCapabilities,
} from "@ai-platform/shared";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * docs/26_DECISIONS.md ADR-063 — the end-to-end proof that **memory influences what the model
 * sees**, asserted through the real HTTP stack rather than against the service in isolation.
 *
 * The ADR-047 audit rated memory a SKELETON because nothing ever retrieved a stored row into a
 * prompt. A unit test of `MemoryService` cannot close that finding on its own: the claim is
 * about the wiring, so the assertion here is on the message array a provider actually received
 * after a real `POST /api/v1/chat`.
 */

/** A provider that records exactly what it was asked to answer. */
class RecordingProvider implements LLMProvider {
  readonly name = "recording";
  readonly isMock = false;
  readonly model = "recording-1";
  readonly seen: ChatMessage[][] = [];

  capabilities(): ProviderCapabilities {
    return { streaming: true, toolCalling: false, structuredOutput: false, vision: false, contextWindow: null };
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    this.seen.push(structuredClone(request.messages) as ChatMessage[]);
    yield { type: "token", delta: "ok" };
    yield {
      type: "done",
      message: { role: "assistant", content: "ok" },
      usage: { inputTokens: 5, outputTokens: 1 },
      provider: this.name,
      model: this.model,
      finishReason: "stop",
    };
  }
}

describe("memory reaches the model (ADR-063)", () => {
  let app: FastifyInstance;
  let db: DrizzleDb;
  let ctx: AppContext;
  let auth: Awaited<ReturnType<typeof buildTestApp>>["auth"];
  let provider: RecordingProvider;

  beforeEach(async () => {
    ({ app, db, ctx, auth } = await buildTestApp());
    // Route handlers read `ctx.router` per request, so swapping it here is enough to observe
    // the exact prompt the platform builds.
    provider = new RecordingProvider();
    const registry = new ModelRegistry();
    registry.register(provider, { asDefault: true });
    ctx.router = new ModelRouter(registry);
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  const chat = (content: string) =>
    app.inject({
      headers: auth.headers,
      method: "POST",
      url: "/api/v1/chat",
      payload: { messages: [{ role: "user", content }] },
    });

  it("injects a relevant stored memory into the prompt the provider receives", async () => {
    // Stored the way a user would: through the real, authenticated HTTP route.
    const stored = await app.inject({
      headers: auth.headers,
      method: "POST",
      url: "/api/v1/memory",
      payload: { scope: "project", content: "This project deploys with Terraform to Cloud Run." },
    });
    expect(stored.statusCode).toBe(201);

    const res = await chat("Which terraform target do we deploy to?");
    expect(res.statusCode).toBe(200);

    expect(provider.seen).toHaveLength(1);
    const prompt = provider.seen[0];
    // The observable effect: the platform added a system message the client never sent.
    // The recalled block is one of TWO system messages now (ADR-149): the fact is delimited
    // like every other piece of somebody else's text, and the instruction that gives the
    // delimiter its meaning goes with it.
    const system = prompt.filter((m) => m.role === "system");
    expect(system.length).toBe(2);
    expect(system[0].content).toContain("untrusted_content");
    expect(system[1].content).toContain("Terraform");
    expect(system[1].content).toMatch(/^<untrusted_content>/);
    // ...and the user's own message is still there, last.
    expect(prompt.at(-1)).toMatchObject({ role: "user", content: "Which terraform target do we deploy to?" });
  });

  it("adds NOTHING when no stored memory is relevant to the question", async () => {
    await app.inject({
      headers: auth.headers,
      method: "POST",
      url: "/api/v1/memory",
      payload: { scope: "project", content: "This project deploys with Terraform to Cloud Run." },
    });

    const res = await chat("What is a good recipe for sourdough bread?");
    expect(res.statusCode).toBe(200);

    const prompt = provider.seen[0];
    expect(prompt.some((m) => m.role === "system")).toBe(false);
    expect(prompt).toHaveLength(1);
  });

  it("never injects another project's memory", async () => {
    // A second project owned by the same user: same tenant, different scope boundary.
    const created = await app.inject({
      headers: auth.headers,
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "Second project" },
    });
    expect(created.statusCode).toBe(201);
    const otherProjectId = created.json().project.id as string;

    await app.inject({
      headers: { ...auth.headers, "x-project-id": otherProjectId },
      method: "POST",
      url: "/api/v1/memory",
      payload: { scope: "project", content: "This project deploys with Terraform to Cloud Run." },
    });

    // Ask in the FIRST project, where that memory does not belong.
    const res = await chat("Which terraform target do we deploy to?");
    expect(res.statusCode).toBe(200);
    const prompt = provider.seen[0];
    expect(prompt.some((m) => m.role === "system" && m.content.includes("Terraform"))).toBe(false);
  });

  it("keeps a conversation-scoped memory inside its own conversation", async () => {
    const first = await chat("First question in thread one.");
    const conversationId = first.headers["x-conversation-id"] as string;
    expect(conversationId).toBeTruthy();

    await ctx.memory.remember({
      projectId: auth.projectId,
      userId: auth.userId,
      scope: "conversation",
      subjectId: conversationId,
      content: "In this thread the user chose the blue variant.",
    });

    // A brand-new conversation must not inherit it.
    const other = await chat("Which variant did I choose?");
    expect(other.statusCode).toBe(200);
    const prompt = provider.seen.at(-1)!;
    expect(prompt.some((m) => m.role === "system" && m.content.includes("blue variant"))).toBe(false);
  });
});
