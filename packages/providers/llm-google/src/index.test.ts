import { describe, expect, it, vi } from "vitest";
import { stringToStream } from "@ai-platform/shared";
import { GoogleProvider } from "./index.js";

/**
 * Fixture matches the documented chunk shape from docs/04_MODEL_PROVIDER_RESEARCH.md
 * §3.4: repeated full GenerateContentResponse objects, no typed micro-events, final
 * chunk carries usageMetadata. Not a captured real payload — see the honest
 * verification-status note in src/index.ts.
 */
const FIXTURE_SSE = [
  `data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n`,
  `data: {"candidates":[{"content":{"parts":[{"text":", world!"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":4}}\n\n`,
].join("");

describe("GoogleProvider", () => {
  it("streams tokens and a final done event parsed from a realistic generateContent fixture", async () => {
    const fetchImpl = vi.fn(async () => new Response(stringToStream(FIXTURE_SSE), { status: 200 })) as unknown as typeof fetch;
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
  });

  it("maps assistant -> model role and extracts system messages into systemInstruction", async () => {
    const fetchImpl = vi.fn(async () => new Response(stringToStream(FIXTURE_SSE), { status: 200 })) as unknown as typeof fetch;
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

/**
 * docs/26_DECISIONS.md ADR-045 — the failure modes a real first call can hit that all used to
 * end as a successful-looking empty answer attributed to google.
 */
describe("GoogleProvider failure modes that must not look like success", () => {
  const run = async (sse: string) => {
    const fetchImpl = vi.fn(async () => new Response(stringToStream(sse), { status: 200 })) as unknown as typeof fetch;
    const provider = new GoogleProvider({ apiKey: "test-key", fetchImpl });
    const events = [];
    for await (const event of provider.streamChat({ messages: [{ role: "user", content: "hi" }] })) events.push(event);
    return events;
  };

  it("counts thinking tokens as output — they are billed as output but reported separately", async () => {
    const events = await run(
      `data: {"candidates":[{"content":{"parts":[{"text":"42"}]}}],"usageMetadata":{"promptTokenCount":30,"candidatesTokenCount":180,"thoughtsTokenCount":1400}}

`
    );
    const done = events.find((e) => e.type === "done") as any;
    expect(done.usage).toEqual({ inputTokens: 30, outputTokens: 1580 });
  });

  it("throws, naming the safety filter, instead of yielding an empty successful answer", async () => {
    await expect(run(`data: {"promptFeedback":{"blockReason":"SAFETY"}}

`)).rejects.toThrow(/blocked by a safety filter.*SAFETY/);
  });

  it("throws, naming the finish reason, when the model stopped before emitting text", async () => {
    await expect(
      run(`data: {"candidates":[{"finishReason":"MAX_TOKENS","content":{"parts":[]}}]}

`)
    ).rejects.toThrow(/stopped early.*MAX_TOKENS/);
  });

  it("throws, naming the unreadable frames, rather than reporting an empty success", async () => {
    await expect(run(`data: {not json

`)).rejects.toThrow(/1 stream frame\(s\) could not be parsed/);
  });

  it("parses a CRLF-framed stream — the wire form that used to produce zero tokens", async () => {
    const events = await run(
      `data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}

data: {"candidates":[{"content":{"parts":[{"text":"!"}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}

`
    );
    expect(events.filter((e) => e.type === "token").map((e: any) => e.delta)).toEqual(["Hello", "!"]);
    const done = events.find((e) => e.type === "done") as any;
    expect(done.message.content).toBe("Hello!");
    expect(done.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });
});

