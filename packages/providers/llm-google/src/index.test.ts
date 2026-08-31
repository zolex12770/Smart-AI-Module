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
