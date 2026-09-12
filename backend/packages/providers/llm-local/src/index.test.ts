import { describe, expect, it, vi } from "vitest";
import { ProviderError, stringToStream, type ChatStreamEvent } from "@ai-platform/shared";
import { LocalEmbeddingProvider, LocalOpenAICompatibleProvider } from "./index.js";

/**
 * ADR-056. This adapter is what makes the platform independent of any third-party AI vendor
 * (product brief §7), so its wire format is load-bearing: it must speak exactly the
 * OpenAI-compatible `/v1/chat/completions` dialect that Ollama, vLLM, llama.cpp's server and
 * LM Studio all implement.
 *
 * The fixtures below are hand-written to that documented shape. That is an honest limitation
 * and is stated in the adapter's own header too: these prove the adapter constructs correct
 * requests and parses correct responses, not that a specific local runtime behaves this way.
 */

function sse(...chunks: object[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

function respondWith(body: string, status = 200) {
  return vi.fn(async () => new Response(stringToStream(body), { status })) as unknown as typeof fetch;
}

async function collect(provider: LocalOpenAICompatibleProvider, request: Parameters<typeof provider.streamChat>[0]) {
  const events: ChatStreamEvent[] = [];
  for await (const event of provider.streamChat(request)) events.push(event);
  return events;
}

const base = { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:14b" };

describe("LocalOpenAICompatibleProvider", () => {
  it("streams text deltas and a final done event with real usage", async () => {
    const fetchImpl = respondWith(
      sse(
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: ", world" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } }
      )
    );
    const provider = new LocalOpenAICompatibleProvider({ ...base, fetchImpl });
    const events = await collect(provider, { messages: [{ role: "user", content: "hi" }] });

    expect(events.filter((e) => e.type === "token").map((e) => (e as { delta: string }).delta)).toEqual([
      "Hello",
      ", world",
    ]);
    const done = events.at(-1);
    expect(done).toMatchObject({
      type: "done",
      provider: "local",
      model: "qwen2.5:14b",
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    expect((done as { message: { content: string } }).message.content).toBe("Hello, world");
  });

  it("sends the documented request shape, including tools as JSON Schema functions", async () => {
    const fetchImpl = respondWith(sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }));
    const provider = new LocalOpenAICompatibleProvider({ ...base, apiKey: "sk-local", fetchImpl });
    await collect(provider, {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "calculator", description: "Adds numbers", inputSchema: { type: "object", properties: {} } }],
      maxOutputTokens: 256,
      temperature: 0.2,
    });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-local");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "qwen2.5:14b", stream: true, max_tokens: 256, temperature: 0.2 });
    expect(body.tools[0]).toEqual({
      type: "function",
      function: { name: "calculator", description: "Adds numbers", parameters: { type: "object", properties: {} } },
    });
    expect(body.tool_choice).toBe("auto");
  });

  it("reassembles a tool call fragmented across chunks, which is how these runtimes stream them", async () => {
    const fetchImpl = respondWith(
      sse(
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "calculator", arguments: '{"exp' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ression":"1+1"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 7 } }
      )
    );
    const provider = new LocalOpenAICompatibleProvider({ ...base, fetchImpl });
    const events = await collect(provider, {
      messages: [{ role: "user", content: "what is 1+1" }],
      tools: [{ name: "calculator", description: "", inputSchema: { type: "object" } }],
    });

    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toEqual({
      type: "tool_call",
      call: { id: "call_1", name: "calculator", arguments: { expression: "1+1" } },
    });
    const done = events.at(-1) as { message: { toolCalls?: unknown[] }; finishReason: string };
    expect(done.finishReason).toBe("tool_calls");
    expect(done.message.toolCalls).toHaveLength(1);
  });

  it("maps assistant tool calls and tool results back onto the wire format", async () => {
    const fetchImpl = respondWith(sse({ choices: [{ delta: { content: "2" }, finish_reason: "stop" }] }));
    const provider = new LocalOpenAICompatibleProvider({ ...base, fetchImpl });
    await collect(provider, {
      messages: [
        { role: "user", content: "1+1?" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "calculator", arguments: { expression: "1+1" } }] },
        { role: "tool", content: "2", toolCallId: "c1", name: "calculator" },
      ],
    });
    const body = JSON.parse(String(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "calculator", arguments: '{"expression":"1+1"}' } }],
    });
    expect(body.messages[2]).toEqual({ role: "tool", content: "2", tool_call_id: "c1", name: "calculator" });
  });

  it("refuses to report an empty answer as a success (ADR-045)", async () => {
    const fetchImpl = respondWith(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    const provider = new LocalOpenAICompatibleProvider({ ...base, fetchImpl });
    await expect(collect(provider, { messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /returned no content/
    );
  });

  it("throws rather than inventing empty arguments when the model emits malformed JSON", async () => {
    const fetchImpl = respondWith(
      sse(
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "t", arguments: "{not json" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
      )
    );
    const provider = new LocalOpenAICompatibleProvider({ ...base, fetchImpl });
    await expect(
      collect(provider, {
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: "t", description: "", inputSchema: { type: "object" } }],
      })
    ).rejects.toThrow(/unparseable arguments/);
  });

  it("surfaces a non-2xx response as a ProviderError carrying the body", async () => {
    const fetchImpl = vi.fn(async () => new Response("model not found", { status: 404 })) as unknown as typeof fetch;
    const provider = new LocalOpenAICompatibleProvider({ ...base, fetchImpl });
    await expect(collect(provider, { messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /request failed \(404\).*model not found/s
    );
  });

  it("reports an unreachable runtime clearly, naming the URL an operator must fix", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const provider = new LocalOpenAICompatibleProvider({ ...base, fetchImpl });
    await expect(collect(provider, { messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /Could not reach the local model runtime at http:\/\/127\.0\.0\.1:11434\/v1/
    );
  });

  it("declares honest capabilities, and refuses tools when the model cannot call them", async () => {
    const withTools = new LocalOpenAICompatibleProvider({ ...base, contextWindow: 32768 });
    expect(withTools.capabilities()).toEqual({
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: false,
      contextWindow: 32768,
    });

    const noTools = new LocalOpenAICompatibleProvider({ ...base, supportsTools: false });
    expect(noTools.capabilities().toolCalling).toBe(false);
    await expect(
      collect(noTools, {
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "t", description: "", inputSchema: {} }],
      })
    ).rejects.toThrow(/not configured for tool calling/);
  });
});

describe("LocalEmbeddingProvider", () => {
  it("requests the documented shape and returns vectors in index order", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0.3, 0.4] },
              { index: 0, embedding: [0.1, 0.2] },
            ],
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;
    const provider = new LocalEmbeddingProvider({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "nomic-embed-text",
      dimensions: 768,
      fetchImpl,
    });

    const vectors = await provider.embed(["first", "second"]);
    // The runtime returned them out of order; `index` is authoritative.
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(provider.isDeterministicFallback).toBe(false);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/v1/embeddings");
    expect(JSON.parse(String(init.body))).toEqual({ model: "nomic-embed-text", input: ["first", "second"] });
  });

  it("refuses a response whose vector count does not match the input count", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1] }] }), { status: 200 })
    ) as unknown as typeof fetch;
    const provider = new LocalEmbeddingProvider({ baseUrl: "http://x/v1", model: "m", dimensions: 1, fetchImpl });
    await expect(provider.embed(["a", "b"])).rejects.toBeInstanceOf(ProviderError);
  });

  it("returns nothing for no input without calling the runtime", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const provider = new LocalEmbeddingProvider({ baseUrl: "http://x/v1", model: "m", dimensions: 1, fetchImpl });
    expect(await provider.embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
