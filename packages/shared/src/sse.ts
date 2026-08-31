/**
 * Generic SSE frame parser for outbound provider calls (server-side `fetch` responses),
 * distinct from apps/web's browser-side one (which parses our own API's SSE output).
 * Used by packages/providers/llm-{anthropic,openai,google} to consume each provider's
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

    let separatorIndex: number;
    while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawFrame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      yield parseFrame(rawFrame);
    }
  }

  if (buffer.trim().length > 0) {
    yield parseFrame(buffer);
  }
}

function parseFrame(rawFrame: string): SseEvent {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of rawFrame.split("\n")) {
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
