export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type ChatStreamEvent =
  | { type: "token"; delta: string }
  | { type: "done"; message: ChatMessage; usage: { inputTokens: number; outputTokens: number }; provider: string; model: string }
  | { type: "error"; message: string };

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

/**
 * Manual SSE frame parsing over a POST response body. Native EventSource is GET-only,
 * so a POST-with-streamed-body + manual "event:/data:" parser is the standard pattern
 * for streaming chat completions — see docs/15_API_ARCHITECTURE.md.
 */
export async function* streamChat(
  messages: ChatMessage[],
  conversationId: string | undefined,
  signal: AbortSignal
): AsyncGenerator<ChatStreamEvent, string | undefined, unknown> {
  const res = await fetch(`${API_URL}/api/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, conversationId }),
    signal,
  });

  if (!res.ok || !res.body) {
    yield { type: "error", message: `Request failed (${res.status})` };
    return conversationId;
  }

  const nextConversationId = res.headers.get("X-Conversation-Id") ?? conversationId;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex: number;
    while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      yield JSON.parse(dataLine.slice("data: ".length)) as ChatStreamEvent;
    }
  }

  return nextConversationId;
}
