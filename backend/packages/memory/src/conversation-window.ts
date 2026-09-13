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
 * Three details are load-bearing:
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
 *  - **A failed summarization degrades, it does not throw.** If the summarizer fails, the live
 *    window is returned with whatever summary was already stored. A chat request must not fail
 *    because a bookkeeping call did; the worst case is the model seeing less history, which is
 *    exactly the situation that existed before this code.
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

  const aged = turns.slice(0, turns.length - liveWindowMessages);
  const live = turns.slice(turns.length - liveWindowMessages);

  let summary = conversation.summary;
  let covered = conversation.summarizedMessageCount;
  let summarized = false;
  let error: string | undefined;

  // Counted in TURNS, never in prompt-array positions. `covered` used to be stored as
  // `lead + aged.length` and read back as `aged.slice(covered - lead)`, which only cancels when
  // `lead` is the same on both requests — and it is not: `withMemoryContext` prepends its system
  // message ONLY when retrieval matched something, so `lead` flips between 0 and 1 from one
  // request to the next (a client-supplied system message does the same). On a 1 -> 0 transition
  // one aged turn fell into neither the summary nor the live window and was silently lost from
  // the model's view; on 0 -> 1 a covered turn was summarized twice. The count is now relative to
  // the turns alone, so the preamble's presence cannot shift it.
  const newlyAged = aged.slice(Math.min(covered, aged.length));
  if (newlyAged.length > 0) {
    const transcript = newlyAged.map((m) => m.role + ": " + m.content).join("\n");
    try {
      summary = (await deps.summarize({ previousSummary: summary, transcript })).trim();
      covered = aged.length;
      summarized = true;
      await deps.conversationRepo.updateSummary(input.projectId, conversation.id, summary, covered);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

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
    messages: [...preamble, ...summaryMessage, ...live],
    summarized,
    summary,
    summarizedMessageCount: covered,
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
