import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatStreamEvent, LLMProvider, ProviderCapabilities } from "@ai-platform/shared";
import { ModelRegistry } from "./registry.js";
import { ModelRouter, classifyProviderError, type ProviderCallOutcome, type ProviderFallback } from "./router.js";

/**
 * Real fake providers (not mocks of ModelRouter itself) exercising the actual fallback
 * state machine documented in router.ts's own header comment and docs/12_MODEL_ROUTING.md —
 * closes a real gap found by an independent Phase 15 audit: this router's fallback
 * behavior had only ever been verified manually against live provider endpoints (Phase 2),
 * never locked in as an automated regression test.
 */
class ScriptedProvider implements LLMProvider {
  // Not a mock: the router now deprioritises mocks behind every real provider (ADR-058), so
  // a chain built entirely from `isMock: true` doubles would not exercise the real ordering.
  readonly isMock = false;
  readonly model = "scripted-1";
  calls = 0;

  constructor(
    readonly name: string,
    private readonly events: ChatStreamEvent[] | (() => never)
  ) {}

  /** Declared capabilities — the router filters candidates on these before ordering them. */
  capabilities(): ProviderCapabilities {
    return { streaming: true, toolCalling: true, structuredOutput: false, vision: false, contextWindow: null };
  }

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
  finishReason: "stop",
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
      isMock: false,
      model: "primary-1",
      capabilities: () => ({
        streaming: true,
        toolCalling: true,
        structuredOutput: false,
        vision: false,
        contextWindow: null,
      }),
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
/**
 * A mock is a last resort, never a substitute — docs/26_DECISIONS.md ADR-163.
 *
 * Found by running the platform, not by reading it. A chat turn whose local model call aborted
 * came back as "[mock response — no real model produced this] ..." with HTTP 200 and a usage
 * row, and the only way to discover that the real model had failed was the server log.
 *
 * `SelectionCriteria.excludeMocks` had been implemented in the registry since it was written
 * and passed by nobody. These tests assert the behaviour rather than the flag, so a future
 * rewrite that drops the flag but keeps the behaviour still passes.
 */
class FakeMock implements LLMProvider {
  readonly isMock = true;
  readonly model = "mock-1";
  calls = 0;
  constructor(readonly name: string) {}
  capabilities(): ProviderCapabilities {
    return { streaming: true, toolCalling: true, structuredOutput: false, vision: false, contextWindow: null };
  }
  async *streamChat(): AsyncGenerator<ChatStreamEvent, void, unknown> {
    this.calls++;
    yield doneEvent(this.name);
  }
}

describe("a mock is never what a real provider falls back to", () => {
  it("fails the call instead of answering from the mock", async () => {
    const broken = new ScriptedProvider("local", () => {
      throw new Error("Could not reach the local model runtime: This operation was aborted");
    });
    const mock = new FakeMock("mock");
    const registry = new ModelRegistry();
    registry.register(broken, { asDefault: true });
    registry.register(mock);

    const events: ChatStreamEvent[] = [];
    await expect(async () => {
      for await (const e of new ModelRouter(registry).streamChat(request)) events.push(e);
    }).rejects.toThrow();

    // The load-bearing assertion: the caller got an error, not invented text.
    expect(mock.calls).toBe(0);
    expect(events.find((e) => e.type === "done")).toBeUndefined();
  });

  it("still falls back between two REAL providers", async () => {
    // The control. A change that simply stopped falling back would satisfy the test above.
    const broken = new ScriptedProvider("first", () => {
      throw new Error("down");
    });
    const healthy = new ScriptedProvider("second", [doneEvent("second")]);
    const registry = new ModelRegistry();
    registry.register(broken, { asDefault: true });
    registry.register(healthy);

    const events: ChatStreamEvent[] = [];
    for await (const e of new ModelRouter(registry).streamChat(request)) events.push(e);
    expect(events.find((e) => e.type === "done")?.provider).toBe("second");
    expect(healthy.calls).toBe(1);
  });

  it("uses the mock when it is the ONLY provider — the zero-configuration local loop", async () => {
    // The other control, and the reason the mock exists at all. A machine with no credentials
    // and no local runtime must still be able to run the product end to end.
    const mock = new FakeMock("mock");
    const registry = new ModelRegistry();
    registry.register(mock, { asDefault: true });

    const events: ChatStreamEvent[] = [];
    for await (const e of new ModelRouter(registry).streamChat(request)) events.push(e);
    expect(events.find((e) => e.type === "done")?.provider).toBe("mock");
    expect(mock.calls).toBe(1);
  });

  it("does not consult the mock even when the real provider is merely unsuitable", async () => {
    // A tools request against a real provider that cannot call tools: the mock CAN, so before
    // this change the selection would have handed the whole turn to it.
    class NoTools extends ScriptedProvider {
      capabilities(): ProviderCapabilities {
        return { streaming: true, toolCalling: false, structuredOutput: false, vision: false, contextWindow: null };
      }
    }
    const real = new NoTools("local", [doneEvent("local")]);
    const mock = new FakeMock("mock");
    const registry = new ModelRegistry();
    registry.register(real, { asDefault: true });
    registry.register(mock);

    const toolRequest: ChatRequest = {
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "t", description: "d", inputSchema: { type: "object", properties: {} } }],
    };
    await expect(async () => {
      for await (const _ of new ModelRouter(registry).streamChat(toolRequest)) {
        /* drain */
      }
    }).rejects.toThrow(/No configured model provider/);
    expect(mock.calls).toBe(0);
  });
});

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

/**
 * ADR-094 — an empty model turn is transient, not fatal.
 *
 * A local runtime occasionally returns a turn with no content and no tool calls. The adapters
 * refuse to pass that off as an empty success (ADR-045), and the router used to treat the refusal
 * as fatal and fail over — which on an agent request meant handing tool-requiring work to the
 * mock, whose scripted reply entered the transcript and burned an iteration. The identical
 * request, retried, produces a real tool call.
 */
describe("classifyProviderError — empty responses (ADR-094)", () => {
  it("retries the same provider for an empty turn rather than failing over", () => {
    for (const message of [
      "Local model runtime returned no content (finish reason: stop).",
      "Local model runtime returned an empty stream.",
      "produced no events",
    ]) {
      expect(classifyProviderError(new Error(message))).toBe("retryable");
    }
  });

  it("still fails over for errors that will not fix themselves", () => {
    // The distinction that matters: a bad key or malformed tool arguments are not transient, and
    // retrying them just burns the budget before failing anyway.
    expect(classifyProviderError(new Error("Request failed (401): invalid api key"))).toBe("fatal");
    expect(classifyProviderError(new Error('Model returned unparseable arguments for tool "x"'))).toBe("fatal");
    expect(classifyProviderError(new Error("Request failed (404): no such model"))).toBe("fatal");
  });
});

/**
 * Abandoning the stream closes the provider's — docs/26_DECISIONS.md ADR-119.
 *
 * The chat route's `for await` ends when the browser disconnects, and a cancelled agent node does
 * the same. Before this, the provider's generator kept running: its `finally`, which aborts the
 * upstream request, was never reached, so a provider went on generating — and billing — into a
 * stream nobody was reading.
 */
describe("router cancellation", () => {
  it("closes the provider's iterator when the consumer stops reading", async () => {
    let closed = false;
    let yielded = 0;
    const provider = {
      name: "endless",
      isMock: false,
      model: "endless-1",
      capabilities: (): ProviderCapabilities => ({
        streaming: true,
        toolCalling: false,
        structuredOutput: false,
        vision: false,
        contextWindow: null,
      }),
      async *streamChat() {
        try {
          for (;;) {
            yielded++;
            yield { type: "token", delta: "x" } as const;
            await new Promise((r) => setTimeout(r, 1));
          }
        } finally {
          // What the provider adapters use to abort their HTTP request.
          closed = true;
        }
      },
    };
    const registry = new ModelRegistry();
    registry.register(provider as never, { asDefault: true });
    const router = new ModelRouter(registry);

    // Read two events, then abandon the stream exactly as a disconnected client does.
    const stream = router.streamChat({ messages: [{ role: "user", content: "hello" }] });
    let received = 0;
    for await (const event of stream) {
      if (event.type === "token") received++;
      if (received === 2) break;
    }

    expect(received).toBe(2);
    expect(closed).toBe(true);
    const afterBreak = yielded;
    await new Promise((r) => setTimeout(r, 50));
    // And it really stopped: no further work after the consumer walked away.
    expect(yielded).toBe(afterBreak);
  });
});
/**
 * Every model call is counted, not only chat that worked — docs/26_DECISIONS.md ADR-132.
 *
 * `provider_request_count` and `provider_tokens_total` were written in exactly one place: the chat
 * route's success branch, below a `continue` that skips every event but the terminal `done`. So a
 * failed chat, summarisation, RAG and every agent step were invisible, and a dashboard built on
 * those counters showed a provider at 100% success during an outage — the failures were never
 * counted at all. Reporting from the router covers every caller, because the router is the one
 * thing they all go through.
 */
describe("provider call reporting (ADR-132)", () => {
  const routerFor = (provider: ScriptedProvider, calls: ProviderCallOutcome[]) => {
    const registry = new ModelRegistry();
    registry.register(provider);
    return new ModelRouter(registry, {
      onCall: (c) => calls.push(c),
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });
  };


  it("labels the outcome with the model the provider actually used", async () => {
    /**
     * docs/26_DECISIONS.md ADR-155. Every outcome was reported with `provider.model` — the
     * adapter's constructor-time default. The adapters honour a per-request override
     * (`request.model ?? this.model`) and `chatRequestSchema` makes `model` a caller-supplied
     * field the chat route forwards unchanged, so a deployment whose callers name a model saw
     * every token, cost and latency bucket filed under the default instead, and the metric and
     * the usage ledger disagreed by construction.
     */
    const calls: ProviderCallOutcome[] = [];
    const provider = new ScriptedProvider("good", [
      { type: "token", delta: "hi" },
      { ...doneEvent("good"), model: "qwen2.5:14b" } as ChatStreamEvent,
    ]);
    // The provider's own default is something else entirely.
    expect(provider.model).toBe("scripted-1");

    for await (const _event of routerFor(provider, calls).streamChat(request)) void _event;

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: "good", model: "qwen2.5:14b", status: "success" });
  });

  it("falls back to the configured model when the stream never reports one", async () => {
    // A `done` event with no model, and the error path before any event, can only know the
    // default — reporting an empty label would be worse than reporting the configured one.
    const calls: ProviderCallOutcome[] = [];
    const provider = new ScriptedProvider("good", [
      { ...doneEvent("good"), model: "" } as ChatStreamEvent,
    ]);
    for await (const _event of routerFor(provider, calls).streamChat(request)) void _event;
    expect(calls[0]).toMatchObject({ model: "scripted-1" });
  });

  it("reports a successful call with its token usage", async () => {
    const calls: ProviderCallOutcome[] = [];
    const provider = new ScriptedProvider("good", [{ type: "token", delta: "hi" }, doneEvent("good")]);
    for await (const _event of routerFor(provider, calls).streamChat(request)) void _event;

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: "good", status: "success", inputTokens: 1, outputTokens: 1 });
    expect(calls[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a FAILED call, which is the case that was never counted", async () => {
    const calls: ProviderCallOutcome[] = [];
    const provider = new ScriptedProvider("bad", () => {
      throw new Error("upstream exploded");
    });
    await expect(
      (async () => {
        for await (const _event of routerFor(provider, calls).streamChat(request)) void _event;
      })()
    ).rejects.toThrow();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: "bad", status: "error" });
    // A bounded label, never a message: an unbounded one ruins the metric it feeds.
    expect(["retryable", "fatal"]).toContain(calls[0]!.errorType);
  });

  it("does not count an abandoned stream as a failure", async () => {
    // A user who closes the tab is not a provider outage, and counting it as one would make the
    // error rate track user behaviour instead of provider health.
    const calls: ProviderCallOutcome[] = [];
    const provider = new ScriptedProvider("good", [
      { type: "token", delta: "one" },
      { type: "token", delta: "two" },
      doneEvent("good"),
    ]);
    const stream = routerFor(provider, calls).streamChat(request);
    await stream.next();
    await stream.return(undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe("cancelled");
  });
});

describe("commit reporting (DL-18)", () => {
  const provider = (name: string, events: ChatStreamEvent[]): LLMProvider => ({
    name,
    isMock: false,
    model: `${name}-model`,
    capabilities: (): ProviderCapabilities => ({ streaming: true, toolCalling: false, structuredOutput: false, vision: false, contextWindow: null }),
    async *streamChat() {
      for (const event of events) yield event;
    },
  });
  const done = (name: string): ChatStreamEvent => ({
    type: "done",
    message: { role: "assistant", content: "hi" },
    usage: { inputTokens: 1, outputTokens: 1 },
    provider: name,
    model: `${name}-model`,
    finishReason: "stop",
  });

  it("reports the provider that answered, never one whose first event was an error and was failed over", async () => {
    const registry = new ModelRegistry();
    registry.register(provider("broken", [{ type: "error", message: "upstream said no" }]), { asDefault: true });
    registry.register(provider("working", [{ type: "token", delta: "hi" }, done("working")]));
    const commits: string[] = [];
    const events: ChatStreamEvent[] = [];
    for await (const event of new ModelRouter(registry).streamChat(
      { messages: [{ role: "user", content: "hello" }] },
      { onCommit: (c) => commits.push(c.provider) }
    )) {
      events.push(event);
    }
    expect(commits).toEqual(["working"]);
    expect(events.at(-1)).toMatchObject({ type: "done", provider: "working" });
  });

  it("reports nothing for a named provider whose only event is an error", async () => {
    const registry = new ModelRegistry();
    registry.register(provider("broken", [{ type: "error", message: "upstream said no" }]), { asDefault: true });
    const commits: string[] = [];
    for await (const _event of new ModelRouter(registry).streamChat(
      { messages: [{ role: "user", content: "hello" }], provider: "broken" },
      { onCommit: (c) => commits.push(c.provider) }
    )) {
      // draining
    }
    expect(commits).toEqual([]);
  });
});
