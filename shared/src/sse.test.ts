import { describe, expect, it } from "vitest";
import { parseSseStream, stringToStream } from "./sse.js";

/**
 * docs/26_DECISIONS.md ADR-045. This parser framed only on "\n\n", which is one of the three
 * blank-line forms the SSE specification allows and one of the three Google's own JS client
 * matches for the endpoint backend/packages/providers/llm-google calls. A CRLF-framed stream hit no
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

/**
 * Abandoning the stream closes the upstream connection — docs/26_DECISIONS.md ADR-140.
 *
 * ADR-119 built the chain that stops a cancelled chat: the route aborts, the router closes the
 * iterator it holds, that closes the provider's generator. It ended here. This parser took the
 * body's reader and never released it, so the last link was missing — the upstream response
 * stayed open, and a provider that streams to its own completion kept generating tokens, and
 * charging for them, for a reader that had walked away.
 */
describe("parseSseStream releases the body when the consumer stops", () => {
  /** A stream that reports whether it was cancelled, which is the whole property under test. */
  function trackedStream(chunks: string[]): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
    let cancelled = false;
    const encoder = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]!));
        // Deliberately never closed: a provider stream ends when the provider decides, and the
        // case under test is the consumer leaving first.
      },
      cancel() {
        cancelled = true;
      },
    });
    return { stream, cancelled: () => cancelled };
  }

  it("cancels the reader when the consumer breaks out early", async () => {
    const { stream, cancelled } = trackedStream(['data: {"n":1}\n\n', 'data: {"n":2}\n\n', 'data: {"n":3}\n\n']);

    for await (const event of parseSseStream(stream)) {
      expect(event.data).toContain("n");
      break; // the client went away
    }

    expect(cancelled()).toBe(true);
  });

  it("cancels the reader when the consumer calls return() explicitly", async () => {
    // This is what the router does: it holds the iterator by hand and closes it in a finally.
    const { stream, cancelled } = trackedStream(['data: a\n\n', 'data: b\n\n']);
    const iterator = parseSseStream(stream)[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.return?.(undefined);

    expect(cancelled()).toBe(true);
  });

  it("cancels the reader when the consumer throws", async () => {
    const { stream, cancelled } = trackedStream(['data: a\n\n', 'data: b\n\n']);

    await expect(
      (async () => {
        for await (const _event of parseSseStream(stream)) {
          void _event;
          throw new Error("the consumer failed");
        }
      })()
    ).rejects.toThrow(/consumer failed/);

    expect(cancelled()).toBe(true);
  });

  it("still yields every frame of a stream that ends normally", async () => {
    // A cancel in `finally` must not truncate a stream that finished on its own.
    const events = [];
    for await (const event of parseSseStream(stringToStream('data: one\n\ndata: two\n\ndata: three\n\n'))) {
      events.push(event.data);
    }
    expect(events).toEqual(["one", "two", "three"]);
  });
});
