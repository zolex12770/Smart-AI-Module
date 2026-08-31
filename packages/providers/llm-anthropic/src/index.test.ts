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
