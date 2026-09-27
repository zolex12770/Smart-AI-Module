import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatStreamEvent, ToolSpec } from "@ai-platform/shared";
import {
  ContextWindowExceededError,
  estimateTokens,
  fitToContextWindow,
  runReasoningLoop,
} from "./reasoning-loop.js";

/**
 * Keeping an agent's prompt inside the model's context window.
 *
 * Found in a real run: qwen2.5:7b on Ollama's default 4096-token window. The agent's prompt
 * outgrew the window within a few turns and llama.cpp discarded its oldest 2045 tokens — the
 * system prompt and the goal — without an error. These tests pin the harness's replacement:
 * the goal survives, old tool output goes first, and an impossible fit fails loudly.
 */
const tool: ToolSpec = {
  name: "fs.read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

const GOAL = "A test in this workspace is failing. Fix the code so that it passes.";

function transcriptWithOutputs(outputs: string[]): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: "You are the platform's agent." },
    { role: "user", content: GOAL },
  ];
  outputs.forEach((out, i) => {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [{ id: `c${i}`, name: "fs.read_file", arguments: { path: `f${i}.js` } }],
    });
    messages.push({ role: "tool", content: out, toolCallId: `c${i}`, name: "fs.read_file" });
  });
  return messages;
}

const promptTokens = (messages: ChatMessage[]) =>
  estimateTokens(JSON.stringify([tool])) +
  messages.reduce((n, m) => n + 8 + estimateTokens(m.content ?? "") + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls)) : 0), 0);

describe("fitToContextWindow", () => {
  it("returns the transcript untouched when it already fits", () => {
    const transcript = transcriptWithOutputs(["small"]);
    expect(fitToContextWindow(transcript, [tool], 4000, 4096)).toBe(transcript);
  });

  it("elides the OLDEST tool outputs first and keeps the goal and the latest turn", () => {
    const big = "x".repeat(6000); // ~2000 tokens each
    const transcript = transcriptWithOutputs([`OLDEST ${big}`, `MIDDLE ${big}`, `LATEST ${big}`]);
    const fitted = fitToContextWindow(transcript, [tool], 3000, 4096);

    expect(promptTokens(fitted)).toBeLessThanOrEqual(3000);
    expect(fitted[0].content).toBe("You are the platform's agent.");
    expect(fitted[1].content).toBe(GOAL);
    const tools = fitted.filter((m) => m.role === "tool");
    expect(tools[0].content).toMatch(/^\[Earlier tool output elided .*4096-token context window/);
    expect(tools[2].content.startsWith("LATEST")).toBe(true);
    // The calls themselves stay, so the model still knows what it did.
    expect(fitted.filter((m) => m.toolCalls).length).toBe(3);
    // The record is not rewritten.
    expect(transcript[3].content.startsWith("OLDEST")).toBe(true);
  });

  it("cuts an oversized LATEST output to its head and tail when eliding the older ones is not enough", () => {
    const transcript = transcriptWithOutputs([`HEAD ${"y".repeat(20000)} TAIL`]);
    const fitted = fitToContextWindow(transcript, [tool], 2000, 4096);
    const latest = fitted.at(-1)!.content;
    expect(promptTokens(fitted)).toBeLessThanOrEqual(2000);
    expect(latest.startsWith("HEAD")).toBe(true);
    expect(latest.endsWith("TAIL")).toBe(true);
    expect(latest).toMatch(/characters elided to fit/);
  });

  it("throws, rather than truncating, when even the goal does not fit", () => {
    const transcript: ChatMessage[] = [{ role: "user", content: "z".repeat(30000) }];
    expect(() => fitToContextWindow(transcript, [tool], 1000, 2048)).toThrow(ContextWindowExceededError);
    expect(() => fitToContextWindow(transcript, [tool], 1000, 2048)).toThrow(/context window is 2048 tokens/);
  });
});

describe("runReasoningLoop with a context window", () => {
  it("sends every turn inside the window and reserves room for the reply", async () => {
    const sent: { tokens: number; maxOutputTokens?: number; hasGoal: boolean }[] = [];
    let turn = 0;
    const result = await runReasoningLoop(
      {
        tools: [tool],
        async *streamChat(request): AsyncGenerator<ChatStreamEvent> {
          sent.push({
            tokens: promptTokens(request.messages),
            maxOutputTokens: request.maxOutputTokens,
            hasGoal: request.messages.some((m) => m.content === GOAL),
          });
          turn++;
          const message: ChatMessage =
            turn < 5
              ? { role: "assistant", content: "", toolCalls: [{ id: `c${turn}`, name: "fs.read_file", arguments: { path: "a" } }] }
              : { role: "assistant", content: "done" };
          yield { type: "done", message, usage: { inputTokens: 1, outputTokens: 1 }, provider: "p", model: "m", finishReason: "stop" };
        },
        // Every file read returns ~1700 tokens: four of them cannot fit a 4096 window.
        executeTool: async () => ({ ok: true, content: "w".repeat(5000) }),
      },
      [
        { role: "system", content: "You are the platform's agent." },
        { role: "user", content: GOAL },
      ],
      { contextWindow: 4096, maxOutputTokensPerTurn: 4096 }
    );

    expect(result.stopReason).toBe("answered");
    expect(sent).toHaveLength(5);
    for (const turnSent of sent) {
      expect(turnSent.maxOutputTokens).toBe(1024);
      expect(turnSent.tokens).toBeLessThanOrEqual(4096 - 1024);
      expect(turnSent.hasGoal).toBe(true);
    }
    // The full record is kept for persistence and audit.
    expect(result.transcript.filter((m) => m.role === "tool").every((m) => m.content.includes("w".repeat(100)))).toBe(true);
  });

  it("changes nothing when the window is unknown", async () => {
    let seen: ChatMessage[] = [];
    await runReasoningLoop(
      {
        tools: [],
        async *streamChat(request): AsyncGenerator<ChatStreamEvent> {
          seen = request.messages;
          yield {
            type: "done",
            message: { role: "assistant", content: "ok" },
            usage: { inputTokens: 1, outputTokens: 1 },
            provider: "p",
            model: "m",
            finishReason: "stop",
          };
        },
        executeTool: async () => ({ ok: true, content: "" }),
      },
      [{ role: "user", content: "q".repeat(100000) }]
    );
    expect(seen[0].content).toHaveLength(100000);
  });
});

describe("runReasoningLoop correction rounds", () => {
  const answering = (texts: string[]) => {
    let i = 0;
    return async function* (): AsyncGenerator<ChatStreamEvent> {
      const text = texts[Math.min(i++, texts.length - 1)];
      yield { type: "done", message: { role: "assistant", content: text }, usage: { inputTokens: 1, outputTokens: 1 }, provider: "p", model: "m", finishReason: "stop" };
    };
  };

  it("allows one correction by default, and still reports the verdict on the corrected answer", async () => {
    let checks = 0;
    const result = await runReasoningLoop(
      { tools: [], streamChat: answering(["a", "b", "c", "d"]), executeTool: async () => ({ ok: true, content: "" }), verify: async () => ({ ok: false, reason: `check ${++checks}` }) },
      [{ role: "user", content: GOAL }]
    );
    expect(result.iterations).toBe(2);
    // The corrected answer is checked too; its failure is reported, not hidden.
    expect(checks).toBe(2);
    expect(result.verification).toEqual({ ok: false, reason: "check 2" });
  });

  it("allows up to maxCorrections when the caller's check is deterministic", async () => {
    let checks = 0;
    const result = await runReasoningLoop(
      { tools: [], streamChat: answering(["a", "b", "c", "d", "e"]), executeTool: async () => ({ ok: true, content: "" }), verify: async () => ({ ok: ++checks >= 4, reason: "still failing" }) },
      [{ role: "user", content: GOAL }],
      { maxCorrections: 3 }
    );
    expect(checks).toBe(4);
    expect(result.stopReason).toBe("answered");
    expect(result.verification?.ok).toBe(true);
  });
});
