import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamChat, type ChatStreamEvent } from "./chat-stream";

/**
 * ADR-068. This is the client-side half of the SSE contract, and the ADR-047 audit found three
 * real defects in it that no test could catch because `frontend` had no tests at all:
 *
 *   1. It framed on `"\n\n"` only — the exact bug ADR-045 fixed on the server and never
 *      applied here, which against a CRLF response renders a permanently empty answer.
 *   2. `JSON.parse` was unguarded, so one malformed frame became an unhandled rejection.
 *   3. It discarded the API's error body, showing "Request failed (429)" instead of the quota
 *      message the server actually sent.
 *
 * It also had no authentication at all, which since ADR-049 means every chat would 401.
 */

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function sseResponse(body: string, headers: Record<string, string> = {}) {
  return new Response(streamOf(body), { status: 200, headers: { "X-Conversation-Id": "conv-1", ...headers } });
}

async function collect(signal = new AbortController().signal) {
  const events: ChatStreamEvent[] = [];
  const iterator = streamChat([{ role: "user", content: "hi" }], undefined, signal);
  let result = await iterator.next();
  while (!result.done) {
    events.push(result.value);
    result = await iterator.next();
  }
  return { events, conversationId: result.value };
}

const frame = (event: object) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`;

describe("streamChat", () => {
  beforeEach(() => {
    document.cookie = "aip_csrf=csrf-token-value";
    window.localStorage.setItem("aip.selectedProjectId", "project-1");
  });

  afterEach(() => {
    window.localStorage.clear();
    document.cookie = "aip_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  });

  it("sends the session cookie, the CSRF header and the project scope", async () => {
    const fetchMock = vi.fn(async () => sseResponse(frame({ type: "done", message: { role: "assistant", content: "ok" }, usage: { inputTokens: 1, outputTokens: 1 }, provider: "p", model: "m" })));
    vi.stubGlobal("fetch", fetchMock);

    await collect();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string>)["x-csrf-token"]).toBe("csrf-token-value");
    expect((init.headers as Record<string, string>)["x-project-id"]).toBe("project-1");
  });

  it("yields token events and a final done event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(
          frame({ type: "token", delta: "Hel" }) +
            frame({ type: "token", delta: "lo" }) +
            frame({ type: "done", message: { role: "assistant", content: "Hello" }, usage: { inputTokens: 3, outputTokens: 2 }, provider: "p", model: "m" })
        )
      )
    );

    const { events, conversationId } = await collect();
    expect(events.filter((e) => e.type === "token").map((e) => (e as { delta: string }).delta)).toEqual(["Hel", "lo"]);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(conversationId).toBe("conv-1");
  });

  it("parses a CRLF-framed stream — the form that used to render an empty answer", async () => {
    const crlf =
      `event: token\r\ndata: ${JSON.stringify({ type: "token", delta: "Hi" })}\r\n\r\n` +
      `event: done\r\ndata: ${JSON.stringify({ type: "done", message: { role: "assistant", content: "Hi" }, usage: { inputTokens: 1, outputTokens: 1 }, provider: "p", model: "m" })}\r\n\r\n`;
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(crlf)));

    const { events } = await collect();
    expect(events.filter((e) => e.type === "token")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("skips a malformed frame instead of throwing out of the generator", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(
          "event: token\ndata: {not json\n\n" +
            frame({ type: "done", message: { role: "assistant", content: "ok" }, usage: { inputTokens: 1, outputTokens: 1 }, provider: "p", model: "m" })
        )
      )
    );

    const { events } = await collect();
    // The bad frame is dropped; the good one still arrives.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "done" });
  });

  it("surfaces the API's real error message, not just the status code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "QUOTA_EXCEEDED", message: "Daily token limit of 100 would be exceeded." } }),
            { status: 429, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    const { events } = await collect();
    expect(events[0]).toEqual({ type: "error", message: "Daily token limit of 100 would be exceeded." });
  });

  it("falls back to a status message when the error body is not the expected envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gateway timeout", { status: 504 })));
    const { events } = await collect();
    expect(events[0]).toEqual({ type: "error", message: "Request failed (504)" });
  });

  it("passes the abort signal through so a cancelled chat stops being billed", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => sseResponse(frame({ type: "done", message: { role: "assistant", content: "ok" }, usage: { inputTokens: 1, outputTokens: 1 }, provider: "p", model: "m" })));
    vi.stubGlobal("fetch", fetchMock);

    await collect(controller.signal);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it("yields tool_call events so the UI can show what the agent is doing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(
          frame({ type: "tool_call", call: { id: "c1", name: "fs.read_file", arguments: { path: "a.txt" } } }) +
            frame({ type: "done", message: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, provider: "p", model: "m" })
        )
      )
    );

    const { events } = await collect();
    expect(events[0]).toMatchObject({ type: "tool_call", call: { name: "fs.read_file" } });
  });
});
