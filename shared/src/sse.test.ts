import { describe, expect, it } from "vitest";
import { parseSseStream, stringToStream } from "./sse.js";

/**
 * docs/26_DECISIONS.md ADR-045. This parser framed only on "\n\n", which is one of the three
 * blank-line forms the SSE specification allows and one of the three Google's own JS client
 * matches for the endpoint packages/providers/llm-google calls. A CRLF-framed stream hit no
 * separator at all: the whole body accumulated into a single trailing "frame", the JSON parse
 * of that blob failed, and the caller saw a perfectly successful, completely empty answer.
 * These lock in every separator form, including the mixed case, and the trailing-\r case that
 * would otherwise ride along inside the data payload and break JSON.parse on its own.
 */
async function collect(text: string) {
  const out: Array<{ event?: string; data: string }> = [];
  for await (const frame of parseSseStream(stringToStream(text))) out.push(frame);
  return out;
}

describe("parseSseStream separators", () => {
  it("frames on LF-LF, the form it always supported", async () => {
    expect(await collect(`data: {"a":1}\n\ndata: {"a":2}\n\n`)).toEqual([
      { event: undefined, data: '{"a":1}' },
      { event: undefined, data: '{"a":2}' },
    ]);
  });

  it("frames on CRLF-CRLF — the form that used to yield one unparseable blob", async () => {
    expect(await collect(`data: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n`)).toEqual([
      { event: undefined, data: '{"a":1}' },
      { event: undefined, data: '{"a":2}' },
    ]);
  });

  it("frames on CR-CR, and consumes exactly the separator's own length", async () => {
    expect(await collect(`data: {"a":1}\r\rdata: {"a":2}\r\r`)).toEqual([
      { event: undefined, data: '{"a":1}' },
      { event: undefined, data: '{"a":2}' },
    ]);
  });

  it("handles a stream that mixes separator forms, and keeps event names with CRLF lines", async () => {
    expect(await collect(`event: message\r\ndata: {"a":1}\r\n\r\nevent: message\ndata: {"a":2}\n\n`)).toEqual([
      { event: "message", data: '{"a":1}' },
      { event: "message", data: '{"a":2}' },
    ]);
  });

  it("leaves no trailing CR inside the data, so JSON.parse of a CRLF frame succeeds", async () => {
    const [frame] = await collect(`data: {"text":"hi"}\r\n\r\n`);
    expect(frame.data).toBe('{"text":"hi"}');
    expect(() => JSON.parse(frame.data)).not.toThrow();
  });

  it("still flushes a final frame that arrives without a trailing separator", async () => {
    expect(await collect(`data: {"a":1}`)).toEqual([{ event: undefined, data: '{"a":1}' }]);
  });

  it("joins multi-line data payloads across every line-ending form", async () => {
    const [frame] = await collect(`data: line one\r\ndata: line two\r\n\r\n`);
    expect(frame.data).toBe("line one\nline two");
  });
});
