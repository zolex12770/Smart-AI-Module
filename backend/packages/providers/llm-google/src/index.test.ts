import { describe, expect, it, vi } from "vitest";
import { stringToStream } from "@ai-platform/shared";
import { GoogleProvider } from "./index.js";

/**
 * Fixture matches the documented chunk shape from docs/04_MODEL_PROVIDER_RESEARCH.md
 * §3.4: repeated full GenerateContentResponse objects, no typed micro-events, final
 * chunk carries finishReason and usageMetadata. Not a captured real payload — see the
 * honest verification-status note in src/index.ts.
 */
const FIXTURE_SSE = [
  `data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n`,
  `data: {"candidates":[{"content":{"parts":[{"text":", world!"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":4}}\n\n`,
].join("");

/**
 * A tool-calling turn in Gemini's idiom (docs/04 §3.3): the call is a `functionCall` PART
 * inside the candidate's content, not a separate field, and it arrives whole rather than
 * fragmented. Note `finishReason: "STOP"` — Gemini does not distinguish a tool turn, so the
 * part itself has to be the signal.
 */
const FUNCTION_CALL_SSE = [
  `data: {"candidates":[{"content":{"parts":[{"text":"Checking."}]}}]}\n\n`,
  `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"location":"Paris"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":8}}\n\n`,
].join("");

const WEATHER_TOOL = {
  name: "get_weather",
  description: "Get current weather for a location",
  inputSchema: {
    type: "object",
    properties: { location: { type: "string" } },
    required: ["location"],
  },
};

const streamOf = (sse: string): typeof fetch =>
  vi.fn(async () => new Response(stringToStream(sse), { status: 200 })) as unknown as typeof fetch;

describe("GoogleProvider", () => {
  it("streams tokens and a final done event parsed from a realistic generateContent fixture", async () => {
    const fetchImpl = streamOf(FIXTURE_SSE);
    const provider = new GoogleProvider({ apiKey: "test-key", fetchImpl });

    const events = [];
    for await (const event of provider.streamChat({ messages: [{ role: "user", content: "hi" }] })) {
      events.push(event);
    }

    expect(events.filter((e) => e.type === "token").map((e: any) => e.delta)).toEqual(["Hello", ", world!"]);
    const done = events.find((e) => e.type === "done") as any;
    expect(done.message.content).toBe("Hello, world!");
    expect(done.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(done.provider).toBe("google");
    expect(done.finishReason).toBe("stop");
    expect(done.message.toolCalls).toBeUndefined();
  });

  it("reports its model and honest capabilities so the router can select on them", () => {
    const provider = new GoogleProvider({ apiKey: "test-key", fetchImpl: streamOf(FIXTURE_SSE) });
    expect(provider.model).toBe("gemini-3.5-flash");
    expect(provider.capabilities()).toEqual({
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: true,
      contextWindow: 1_000_000,
    });
    const unknown = new GoogleProvider({
      apiKey: "test-key",
      model: "gemini-99-unreleased",
      fetchImpl: streamOf(FIXTURE_SSE),
    });
    // An unknown model reports null rather than a guessed window.
    expect(unknown.capabilities().contextWindow).toBeNull();
  });

  it("maps assistant -> model role and extracts system messages into systemInstruction", async () => {
    const fetchImpl = streamOf(FIXTURE_SSE);
    const provider = new GoogleProvider({ apiKey: "test-key", fetchImpl });

    for await (const _ of provider.streamChat({
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok" },
      ],
    })) {
      // drain
    }

    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toContain(":streamGenerateContent?alt=sse");
    expect(init.headers["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "Be terse." }] });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "ok" }] },
    ]);
    expect(body.tools).toBeUndefined();
  });

  it("throws a ProviderError on a non-OK HTTP response", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
    const provider = new GoogleProvider({ apiKey: "test-key", fetchImpl });

    await expect(async () => {
      for await (const _ of provider.streamChat({ messages: [{ role: "user", content: "hi" }] })) {
        // drain
      }
    }).rejects.toThrow(/Google Gemini API request failed \(400\)/);
  });
});

/** docs/26_DECISIONS.md ADR-047 — real tool calling, in Gemini's functionCall part idiom. */
describe("GoogleProvider tool calling", () => {
  it("sends tools as a single functionDeclarations group with a toolConfig mode", async () => {
    const fetchImpl = streamOf(FUNCTION_CALL_SSE);
    const provider = new GoogleProvider({ apiKey: "test-key", fetchImpl });

    for await (const _ of provider.streamChat({
      messages: [{ role: "user", content: "weather in Paris?" }],
      tools: [WEATHER_TOOL],
      toolChoice: "required",
      maxOutputTokens: 512,
    })) {
      // drain
    }

    const [, init] = (fetchImpl as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Get current weather for a location",
            parameters: WEATHER_TOOL.inputSchema,
          },
        ],
      },
    ]);
    // Gemini spells "you must call some tool" as mode ANY.
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 512 });
  });

  it("maps a JSON response format onto responseMimeType", async () => {
    const fetchImpl = streamOf(FIXTURE_SSE);
    const provider = new GoogleProvider({ apiKey: "test-key", fetchImpl });
    for await (const _ of provider.streamChat({ messages: [{ role: "user", content: "hi" }], responseFormat: "json_object" })) {
      // drain
    }
    const body = JSON.parse((fetchImpl as any).mock.calls[0][1].body);
    expect(body.generationConfig).toEqual({ responseMimeType: "application/json" });
  });

  it("parses a functionCall part into a tool call and reports finishReason tool_calls", async () => {
    const provider = new GoogleProvider({ apiKey: "test-key", fetchImpl: streamOf(FUNCTION_CALL_SSE) });

    const events = [];
    for await (const event of provider.streamChat({
      messages: [{ role: "user", content: "weather in Paris?" }],
      tools: [WEATHER_TOOL],
    })) {
      events.push(event);
    }

    const toolCallEvents = events.filter((e) => e.type === "tool_call") as any[];
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0].call).toEqual({
      // `generateContent` has no per-call id, so position in the turn is the correlation key.
      id: "gemini-call-1",
      name: "get_weather",
      arguments: { location: "Paris" },
    });

    const done = events.find((e) => e.type === "done") as any;
    expect(done.message.content).toBe("Checking.");
    expect(done.message.toolCalls).toEqual([toolCallEvents[0].call]);
    // Gemini reported STOP; the functionCall part is what makes this a tool turn.
    expect(done.finishReason).toBe("tool_calls");
    expect(done.usage).toEqual({ inputTokens: 20, outputTokens: 8 });
  });

  it("maps an assistant tool turn to functionCall parts and our tool role to functionResponse", async () => {
    const fetchImpl = streamOf(FIXTURE_SSE);
    const provider = new GoogleProvider({ apiKey: "test-key", fetchImpl });

    for await (const _ of provider.streamChat({
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: "Checking.",
          toolCalls: [{ id: "gemini-call-1", name: "get_weather", arguments: { location: "Paris" } }],
        },
        { role: "tool", content: `{"tempC":18}`, toolCallId: "gemini-call-1", name: "get_weather" },
        { role: "tool", content: "not json at all", toolCallId: "gemini-call-2", name: "get_notes" },
      ],
      tools: [WEATHER_TOOL],
    })) {
      // drain
    }

    const [, init] = (fetchImpl as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "weather in Paris?" }] },
      {
        role: "model",
        parts: [{ text: "Checking." }, { functionCall: { name: "get_weather", args: { location: "Paris" } } }],
      },
      // Gemini's contents accept only user/model roles; a result is a functionResponse part
      // on a user turn, keyed by the function's NAME (classic generateContent has no ids).
      // A structured result passes through; plain text is wrapped, since `response` must be
      // a JSON object.
      { role: "user", parts: [{ functionResponse: { name: "get_weather", response: { tempC: 18 } } }] },
      { role: "user", parts: [{ functionResponse: { name: "get_notes", response: { output: "not json at all" } } }] },
    ]);
  });
});

/**
 * docs/26_DECISIONS.md ADR-045 — the failure modes a real first call can hit that all used to
 * end as a successful-looking empty answer attributed to google.
 */
describe("GoogleProvider failure modes that must not look like success", () => {
  const run = async (sse: string) => {
    const fetchImpl = streamOf(sse);
    const provider = new GoogleProvider({ apiKey: "test-key", fetchImpl });
    const events = [];
    for await (const event of provider.streamChat({ messages: [{ role: "user", content: "hi" }] })) events.push(event);
    return events;
  };

  it("counts thinking tokens as output — they are billed as output but reported separately", async () => {
    const events = await run(
      `data: {"candidates":[{"content":{"parts":[{"text":"42"}]}}],"usageMetadata":{"promptTokenCount":30,"candidatesTokenCount":180,"thoughtsTokenCount":1400}}\n\n`
    );
    const done = events.find((e) => e.type === "done") as any;
    expect(done.usage).toEqual({ inputTokens: 30, outputTokens: 1580 });
    // No finishReason in the stream is reported as unknown, never as a fabricated clean stop.
    expect(done.finishReason).toBe("unknown");
  });

  it("throws, naming the safety filter, instead of yielding an empty successful answer", async () => {
    await expect(run(`data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n`)).rejects.toThrow(
      /blocked by a safety filter.*SAFETY.*finish reason: content_filter/
    );
  });

  it("throws, naming the finish reason, when the model stopped before emitting text", async () => {
    await expect(
      run(`data: {"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[]}}]}\n\n`)
    ).rejects.toThrow(/stopped early.*MAX_TOKENS.*finish reason: length/);
  });

  it("throws, naming the unreadable frames, rather than reporting an empty success", async () => {
    await expect(run(`data: {not json\n\n`)).rejects.toThrow(/1 stream frame\(s\) could not be parsed/);
  });

  it("parses a CRLF-framed stream — the wire form that used to produce zero tokens", async () => {
    const events = await run(
      `data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\r\n\r\ndata: {"candidates":[{"content":{"parts":[{"text":"!"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\r\n\r\n`
    );
    expect(events.filter((e) => e.type === "token").map((e: any) => e.delta)).toEqual(["Hello", "!"]);
    const done = events.find((e) => e.type === "done") as any;
    expect(done.message.content).toBe("Hello!");
    expect(done.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });
});

/**
 * A deadline and a cancellation the HTTP call obeys — audit finding 19. The request had no signal
 * at all: a stalled connection hung its caller forever, and a cancelled chat left the provider
 * streaming (and billing) tokens nobody read.
 */
describe("deadline and cancellation", () => {
  const FIRST_FRAME = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hel\"}]}}]}\n\n";
  /** A response that sends one frame, then nothing, and ends only when the request is aborted. */
  const stallingFetch = (seen: { signal?: AbortSignal }) =>
    (async (_url: unknown, init?: RequestInit) => {
      seen.signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(FIRST_FRAME));
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

  it("gives up at the deadline with a timeout the router retries", async () => {
    const seen: { signal?: AbortSignal } = {};
    const provider = new GoogleProvider({ apiKey: "test-key", fetchImpl: stallingFetch(seen), requestTimeoutMs: 100 });
    const started = Date.now();
    await expect(
      (async () => {
        for await (const _event of provider.streamChat({ messages: [{ role: "user", content: "hi" }] })) {
          // draining
        }
      })()
    ).rejects.toThrow(/did not complete within .*timeout/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen.signal?.aborted).toBe(true);
  });

  it("aborts the HTTP request when the consumer stops reading", async () => {
    const seen: { signal?: AbortSignal } = {};
    const provider = new GoogleProvider({ apiKey: "test-key", fetchImpl: stallingFetch(seen) });
    const stream = provider.streamChat({ messages: [{ role: "user", content: "hi" }] });
    const first = await stream.next();
    expect(first.value).toMatchObject({ type: "token" });
    await stream.return(undefined);
    expect(seen.signal?.aborted).toBe(true);
  });
});
