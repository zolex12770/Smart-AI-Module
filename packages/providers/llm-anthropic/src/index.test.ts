import { describe, expect, it, vi } from "vitest";
import { stringToStream } from "@ai-platform/shared";
import { AnthropicProvider } from "./index.js";

/**
 * Fixture matches the documented SSE shape from docs/04_MODEL_PROVIDER_RESEARCH.md §1.3:
 * message_start -> content_block_start -> content_block_delta(s) -> content_block_stop
 * -> message_delta -> message_stop. This validates our parsing logic against a realistic
 * payload shape, NOT against the live API (no real key exists in this environment — see
 * the honest verification-status note in src/index.ts).
 */
const FIXTURE_SSE = [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-5","usage":{"input_tokens":12}}}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", world!"}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
].join("");

/**
 * A tool-use turn in the same documented shape (§1.2-1.3): a text block, then a `tool_use`
 * block whose arguments arrive as chunked `input_json_delta` fragments — the detail that
 * makes reassembly necessary rather than optional — closed by `stop_reason: "tool_use"`.
 */
const TOOL_USE_SSE = [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_02","model":"claude-sonnet-5","usage":{"input_tokens":31}}}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking."}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"get_weather","input":{}}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"loca"}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"tion\\":\\"Paris\\"}"}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":18}}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
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

function mockFetch(status: number, body: string): typeof fetch {
  return vi.fn(async () =>
    new Response(status === 200 ? stringToStream(body) : null, { status })
  ) as unknown as typeof fetch;
}

describe("AnthropicProvider", () => {
  it("streams tokens and a final done event parsed from a realistic SSE fixture", async () => {
    const fetchImpl = mockFetch(200, FIXTURE_SSE);
    const provider = new AnthropicProvider({ apiKey: "sk-ant-test", fetchImpl });

    const events = [];
    for await (const event of provider.streamChat({ messages: [{ role: "user", content: "hi" }] })) {
      events.push(event);
    }

    expect(events.filter((e) => e.type === "token").map((e: any) => e.delta)).toEqual(["Hello", ", world!"]);
    const done = events.find((e) => e.type === "done") as any;
    expect(done).toBeDefined();
    expect(done.message.content).toBe("Hello, world!");
    expect(done.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(done.model).toBe("claude-sonnet-5");
    expect(done.provider).toBe("anthropic");
    // "end_turn" is Anthropic's spelling of a clean stop.
    expect(done.finishReason).toBe("stop");
    expect(done.message.toolCalls).toBeUndefined();
  });

  it("reports its model and honest capabilities so the router can select on them", () => {
    const provider = new AnthropicProvider({ apiKey: "sk-ant-test", fetchImpl: mockFetch(200, FIXTURE_SSE) });
    expect(provider.model).toBe("claude-sonnet-5");
    expect(provider.capabilities()).toEqual({
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: true,
      contextWindow: 1_000_000,
    });
    // An unknown model reports null rather than a guessed window.
    const unknown = new AnthropicProvider({
      apiKey: "sk-ant-test",
      model: "claude-something-unreleased",
      fetchImpl: mockFetch(200, FIXTURE_SSE),
    });
    expect(unknown.capabilities().contextWindow).toBeNull();
  });

  it("sends the system message separately from the messages array, per Anthropic's API shape", async () => {
    const fetchImpl = vi.fn(async () => new Response(stringToStream(FIXTURE_SSE), { status: 200 })) as unknown as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: "sk-ant-test", fetchImpl });

    const events = [];
    for await (const event of provider.streamChat({
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "hi" },
      ],
    })) {
      events.push(event);
    }

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = (fetchImpl as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.system).toBe("You are terse.");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.tools).toBeUndefined();
  });

  it("throws a ProviderError on a non-OK HTTP response, without leaking the raw body verbatim if huge", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: "bad-key", fetchImpl });

    await expect(async () => {
      for await (const _ of provider.streamChat({ messages: [{ role: "user", content: "hi" }] })) {
        // drain
      }
    }).rejects.toThrow(/Anthropic API request failed \(401\)/);
  });
});

/** docs/26_DECISIONS.md ADR-047 — real tool calling, in Anthropic's own request/response idiom. */
describe("AnthropicProvider tool calling", () => {
  it("sends tools as {name, description, input_schema} with a mapped tool_choice", async () => {
    const fetchImpl = vi.fn(async () => new Response(stringToStream(TOOL_USE_SSE), { status: 200 })) as unknown as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: "sk-ant-test", fetchImpl });

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
        name: "get_weather",
        description: "Get current weather for a location",
        input_schema: WEATHER_TOOL.inputSchema,
      },
    ]);
    // Anthropic spells "you must call some tool" as `any`, not `required`.
    expect(body.tool_choice).toEqual({ type: "any" });
    expect(body.max_tokens).toBe(512);
    // `strict` is deliberately absent — see the comment on the request builder.
    expect(body.tools[0].strict).toBeUndefined();
  });

  it("reassembles a tool_use block streamed as chunked input_json_delta fragments", async () => {
    const fetchImpl = vi.fn(async () => new Response(stringToStream(TOOL_USE_SSE), { status: 200 })) as unknown as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: "sk-ant-test", fetchImpl });

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
      id: "toolu_01",
      name: "get_weather",
      arguments: { location: "Paris" },
    });

    const done = events.find((e) => e.type === "done") as any;
    expect(done.message.content).toBe("Checking.");
    expect(done.message.toolCalls).toEqual([toolCallEvents[0].call]);
    expect(done.finishReason).toBe("tool_calls");
    expect(done.usage).toEqual({ inputTokens: 31, outputTokens: 18 });
  });

  it("maps our tool role back to tool_result blocks, batched into one user message", async () => {
    const fetchImpl = vi.fn(async () => new Response(stringToStream(FIXTURE_SSE), { status: 200 })) as unknown as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: "sk-ant-test", fetchImpl });

    for await (const _ of provider.streamChat({
      messages: [
        { role: "user", content: "weather in Paris and Rome?" },
        {
          role: "assistant",
          content: "Checking.",
          toolCalls: [
            { id: "toolu_01", name: "get_weather", arguments: { location: "Paris" } },
            { id: "toolu_02", name: "get_weather", arguments: { location: "Rome" } },
          ],
        },
        { role: "tool", content: "18C", toolCallId: "toolu_01", name: "get_weather" },
        { role: "tool", content: "24C", toolCallId: "toolu_02", name: "get_weather" },
      ],
      tools: [WEATHER_TOOL],
    })) {
      // drain
    }

    const [, init] = (fetchImpl as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages).toEqual([
      { role: "user", content: "weather in Paris and Rome?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_01", name: "get_weather", input: { location: "Paris" } },
          { type: "tool_use", id: "toolu_02", name: "get_weather", input: { location: "Rome" } },
        ],
      },
      // docs/04 §1.2 — both results in ONE user message; splitting them degrades parallel
      // tool use.
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_01", content: "18C" },
          { type: "tool_result", tool_use_id: "toolu_02", content: "24C" },
        ],
      },
    ]);
  });

  it("refuses a tool result with no toolCallId rather than building a request Anthropic will reject", async () => {
    const fetchImpl = vi.fn(async () => new Response(stringToStream(FIXTURE_SSE), { status: 200 })) as unknown as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: "sk-ant-test", fetchImpl });

    await expect(async () => {
      for await (const _ of provider.streamChat({
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", content: "18C", name: "get_weather" },
        ],
        tools: [WEATHER_TOOL],
      })) {
        // drain
      }
    }).rejects.toThrow(/no toolCallId/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/**
 * docs/26_DECISIONS.md ADR-045 — the hardening that already protected llm-google, applied
 * here: an empty answer must not look like a success.
 */
describe("AnthropicProvider failure modes that must not look like success", () => {
  const run = async (sse: string) => {
    const fetchImpl = vi.fn(async () => new Response(stringToStream(sse), { status: 200 })) as unknown as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: "sk-ant-test", fetchImpl });
    const events = [];
    for await (const event of provider.streamChat({ messages: [{ role: "user", content: "hi" }] })) events.push(event);
    return events;
  };

  it("throws, naming the stop reason, when the output cap was hit before any text", async () => {
    await expect(
      run(
        [
          `event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":9}}}\n\n`,
          `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":0}}\n\n`,
          `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
        ].join("")
      )
    ).rejects.toThrow(/Anthropic returned no content.*max_tokens.*finish reason: length/);
  });

  it("throws, naming the unreadable frames, rather than reporting an empty success", async () => {
    await expect(run(`data: {not json\n\n`)).rejects.toThrow(/1 stream frame\(s\) could not be parsed/);
  });

  it("surfaces a stream error event as a ProviderError", async () => {
    await expect(
      run(`event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`)
    ).rejects.toThrow(/Anthropic stream error: Overloaded/);
  });
});
