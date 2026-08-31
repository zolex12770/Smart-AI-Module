import { describe, expect, it, vi } from "vitest";
import { stringToStream } from "@ai-platform/shared";
import { OpenAIProvider } from "./index.js";

/**
 * Fixture matches the documented event names from docs/04_MODEL_PROVIDER_RESEARCH.md
 * §2.3 (response.output_text.delta, response.completed). Field layout inside each event
 * is our best reconstruction of OpenAI's convention, not a captured real payload — see
 * the honest verification-status note in src/index.ts.
 */
const FIXTURE_SSE = [
  `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_01"}}\n\n`,
  `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n`,
  `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" there"}\n\n`,
  `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_01","model":"gpt-5.6-terra","usage":{"input_tokens":8,"output_tokens":3}}}\n\n`,
].join("");

describe("OpenAIProvider", () => {
  it("streams tokens and a final done event parsed from a realistic Responses API fixture", async () => {
    const fetchImpl = vi.fn(async () => new Response(stringToStream(FIXTURE_SSE), { status: 200 })) as unknown as typeof fetch;
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
  });

  it("sends the request to /v1/responses with the input array shape and stream:true", async () => {
    const fetchImpl = vi.fn(async () => new Response(stringToStream(FIXTURE_SSE), { status: 200 })) as unknown as typeof fetch;
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
