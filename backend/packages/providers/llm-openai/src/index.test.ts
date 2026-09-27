import { describe, expect, it, vi } from "vitest";
import { stringToStream } from "@ai-platform/shared";
import { OpenAIProvider } from "./index.js";

/**
 * Fixture matches the documented event names from docs/04_MODEL_PROVIDER_RESEARCH.md
 * §2.3 (response.output_text.delta, response.function_call_arguments.delta,
 * response.completed). Field layout inside each event is our best reconstruction of
 * OpenAI's convention, not a captured real payload — see the honest verification-status
 * note in src/index.ts.
 */
const FIXTURE_SSE = [
  `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_01"}}\n\n`,
  `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n`,
  `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" there"}\n\n`,
  `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_01","model":"gpt-5.6-terra","status":"completed","usage":{"input_tokens":8,"output_tokens":3}}}\n\n`,
].join("");

/**
 * A tool-calling turn in the Responses idiom (docs/04 §2.2): the model emits a
 * `function_call` ITEM, whose arguments stream in as
 * `response.function_call_arguments.delta` fragments and are confirmed by the item's own
 * `done` event, then repeated in the final response's `output` array.
 */
const TOOL_CALL_SSE = [
  `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_02"}}\n\n`,
  `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_01","call_id":"call_01","name":"get_weather","arguments":""}}\n\n`,
  `event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_01","delta":"{\\"loca"}\n\n`,
  `event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_01","delta":"tion\\":\\"Paris\\"}"}\n\n`,
  `event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc_01","call_id":"call_01","name":"get_weather","arguments":"{\\"location\\":\\"Paris\\"}"}\n\n`,
  `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_01","call_id":"call_01","name":"get_weather","arguments":"{\\"location\\":\\"Paris\\"}"}}\n\n`,
  `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_02","model":"gpt-5.6-terra","status":"completed","output":[{"type":"function_call","id":"fc_01","call_id":"call_01","name":"get_weather","arguments":"{\\"location\\":\\"Paris\\"}"}],"usage":{"input_tokens":25,"output_tokens":12}}}\n\n`,
].join("");

/** The same turn on a stream that never sends the item's `done` events — only fragments. */
const TOOL_CALL_FRAGMENTS_ONLY_SSE = [
  `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_02","call_id":"call_02","name":"get_weather","arguments":""}}\n\n`,
  `event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_02","delta":"{\\"location\\":"}\n\n`,
  `event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_02","delta":"\\"Rome\\"}"}\n\n`,
  `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_03","model":"gpt-5.6-terra","status":"completed","usage":{"input_tokens":25,"output_tokens":12}}}\n\n`,
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

describe("OpenAIProvider", () => {
  it("streams tokens and a final done event parsed from a realistic Responses API fixture", async () => {
    const fetchImpl = streamOf(FIXTURE_SSE);
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl });

    const events = [];
    for await (const event of provider.streamChat({ messages: [{ role: "user", content: "hi" }] })) {
      events.push(event);
    }

    expect(events.filter((e) => e.type === "token").map((e: any) => e.delta)).toEqual(["Hi", " there"]);
    const done = events.find((e) => e.type === "done") as any;
    expect(done.message.content).toBe("Hi there");
    expect(done.usage).toEqual({ inputTokens: 8, outputTokens: 3 });
    expect(done.model).toBe("gpt-5.6-terra");
    expect(done.provider).toBe("openai");
    expect(done.finishReason).toBe("stop");
    expect(done.message.toolCalls).toBeUndefined();
  });

  it("reports its model and honest capabilities so the router can select on them", () => {
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: streamOf(FIXTURE_SSE) });
    expect(provider.model).toBe("gpt-5.6-terra");
    expect(provider.capabilities()).toEqual({
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: true,
      contextWindow: 1_050_000,
    });
    const unknown = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-9-unreleased",
      fetchImpl: streamOf(FIXTURE_SSE),
    });
    // An unknown model reports null rather than a guessed window.
    expect(unknown.capabilities().contextWindow).toBeNull();
  });

  it("sends the request to /v1/responses with the input array shape and stream:true", async () => {
    const fetchImpl = streamOf(FIXTURE_SSE);
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl });

    for await (const _ of provider.streamChat({ messages: [{ role: "user", content: "hi" }] })) {
      // drain
    }

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toContain("/v1/responses");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    expect(body.input).toEqual([{ role: "user", content: "hi" }]);
    expect(body.tools).toBeUndefined();
  });

  it("throws a ProviderError on a non-OK HTTP response", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl });

    await expect(async () => {
      for await (const _ of provider.streamChat({ messages: [{ role: "user", content: "hi" }] })) {
        // drain
      }
    }).rejects.toThrow(/OpenAI API request failed \(429\)/);
  });
});

/** docs/26_DECISIONS.md ADR-047 — real tool calling, in the Responses API's item idiom. */
describe("OpenAIProvider tool calling", () => {
  it("sends tools in the FLAT Responses shape, not Chat Completions' nested one", async () => {
    const fetchImpl = streamOf(TOOL_CALL_SSE);
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl });

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
        type: "function",
        name: "get_weather",
        description: "Get current weather for a location",
        parameters: WEATHER_TOOL.inputSchema,
      },
    ]);
    // No nested `function` wrapper — that shape belongs to Chat Completions (docs/04 §2.2).
    expect(body.tools[0].function).toBeUndefined();
    expect(body.tool_choice).toBe("required");
    expect(body.max_output_tokens).toBe(512);
  });

  it("maps a JSON response format onto the Responses API's text.format", async () => {
    const fetchImpl = streamOf(FIXTURE_SSE);
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl });
    for await (const _ of provider.streamChat({ messages: [{ role: "user", content: "hi" }], responseFormat: "json_object" })) {
      // drain
    }
    const body = JSON.parse((fetchImpl as any).mock.calls[0][1].body);
    expect(body.text).toEqual({ format: { type: "json_object" } });
    expect(body.response_format).toBeUndefined();
  });

  it("reassembles a streamed function_call item and emits it exactly once", async () => {
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: streamOf(TOOL_CALL_SSE) });

    const events = [];
    for await (const event of provider.streamChat({
      messages: [{ role: "user", content: "weather in Paris?" }],
      tools: [WEATHER_TOOL],
    })) {
      events.push(event);
    }

    const toolCallEvents = events.filter((e) => e.type === "tool_call") as any[];
    // The same call appears in the item events AND in response.completed's output array;
    // the caller must see one call, not two.
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0].call).toEqual({
      id: "call_01",
      name: "get_weather",
      arguments: { location: "Paris" },
    });

    const done = events.find((e) => e.type === "done") as any;
    expect(done.message.content).toBe("");
    expect(done.message.toolCalls).toEqual([toolCallEvents[0].call]);
    // Responses has no `tool_calls` status — the presence of function_call items is the
    // signal, and it must reach the agent loop as one.
    expect(done.finishReason).toBe("tool_calls");
    expect(done.usage).toEqual({ inputTokens: 25, outputTokens: 12 });
  });

  it("still yields a call assembled only from argument fragments, with no item done event", async () => {
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      fetchImpl: streamOf(TOOL_CALL_FRAGMENTS_ONLY_SSE),
    });

    const events = [];
    for await (const event of provider.streamChat({
      messages: [{ role: "user", content: "weather in Rome?" }],
      tools: [WEATHER_TOOL],
    })) {
      events.push(event);
    }

    const toolCallEvents = events.filter((e) => e.type === "tool_call") as any[];
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0].call).toEqual({
      id: "call_02",
      name: "get_weather",
      arguments: { location: "Rome" },
    });
  });

  it("maps an assistant tool turn and our tool role to function_call / function_call_output items", async () => {
    const fetchImpl = streamOf(FIXTURE_SSE);
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl });

    for await (const _ of provider.streamChat({
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_01", name: "get_weather", arguments: { location: "Paris" } }],
        },
        { role: "tool", content: "18C", toolCallId: "call_01", name: "get_weather" },
      ],
      tools: [WEATHER_TOOL],
    })) {
      // drain
    }

    const [, init] = (fetchImpl as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.input).toEqual([
      { role: "user", content: "weather in Paris?" },
      { type: "function_call", call_id: "call_01", name: "get_weather", arguments: '{"location":"Paris"}' },
      { type: "function_call_output", call_id: "call_01", output: "18C" },
    ]);
  });

  it("refuses a tool result with no toolCallId rather than building a request OpenAI will reject", async () => {
    const fetchImpl = streamOf(FIXTURE_SSE);
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl });

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
describe("OpenAIProvider failure modes that must not look like success", () => {
  const run = async (sse: string) => {
    const provider = new OpenAIProvider({ apiKey: "sk-test", fetchImpl: streamOf(sse) });
    const events = [];
    for await (const event of provider.streamChat({ messages: [{ role: "user", content: "hi" }] })) events.push(event);
    return events;
  };

  it("throws, naming the finish reason, when the output cap was hit before any text", async () => {
    await expect(
      run(
        `event: response.incomplete\ndata: {"type":"response.incomplete","response":{"id":"resp_04","model":"gpt-5.6-terra","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":9,"output_tokens":0}}}\n\n`
      )
    ).rejects.toThrow(/OpenAI returned no content.*finish reason: length/);
  });

  it("throws, naming the finish reason, when the response was filtered", async () => {
    await expect(
      run(
        `event: response.incomplete\ndata: {"type":"response.incomplete","response":{"id":"resp_05","status":"incomplete","incomplete_details":{"reason":"content_filter"}}}\n\n`
      )
    ).rejects.toThrow(/OpenAI returned no content.*finish reason: content_filter/);
  });

  it("throws, naming the unreadable frames, rather than reporting an empty success", async () => {
    await expect(run(`data: {not json\n\n`)).rejects.toThrow(/1 stream frame\(s\) could not be parsed/);
  });

  it("surfaces a stream error event as a ProviderError", async () => {
    await expect(run(`event: error\ndata: {"type":"error","message":"server had an error"}\n\n`)).rejects.toThrow(
      /OpenAI stream error: server had an error/
    );
  });
});
