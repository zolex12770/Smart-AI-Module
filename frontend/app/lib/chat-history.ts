import type { ChatMessage } from "./chat-stream";

/**
 * The history the chat view sends with a new turn — docs/26_DECISIONS.md ADR-110.
 *
 * A failed turn leaves its error text in the list as an assistant message, so the person can see
 * what went wrong. It is not a turn: the server stored nothing for it. Sending it made this
 * client's history differ from the conversation's stored one, and after a reload the two no longer
 * lined up — the drift that silently dropped a turn from rolling summaries. The server now detects
 * a divergent history and rebuilds the summary; this stops the first-party client creating one.
 */
export function historyForRequest(messages: ReadonlyArray<ChatMessage & { isError?: boolean }>): ChatMessage[] {
  return messages.filter((m) => !m.isError).map(({ role, content }) => ({ role, content }));
}
