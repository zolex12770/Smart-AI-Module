import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatStreamEvent, LLMProvider } from "@ai-platform/shared";
import { ModelRegistry } from "./registry.js";
import { ModelRouter, type ProviderFallback } from "./router.js";

/**
 * Real fake providers (not mocks of ModelRouter itself) exercising the actual fallback
 * state machine documented in router.ts's own header comment and docs/12_MODEL_ROUTING.md —
 * closes a real gap found by an independent Phase 15 audit: this router's fallback
 * behavior had only ever been verified manually against live provider endpoints (Phase 2),
 * never locked in as an automated regression test.
 */
class ScriptedProvider implements LLMProvider {
  readonly isMock = true;
  calls = 0;

  constructor(
    readonly name: string,
    private readonly events: ChatStreamEvent[] | (() => never)
  ) {}

  async *streamChat(_request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    this.calls++;
    if (typeof this.events === "function") this.events();
    for (const event of this.events as ChatStreamEvent[]) yield event;
  }
}

const doneEvent = (provider: string): ChatStreamEvent => ({
  type: "done",
  message: { role: "assistant", content: "hi" },
  usage: { inputTokens: 1, outputTokens: 1 },
  provider,
  model: "test-model",
});

const request: ChatRequest = { messages: [{ role: "user", content: "hello" }] };

describe("ModelRouter (real fallback state machine)", () => {
  it("routes to an explicitly-requested provider with no fallback substitution, even on failure", async () => {
    const failing = new ScriptedProvider("explicit", () => {
      throw new Error("explicit provider is down");
    });
    const other = new ScriptedProvider("other", [doneEvent("other")]);
    const registry = new ModelRegistry();
    registry.register(failing);
    registry.register(other);
    const router = new ModelRouter(registry);

    await expect(async () => {
      for await (const _ of router.streamChat({ ...request, provider: "explicit" })) {
        // drain
      }
    }).rejects.toThrow("explicit provider is down");
    expect(other.calls).toBe(0); // never silently substituted
  });

  it("falls back to the next provider when the default fails before its first event", async () => {
    const primary = new ScriptedProvider("primary", () => {
      throw new Error("primary down");
    });
    const fallback = new ScriptedProvider("fallback", [{ type: "token", delta: "hi" }, doneEvent("fallback")]);
    const registry = new ModelRegistry();
    registry.register(primary, { asDefault: true });
    registry.register(fallback);
    const router = new ModelRouter(registry);

    const events: ChatStreamEvent[] = [];
    for await (const event of router.streamChat(request)) events.push(event);

    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "done", provider: "fallback" });
  });

  it("falls back when the default yields a real 'error' event as its first event", async () => {
    const primary = new ScriptedProvider("primary", [{ type: "error", message: "quota exceeded" }]);
    const fallback = new ScriptedProvider("fallback", [doneEvent("fallback")]);
    const registry = new ModelRegistry();
    registry.register(primary, { asDefault: true });
    registry.register(fallback);
    const router = new ModelRouter(registry);

    const events: ChatStreamEvent[] = [];
    for await (const event of router.streamChat(request)) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "done", provider: "fallback" });
  });

  it("does NOT fall back mid-stream once a provider has yielded its first real event", async () => {
    // ScriptedProvider's constructor only models "throw before any yield" or "a fixed
    // event list" — a mid-stream throw needs a real generator, so this one is inline.
    const midStreamFailing: LLMProvider = {
      name: "primary",
      isMock: true,
      async *streamChat() {
        yield { type: "token", delta: "partial" };
        throw new Error("primary crashed mid-stream");
      },
    };
    const fallback = new ScriptedProvider("fallback", [doneEvent("fallback")]);
    const registry = new ModelRegistry();
    registry.register(midStreamFailing, { asDefault: true });
    registry.register(fallback);
    const router = new ModelRouter(registry);

    const events: ChatStreamEvent[] = [];
    for await (const event of router.streamChat(request)) events.push(event);

    expect(events[0]).toEqual({ type: "token", delta: "partial" });
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(fallback.calls).toBe(0); // never silently retried after real output started
  });

  it("throws once every provider in the fallback chain has failed", async () => {
    const first = new ScriptedProvider("first", () => {
      throw new Error("first down");
    });
    const second = new ScriptedProvider("second", () => {
      throw new Error("second down");
    });
    const registry = new ModelRegistry();
    registry.register(first, { asDefault: true });
    registry.register(second);
    const router = new ModelRouter(registry);

    await expect(async () => {
      for await (const _ of router.streamChat(request)) {
        // drain
      }
    }).rejects.toThrow(/down|failed to respond/);
  });
});

/**
 * docs/26_DECISIONS.md ADR-044. A fallback used to be reported only as a `console.warn`, so
 * the single structured record of a request that a real provider had failed said
 * `provider: "mock", status: "success"`. These lock in that every skipped provider is
 * handed to the caller, which is what makes a failed real call visible in the JSON logs.
 */
describe("ModelRouter fallback reporting", () => {
  it("hands each skipped provider to a per-call onFallback hook, naming the failure stage", async () => {
    const throwing = new ScriptedProvider("throwing", () => {
      throw new Error("connection refused");
    });
    const erroring = new ScriptedProvider("erroring", [{ type: "error", message: "quota exhausted" }]);
    const good = new ScriptedProvider("good", [doneEvent("good")]);
    const registry = new ModelRegistry();
    registry.register(throwing, { asDefault: true });
    registry.register(erroring);
    registry.register(good);
    const router = new ModelRouter(registry);

    const seen: ProviderFallback[] = [];
    const events: ChatStreamEvent[] = [];
    for await (const event of router.streamChat(request, { onFallback: (f) => seen.push(f) })) events.push(event);

    expect(events.at(-1)).toMatchObject({ type: "done", provider: "good" });
    expect(seen.map((f) => [f.provider, f.stage, f.message])).toEqual([
      ["throwing", "no_first_event", "connection refused"],
      ["erroring", "error_event", "quota exhausted"],
    ]);
  });

  it("falls back to the instance-wide hook when a call supplies none, and reports nothing on a clean call", async () => {
    const failing = new ScriptedProvider("failing", () => {
      throw new Error("down");
    });
    const good = new ScriptedProvider("good", [doneEvent("good")]);
    const registry = new ModelRegistry();
    registry.register(failing, { asDefault: true });
    registry.register(good);

    const seen: ProviderFallback[] = [];
    const router = new ModelRouter(registry, { onFallback: (f) => seen.push(f) });
    for await (const _ of router.streamChat(request)) { /* drain */ }
    expect(seen.map((f) => f.provider)).toEqual(["failing"]);

    seen.length = 0;
    const cleanRegistry = new ModelRegistry();
    cleanRegistry.register(good, { asDefault: true });
    const cleanRouter = new ModelRouter(cleanRegistry, { onFallback: (f) => seen.push(f) });
    for await (const _ of cleanRouter.streamChat(request)) { /* drain */ }
    expect(seen).toEqual([]);
  });
});
