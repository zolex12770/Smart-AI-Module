/**
 * Generic SSE frame parser for outbound provider calls (server-side `fetch` responses),
 * distinct from frontend's browser-side one (which parses our own API's SSE output).
 * Used by backend/packages/providers/llm-{anthropic,openai,google} to consume each provider's
 * streaming response, and by their unit tests to feed a fixture stream through the same
 * parser real traffic would use — see docs/21_TESTING_STRATEGY.md's fixture-based
 * provider-adapter testing approach.
 */
export interface SseEvent {
  event?: string;
  data: string;
}

export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let match: RegExpExecArray | null;
    while ((match = FRAME_SEPARATOR.exec(buffer)) !== null) {
      const rawFrame = buffer.slice(0, match.index);
      // The separator's own length, not a hard-coded 2 — "\r\n\r\n" is four characters.
      buffer = buffer.slice(match.index + match[0].length);
      yield parseFrame(rawFrame);
    }
  }

  if (buffer.trim().length > 0) {
    yield parseFrame(buffer);
  }
}

/**
 * All three blank-line forms the SSE specification allows, longest first so "\r\n\r\n" is
 * never mis-matched as a bare "\r\r" — docs/26_DECISIONS.md ADR-045. This parser accepted
 * only "\n\n"; Google's own JS client matches `(?:\r\n\r\n|\r\r|\n\n)` for the very endpoint
 * backend/packages/providers/llm-google calls, and a CRLF-framed stream would have hit none of the
 * old separator's matches, accumulated the entire response into one unparseable blob, and
 * produced a perfectly successful-looking empty answer.
 */
// Deliberately NOT global: `exec` on a global regex carries `lastIndex` between calls, which
// would skip frames here because the buffer is re-sliced after every match.
const FRAME_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;
const LINE_SEPARATOR = /\r\n|\n|\r/;

function parseFrame(rawFrame: string): SseEvent {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of rawFrame.split(LINE_SEPARATOR)) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
  }
  return { event, data: dataLines.join("\n") };
}

/** Builds a ReadableStream from a plain string — used to feed fixtures through
 * `parseSseStream` in tests without a real network response. */
export function stringToStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
