import { API_URL } from "./api";
import { getSelectedProjectId, readCsrfToken } from "./auth-client";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];
}

export type ChatStreamEvent =
  | { type: "token"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | {
      type: "done";
      message: ChatMessage;
      usage: { inputTokens: number; outputTokens: number };
      provider: string;
      model: string;
      finishReason?: string;
    }
  | { type: "error"; message: string };

/**
 * All three blank-line forms the SSE specification allows — docs/26_DECISIONS.md ADR-068.
 *
 * This parser previously split on `"\n\n"` alone, which is the exact defect ADR-045 fixed on
 * the server and never applied here: against a CRLF-framed response it would match nothing,
 * accumulate the whole body, and render a permanently empty answer. The server's own parser
 * accepts all three, and so must this one.
 */
const FRAME_SEPARATOR = /\r\n\r\n|\n\n|\r\r/;
const LINE_SEPARATOR = /\r\n|\n|\r/;

export class ChatStreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "ChatStreamError";
  }
}

/**
 * Streams a chat completion. Native `EventSource` is GET-only, so a POST with a streamed body
 * and a hand-rolled frame parser is the standard pattern (docs/15_API_ARCHITECTURE.md).
 *
 * Three things this now does that it did not:
 *
 * 1. **Authenticates.** The API requires a session and a project scope (ADR-049); without the
 *    cookie, the CSRF header and `x-project-id` every request would be a 401.
 * 2. **Surfaces the real error.** A 429 from the quota system carries an explanatory body; the
 *    previous version discarded it and showed only "Request failed (429)".
 * 3. **Survives a malformed frame.** An unguarded `JSON.parse` threw out of the generator and
 *    became an unhandled rejection; a bad frame is now skipped.
 */
export async function* streamChat(
  messages: ChatMessage[],
  conversationId: string | undefined,
  signal: AbortSignal
): AsyncGenerator<ChatStreamEvent, string | undefined, unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const csrf = readCsrfToken();
  if (csrf) headers["x-csrf-token"] = csrf;
  const projectId = getSelectedProjectId();
  if (projectId) headers["x-project-id"] = projectId;

  const res = await fetch(`${API_URL}/api/v1/chat`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify({ messages, conversationId }),
    signal,
  });

  if (!res.ok || !res.body) {
    // The API's error envelope carries a code and a human-readable message; showing "429"
    // when the server said "Daily token limit of X would be exceeded" is a worse product.
    const payload = await res.json().catch(() => null);
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    yield {
      type: "error",
      message: error?.message ?? `Request failed (${res.status})`,
    };
    return conversationId;
  }

  const nextConversationId = res.headers.get("X-Conversation-Id") ?? conversationId;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let match: RegExpExecArray | null;
      while ((match = FRAME_SEPARATOR.exec(buffer)) !== null) {
        const frame = buffer.slice(0, match.index);
        // The separator's own length, not a hard-coded 2: "\r\n\r\n" is four characters.
        buffer = buffer.slice(match.index + match[0].length);

        const dataLines = frame
          .split(LINE_SEPARATOR)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim());
        if (dataLines.length === 0) continue;

        const parsed = safeParse(dataLines.join("\n"));
        if (parsed) yield parsed;
      }
    }
  } finally {
    // Releasing the reader is what actually stops the server streaming into a page nobody is
    // reading any more; without it an aborted chat keeps being billed.
    reader.releaseLock();
  }

  return nextConversationId;
}

function safeParse(data: string): ChatStreamEvent | null {
  try {
    return JSON.parse(data) as ChatStreamEvent;
  } catch {
    // A truncated or malformed frame is not worth destroying the stream over.
    return null;
  }
}
