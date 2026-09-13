import { createHash } from "node:crypto";
import type { ChatMessage } from "@ai-platform/shared";
import type { Conversation, ConversationRepository } from "@ai-platform/database";

/**
 * Rolling conversation summarization — FR-030, docs/26_DECISIONS.md ADR-103.
 *
 * WHAT WAS MISSING. The `conversations.summary` and `summarized_message_count` columns existed,
 * `ConversationRepository.updateSummary` existed, and NOTHING ever called it. ADR-051 recorded
 * that honestly ("the columns and the repository method exist; nothing writes them ... FR-030 is
 * not met") — but the chat route simply forwarded whatever array the client sent, so a long
 * conversation was neither summarized NOR truncated: it grew until the provider rejected it at
 * its context limit. FR-030's acceptance criterion is that a conversation past the threshold
 * "still produces coherent answers referencing early context", and the failure mode was the
 * opposite of coherent — it was an error.
 *
 * The shape is a live window plus a rolling summary:
 *
 *   [ leading system messages, verbatim ]
 *   [ one system message holding the summary of everything older ]
 *   [ the last N turns, verbatim ]
 *
 * Four details are load-bearing:
 *
 *  - **Leading system messages are never summarized.** Long-term memory injects its context as a
 *    system message ahead of the turns (ADR-063). Folding that into a summary would quietly
 *    degrade the retrieved facts into a paraphrase of themselves, once per request, compounding.
 *
 *  - **Summarization is incremental.** `summarizedMessageCount` says how much the stored summary
 *    already covers, so each pass summarizes the previous summary plus only the turns that have
 *    newly aged out. Re-summarizing the whole history every time would cost tokens proportional
 *    to the conversation on every single request.
 *
 *  - **A failed summarization degrades, it does not throw — and it loses nothing.** If the
 *    summarizer fails, the stored summary is used (when still valid) and every turn it does not
 *    cover is sent verbatim (ADR-110). A chat request must not fail because a bookkeeping call did,
 *    and the cost of that is a larger prompt, never a silently shorter history.
 *
 *  - **A stored summary is trusted only for the history it was built from.** Its fingerprint must
 *    match the turns it claims to cover; an edited, branched or reloaded history rebuilds it
 *    instead (ADR-110). The live window never begins on a tool result, so no call is separated
 *    from the results a provider requires it to precede.
 */
export interface ConversationWindowDeps {
  conversationRepo: Pick<ConversationRepository, "updateSummary">;
  /**
   * Produces the summary. Injected rather than imported so this package keeps its three
   * dependencies and takes none on the model router — the same call as `ModelCallMeter` in
   * agent-core. It also lets a test drive this boundary without a provider.
   */
  summarize(input: { previousSummary: string | null; transcript: string }): Promise<string>;
}

export interface ConversationWindowOptions {
  /** Summarize once the prompt's estimated tokens exceed this. */
  maxPromptTokens?: number;
  /** Keep at least this many of the most recent messages verbatim. */
  liveWindowMessages?: number;
  estimateTokens?: (text: string) => number;
}

export interface ConversationWindowResult {
  /** What to send to the model. Identical to the input when nothing needed doing. */
  messages: ChatMessage[];
  /** True when this call produced a NEW summary (and therefore spent tokens). */
  summarized: boolean;
  /** The summary present in the returned prompt, whether written now or read from the row. */
  summary: string | null;
  /** How many of the conversation's messages that summary covers. */
  summarizedMessageCount: number;
  /** Set when summarization was attempted and failed; the caller should log it. */
  error?: string;
  /**
   * True when a stored summary was DISCARDED because the history this request sent no longer
   * matches the turns it was built from (ADR-110). The caller should log it.
   */
  invalidated?: boolean;
}

const DEFAULTS = {
  /**
   * 6000 tokens of history. Deliberately well under the smallest context window this platform
   * targets: the summary, the live window, the model's own answer and any tool schemas all have
   * to fit alongside it, and a threshold set at the limit is one that triggers only once it is
   * already too late.
   */
  maxPromptTokens: 6_000,
  /**
   * Ten messages — five exchanges. Enough that the immediate back-and-forth a follow-up question
   * depends on ("it", "that one", "the second option") is always present verbatim, since a
   * summary is exactly where those referents get lost.
   */
  liveWindowMessages: 10,
};

/** The same 4-characters-per-token approximation the cost estimator uses. */
const defaultEstimate = (text: string): number => Math.ceil(text.length / 4);

const SUMMARY_PREFIX = "Summary of the earlier part of this conversation";

/**
 * A stable hash over a run of turns — ADR-110.
 *
 * Everything that makes a turn the same turn is included: role, content, and the tool-call identity
 * a provider pairs results with. Two histories share a fingerprint only if the model would see the
 * same conversation.
 */
export function conversationFingerprint(turns: readonly ChatMessage[]): string {
  const hash = createHash("sha256");
  for (const m of turns) {
    hash.update(
      JSON.stringify([
        m.role,
        m.content,
        m.toolCallId ?? null,
        m.name ?? null,
        (m.toolCalls ?? []).map((c) => [c.id, c.name, c.arguments]),
      ])
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * One transcript line for the summarizer — ADR-110.
 *
 * It used to render `role: content` only, so an assistant turn that was purely tool calls became
 * `assistant: ` and every call's name, arguments and id vanished from the summary.
 */
export function renderTranscriptLine(m: ChatMessage): string {
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    const calls = m.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.arguments)}) [call ${c.id}]`).join("; ");
    return `assistant: ${m.content ? m.content + " " : ""}[called ${calls}]`;
  }
  if (m.role === "tool") {
    return `tool ${m.name ?? "result"} [call ${m.toolCallId ?? "unknown"}]: ${m.content}`;
  }
  return `${m.role}: ${m.content}`;
}

export async function applyConversationWindow(
  deps: ConversationWindowDeps,
  input: { projectId: string; conversation: Conversation; messages: ChatMessage[] },
  options: ConversationWindowOptions = {}
): Promise<ConversationWindowResult> {
  const maxPromptTokens = options.maxPromptTokens ?? DEFAULTS.maxPromptTokens;
  const liveWindowMessages = options.liveWindowMessages ?? DEFAULTS.liveWindowMessages;
  const estimate = options.estimateTokens ?? defaultEstimate;

  const { conversation, messages } = input;
  const unchanged: ConversationWindowResult = {
    messages,
    summarized: false,
    summary: conversation.summary,
    summarizedMessageCount: conversation.summarizedMessageCount,
  };

  const total = estimate(messages.map((m) => m.content).join(" "));
  if (total <= maxPromptTokens) return unchanged;

  // Leading system messages stay verbatim, ahead of everything else.
  let lead = 0;
  while (lead < messages.length && messages[lead].role === "system") lead++;
  const preamble = messages.slice(0, lead);
  const turns = messages.slice(lead);

  if (turns.length <= liveWindowMessages) {
    // Nothing has aged out: the prompt is large because the recent turns themselves are large,
    // and summarizing the live window would discard the very context the next answer needs.
    return unchanged;
  }

  // Never start the live window on a tool result (ADR-110). A plain index cut could land between an
  // assistant turn carrying toolCalls and its results, summarizing the call away and sending the
  // results with no call — a request OpenAI and Anthropic both reject with a 400, and one a client
  // retrying the same history would hit forever. The cut moves back to take the whole exchange live.
  let split = turns.length - liveWindowMessages;
  while (split > 0 && turns[split].role === "tool") split--;
  if (split <= 0) return unchanged;

  const aged = turns.slice(0, split);
  const live = turns.slice(split);

  // Counted in TURNS, and TRUSTED ONLY IF THE PREFIX MATCHES (ADR-110). A stored count is a position
  // in whatever array an earlier request sent. The web client keeps a failed turn's error text in its
  // list but the server never stores it, so a reload shortens the history by one; an API client can
  // edit or branch it. Either way `aged.slice(count)` then pointed at the wrong turns: one was
  // silently lost, or the model got a summary of a branch that was no longer in the conversation.
  // The fingerprint proves the covered prefix is unchanged; otherwise the summary is rebuilt.
  const storedCount = conversation.summarizedMessageCount;
  const storedValid =
    Boolean(conversation.summary) &&
    storedCount > 0 &&
    storedCount <= aged.length &&
    conversation.summaryFingerprint !== null &&
    conversationFingerprint(aged.slice(0, storedCount)) === conversation.summaryFingerprint;
  const invalidated = Boolean(conversation.summary) && !storedValid;

  let summary = storedValid ? conversation.summary : null;
  let covered = storedValid ? storedCount : 0;
  let summarized = false;
  let error: string | undefined;

  const newlyAged = aged.slice(covered);
  if (newlyAged.length > 0) {
    const transcript = newlyAged.map(renderTranscriptLine).join("\n");
    try {
      const produced = (await deps.summarize({ previousSummary: summary, transcript })).trim();
      // An empty reply is a failure, not a summary (ADR-110). Accepting it advanced the count past
      // turns that were then in neither the summary nor the prompt, and they were never revisited.
      if (!produced) throw new Error("The summarizer returned an empty summary; nothing was stored.");
      summary = produced;
      covered = aged.length;
      summarized = true;
      try {
        await deps.conversationRepo.updateSummary(
          input.projectId,
          conversation.id,
          produced,
          covered,
          conversationFingerprint(aged)
        );
      } catch (err) {
        // The summary is good and is used for THIS request; the next one re-summarizes.
        error = "summary produced but not stored: " + (err instanceof Error ? err.message : String(err));
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  // Turns the summary does not cover travel verbatim. Non-empty only when summarization failed — and
  // dropping them in that case was the original silent-loss defect (ADR-110). They cannot begin with
  // an orphaned tool result: a stored count is always a previous split point, which is never a tool
  // result, and the fingerprint proves this is the same history, so `aged[covered]` is not one either.
  const uncovered = aged.slice(covered);

  const summaryMessage: ChatMessage[] = summary
    ? [
        {
          role: "system",
          // Labelled, so the model can tell a compressed account of the past from a verbatim
          // turn and does not quote the summary back as something the user said.
          content:
            SUMMARY_PREFIX + " (" + String(covered) + " earlier messages, condensed):\n" + summary,
        },
      ]
    : [];

  return {
    messages: [...preamble, ...summaryMessage, ...uncovered, ...live],
    summarized,
    summary,
    summarizedMessageCount: covered,
    ...(invalidated ? { invalidated } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * The instruction given to the model. Explicit about preserving specifics, because the failure
 * mode of a summary in a *working* conversation is losing the one detail the next turn needed —
 * a name, a number, a decision — to a fluent paragraph that mentions none of them.
 */
export const CONVERSATION_SUMMARY_PROMPT = [
  "You are maintaining a running summary of a conversation so that it can continue coherently",
  "after the earlier turns are dropped from the context window.",
  "",
  "Rewrite the summary to cover the earlier summary AND the new turns below. Requirements:",
  "- Preserve every specific the conversation may refer back to: names, identifiers, numbers,",
  "  file paths, decisions made, and anything the user asked you to remember.",
  "- Preserve unresolved threads: questions not yet answered, tasks not yet finished.",
  "- Write it as notes for yourself, not as prose for the user. No preamble, no sign-off.",
  "- Be concise, but never drop a specific to save words.",
].join("\n");
