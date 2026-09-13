import { describe, expect, it, vi } from "vitest";
import type { Conversation } from "@ai-platform/database";
import type { ChatMessage } from "@ai-platform/shared";
import { applyConversationWindow, type ConversationWindowDeps } from "./conversation-window.js";

/**
 * FR-030 — docs/26_DECISIONS.md ADR-103.
 *
 * The columns and `updateSummary` existed and nothing called them, so a long conversation was
 * neither summarized nor truncated: the route forwarded the client's array until the provider
 * rejected it at its context limit.
 *
 * These assert the properties that make the feature worth having rather than just present:
 * that the injected memory block is not folded into the summary, that summarization is
 * incremental rather than re-reading the whole history every request, and that a failed
 * summarizer degrades instead of failing the chat request.
 */
const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: "conv-1",
  projectId: "proj-1",
  createdByUserId: "user-1",
  title: null,
  summary: null,
  summarizedMessageCount: 0,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  deletedAt: null,
  ...over,
});

/** `n` turns, each long enough that a handful blow a small token budget. */
const turns = (n: number, marker = "t"): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `${marker}${i} ` + "x".repeat(400),
  }));

const deps = (summary = "ROLLING SUMMARY"): ConversationWindowDeps & { updateSummary: ReturnType<typeof vi.fn>; summarize: ReturnType<typeof vi.fn> } => {
  const updateSummary = vi.fn(async () => true);
  const summarize = vi.fn(async () => summary);
  return { conversationRepo: { updateSummary }, summarize, updateSummary } as never;
};

const OPTS = { maxPromptTokens: 500, liveWindowMessages: 4 };

describe("applyConversationWindow", () => {
  it("leaves a short conversation completely alone, and spends nothing", async () => {
    const d = deps();
    const messages = turns(2);
    const result = await applyConversationWindow(d, { projectId: "proj-1", conversation: conversation(), messages }, OPTS);

    expect(result.messages).toBe(messages); // the same array, not a copy
    expect(result.summarized).toBe(false);
    expect(d.summarize).not.toHaveBeenCalled();
    expect(d.updateSummary).not.toHaveBeenCalled();
  });

  it("replaces the aged-out turns with one summary message and keeps the live window verbatim", async () => {
    const d = deps();
    const messages = turns(12);
    const result = await applyConversationWindow(d, { projectId: "proj-1", conversation: conversation(), messages }, OPTS);

    expect(result.summarized).toBe(true);
    // 1 summary + 4 live
    expect(result.messages).toHaveLength(5);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("ROLLING SUMMARY");
    expect(result.messages.slice(1)).toEqual(messages.slice(8));
    // The summary is labelled, so the model cannot mistake it for something the user said.
    expect(result.messages[0].content).toMatch(/Summary of the earlier part/i);
  });

  it("persists the summary and how much of the history it covers", async () => {
    const d = deps();
    await applyConversationWindow(d, { projectId: "proj-1", conversation: conversation(), messages: turns(12) }, OPTS);
    expect(d.updateSummary).toHaveBeenCalledWith("proj-1", "conv-1", "ROLLING SUMMARY", 8);
  });

  it("never folds a leading system message into the summary", async () => {
    // Long-term memory injects its context as a system message (ADR-063). Summarizing it would
    // degrade the retrieved facts into a paraphrase of themselves once per request.
    const d = deps();
    const memory: ChatMessage = { role: "system", content: "Known facts: the user's cat is named ORION." };
    const messages = [memory, ...turns(12)];
    const result = await applyConversationWindow(d, { projectId: "proj-1", conversation: conversation(), messages }, OPTS);

    expect(result.messages[0]).toEqual(memory);
    expect(result.messages[1].content).toContain("ROLLING SUMMARY");
    // And it was not part of what got summarized.
    expect(d.summarize.mock.calls[0][0].transcript).not.toContain("ORION");
  });

  it("summarizes INCREMENTALLY — only the turns the stored summary does not cover", async () => {
    const d = deps("SECOND SUMMARY");
    const messages = turns(16);
    await applyConversationWindow(
      d,
      { projectId: "proj-1", conversation: conversation({ summary: "FIRST SUMMARY", summarizedMessageCount: 8 }), messages },
      OPTS
    );

    const call = d.summarize.mock.calls[0][0];
    expect(call.previousSummary).toBe("FIRST SUMMARY");
    // 16 turns, 4 live -> 12 aged; 8 already covered, so exactly 4 are new.
    expect(call.transcript).toContain("t8");
    expect(call.transcript).toContain("t11");
    expect(call.transcript).not.toContain("t0 ");
    expect(call.transcript).not.toContain("t7 ");
  });

  it("reuses the stored summary without spending anything when nothing new has aged out", async () => {
    const d = deps();
    const messages = turns(12);
    const result = await applyConversationWindow(
      d,
      { projectId: "proj-1", conversation: conversation({ summary: "STORED", summarizedMessageCount: 8 }), messages },
      OPTS
    );

    expect(d.summarize).not.toHaveBeenCalled();
    expect(result.summarized).toBe(false);
    expect(result.messages[0].content).toContain("STORED");
    expect(result.messages).toHaveLength(5);
  });

  it("degrades rather than throwing when the summarizer fails", async () => {
    const d = deps();
    d.summarize.mockRejectedValueOnce(new Error("provider unavailable"));
    const messages = turns(12);
    const result = await applyConversationWindow(
      d,
      { projectId: "proj-1", conversation: conversation({ summary: "OLD", summarizedMessageCount: 4 }), messages },
      OPTS
    );

    // A chat request must not fail because a bookkeeping call did.
    expect(result.error).toContain("provider unavailable");
    expect(result.summarized).toBe(false);
    // It still shrank the prompt, using the summary it already had.
    expect(result.messages[0].content).toContain("OLD");
    expect(result.messages).toHaveLength(5);
    expect(d.updateSummary).not.toHaveBeenCalled();
  });

  it("does not summarize the live window itself when the recent turns alone are large", async () => {
    // The prompt is over budget, but nothing has aged out. Compressing the last few turns is
    // how a summarizer destroys the context the very next answer depends on.
    const d = deps();
    const messages = turns(4);
    const result = await applyConversationWindow(d, { projectId: "proj-1", conversation: conversation(), messages }, OPTS);
    expect(result.messages).toBe(messages);
    expect(d.summarize).not.toHaveBeenCalled();
  });

  it("loses no turn when the memory preamble appears or disappears between requests", async () => {
    // The defect this covers: `covered` was stored as `lead + aged.length` and read back as
    // `aged.slice(covered - lead)`, which only cancels when `lead` is the same on both requests.
    // It is not — `withMemoryContext` prepends its system message ONLY when retrieval matched
    // something, so `lead` flips between 1 and 0 from one request to the next. On the 1 -> 0
    // transition one aged turn fell into neither the summary nor the live window.
    const summarizedTurns: string[][] = [];
    const d = deps();
    d.summarize.mockImplementation(async ({ transcript }: { transcript: string }) => {
      summarizedTurns.push(transcript.split("\n").map((line) => line.split(" ")[1]));
      return "SUMMARY";
    });

    const memory: ChatMessage = { role: "system", content: "Known facts: …" };
    const history = turns(18);

    // Request 1: retrieval matched, so the preamble is present.
    const first = await applyConversationWindow(
      d,
      { projectId: "proj-1", conversation: conversation(), messages: [memory, ...history] },
      OPTS
    );
    const storedAfterFirst = d.updateSummary.mock.calls.at(-1)![3] as number;

    // Request 2: retrieval matched NOTHING, so there is no preamble this time.
    const second = await applyConversationWindow(
      d,
      {
        projectId: "proj-1",
        conversation: conversation({ summary: "SUMMARY", summarizedMessageCount: storedAfterFirst }),
        messages: [...history, ...turns(2, "later")],
      },
      OPTS
    );

    // Every turn is either summarized or in the live window — none in neither.
    const summarized = new Set(summarizedTurns.flat());
    const liveNow = new Set(second.messages.filter((m) => m.role !== "system").map((m) => m.content.split(" ")[0]));
    const allTurns = [...history, ...turns(2, "later")].map((m) => m.content.split(" ")[0]);
    const lost = allTurns.filter((t) => !summarized.has(t) && !liveNow.has(t));
    expect(lost).toEqual([]);
    expect(first.summarized).toBe(true);
  });

  it("counts the summary in TURNS, so the preamble cannot shift it", async () => {
    const d = deps();
    const memory: ChatMessage = { role: "system", content: "Known facts: …" };
    await applyConversationWindow(
      d,
      { projectId: "proj-1", conversation: conversation(), messages: [memory, ...turns(12)] },
      OPTS
    );
    // 12 turns, 4 live -> 8 aged. The stored count is 8, not 9: it does not include the preamble,
    // which was never summarized.
    expect(d.updateSummary).toHaveBeenCalledWith("proj-1", "conv-1", "ROLLING SUMMARY", 8);
  });

});
