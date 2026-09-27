import { describe, expect, it, vi } from "vitest";
import {
  ValidationError,
  validateToolArguments,
  type ChatMessage,
  type ChatStreamEvent,
  type ToolCall,
  type ToolSpec,
} from "@ai-platform/shared";
import { runReasoningLoop, type ToolExecutionOutcome } from "./reasoning-loop.js";

/**
 * ADR-057. These tests exist to prove one specific claim, which the brief (§36, §37) says may
 * not be made unless it is true: **the model drives execution, not a hardcoded workflow.**
 *
 * The provider below is scripted, but it is scripted at the PROTOCOL level — it emits real
 * `tool_call` events and real `done` events with finish reasons, exactly as a live model
 * does. Nothing in the loop knows which tool will be chosen, how many turns will happen, or
 * when the run ends; every one of those is decided by what the provider emits. Swapping in a
 * live model changes only where the events come from.
 */

type Turn =
  | { kind: "text"; content: string }
  | { kind: "tools"; calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> };

/** A provider that replays scripted turns through the genuine event protocol. */
function scriptedProvider(turns: Turn[]) {
  const seenRequests: Array<{ messages: ChatMessage[]; tools?: ToolSpec[] }> = [];
  let index = 0;
  async function* streamChat(request: {
    messages: ChatMessage[];
    tools?: ToolSpec[];
  }): AsyncGenerator<ChatStreamEvent, void, unknown> {
    seenRequests.push({ messages: structuredClone(request.messages), tools: request.tools });
    const turn = turns[Math.min(index++, turns.length - 1)];
    if (turn.kind === "text") {
      for (const word of turn.content.split(" ")) yield { type: "token", delta: `${word} ` };
      yield {
        type: "done",
        message: { role: "assistant", content: turn.content },
        usage: { inputTokens: 10, outputTokens: 5 },
        provider: "scripted",
        model: "scripted-1",
        finishReason: "stop",
      };
      return;
    }
    for (const call of turn.calls) yield { type: "tool_call", call };
    yield {
      type: "done",
      message: { role: "assistant", content: "", toolCalls: turn.calls },
      usage: { inputTokens: 10, outputTokens: 5 },
      provider: "scripted",
      model: "scripted-1",
      finishReason: "tool_calls",
    };
  }
  return { streamChat, seenRequests };
}

const CALCULATOR: ToolSpec = {
  name: "calculator",
  description: "Evaluates an arithmetic expression.",
  inputSchema: {
    type: "object",
    properties: { expression: { type: "string" } },
    required: ["expression"],
    additionalProperties: false,
  },
};

describe("runReasoningLoop", () => {
  it("answers directly when the model asks for no tools", async () => {
    const provider = scriptedProvider([{ kind: "text", content: "Paris is the capital of France." }]);
    const executeTool = vi.fn();

    const result = await runReasoningLoop(
      { streamChat: provider.streamChat, tools: [CALCULATOR], executeTool },
      [{ role: "user", content: "What is the capital of France?" }]
    );

    expect(result.answer).toContain("Paris");
    expect(result.stopReason).toBe("answered");
    expect(executeTool).not.toHaveBeenCalled();
    // The tools were still OFFERED — the model chose not to use one, which is the point.
    expect(provider.seenRequests[0].tools?.map((t) => t.name)).toEqual(["calculator"]);
  });

  it("executes the tool the MODEL chose, feeds the result back, and lets it answer", async () => {
    const provider = scriptedProvider([
      { kind: "tools", calls: [{ id: "c1", name: "calculator", arguments: { expression: "17*23" } }] },
      { kind: "text", content: "17 times 23 is 391." },
    ]);
    const executeTool = vi.fn(async (_input: { call: ToolCall }): Promise<ToolExecutionOutcome> => ({
      ok: true,
      content: "391",
    }));

    const result = await runReasoningLoop(
      { streamChat: provider.streamChat, tools: [CALCULATOR], executeTool },
      [{ role: "user", content: "What is 17 times 23?" }]
    );

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0]?.[0].call).toMatchObject({ name: "calculator", arguments: { expression: "17*23" } });
    expect(result.answer).toContain("391");
    expect(result.toolCallCount).toBe(1);

    // The second model turn must have SEEN the tool result — that is what makes this a
    // reasoning loop rather than two unrelated calls.
    const secondTurn = provider.seenRequests[1].messages;
    const toolMessage = secondTurn.find((m) => m.role === "tool");
    expect(toolMessage?.toolCallId).toBe("c1");
    // The RESULT reaches the model — and it arrives delimited as untrusted data (ADR-133),
    // because this is the literal output of a tool and it is being read by a model that holds a
    // filesystem and a terminal.
    expect(toolMessage?.content).toContain("391");
    expect(toolMessage?.content).toMatch(/<untrusted_content>/);
    expect(secondTurn.some((m) => m.role === "assistant" && m.toolCalls?.[0]?.name === "calculator")).toBe(true);
  });

  it("chains several tool calls across turns, each informed by the last", async () => {
    const provider = scriptedProvider([
      { kind: "tools", calls: [{ id: "c1", name: "calculator", arguments: { expression: "2+2" } }] },
      { kind: "tools", calls: [{ id: "c2", name: "calculator", arguments: { expression: "4*10" } }] },
      { kind: "text", content: "The final answer is 40." },
    ]);
    const results = ["4", "40"];
    let call = 0;
    const executeTool = async (): Promise<ToolExecutionOutcome> => ({ ok: true, content: results[call++] });

    const result = await runReasoningLoop(
      { streamChat: provider.streamChat, tools: [CALCULATOR], executeTool },
      [{ role: "user", content: "Add two and two, then multiply by ten." }]
    );

    expect(result.toolCallCount).toBe(2);
    expect(result.answer).toContain("40");
    expect(provider.seenRequests).toHaveLength(3);
  });

  it("hands a tool FAILURE back to the model as an observation instead of aborting", async () => {
    const provider = scriptedProvider([
      { kind: "tools", calls: [{ id: "c1", name: "calculator", arguments: { expression: "1/0" } }] },
      { kind: "text", content: "That expression is undefined, so I cannot compute it." },
    ]);
    const executeTool = async (): Promise<ToolExecutionOutcome> => ({
      ok: false,
      content: "Error: division by zero",
    });

    const result = await runReasoningLoop(
      { streamChat: provider.streamChat, tools: [CALCULATOR], executeTool },
      [{ role: "user", content: "Compute 1/0" }]
    );

    expect(result.stopReason).toBe("answered");
    expect(result.answer).toContain("undefined");
    const toolMessage = provider.seenRequests[1].messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("division by zero");
  });

  it("pauses the run when a tool needs human approval, without executing it", async () => {
    const provider = scriptedProvider([
      { kind: "tools", calls: [{ id: "c1", name: "calculator", arguments: { expression: "1+1" } }] },
    ]);
    const events: string[] = [];
    const result = await runReasoningLoop(
      {
        streamChat: provider.streamChat,
        tools: [CALCULATOR],
        executeTool: async () => ({ ok: false, content: "", awaitingApproval: true }),
        onEvent: (e) => events.push(e.type),
      },
      [{ role: "user", content: "Do the thing" }]
    );
    expect(result.stopReason).toBe("awaiting_approval");
    expect(events).toContain("awaiting_approval");
  });

  it("stops at the iteration ceiling even if the model would keep calling tools forever", async () => {
    // A model that never stops asking for tools — the classic runaway agent.
    const provider = scriptedProvider([
      { kind: "tools", calls: [{ id: "c", name: "calculator", arguments: { expression: "1+1" } }] },
    ]);
    const result = await runReasoningLoop(
      {
        streamChat: provider.streamChat,
        tools: [CALCULATOR],
        executeTool: async () => ({ ok: true, content: "2" }),
      },
      [{ role: "user", content: "loop forever" }],
      { maxIterations: 4 }
    );
    expect(result.stopReason).toBe("max_iterations");
    expect(result.toolCallCount).toBe(4);
  });

  it("stops when the token budget is exhausted", async () => {
    const provider = scriptedProvider([
      { kind: "tools", calls: [{ id: "c", name: "calculator", arguments: { expression: "1+1" } }] },
    ]);
    const result = await runReasoningLoop(
      {
        streamChat: provider.streamChat,
        tools: [CALCULATOR],
        executeTool: async () => ({ ok: true, content: "2" }),
      },
      [{ role: "user", content: "spend it all" }],
      { maxIterations: 100, maxTotalTokens: 40 }
    );
    expect(result.stopReason).toBe("budget_exhausted");
    // 15 tokens per turn; the run must stop at the budget, not at 100 iterations.
    expect(result.usage.inputTokens + result.usage.outputTokens).toBeGreaterThanOrEqual(40);
  });

  it("stops promptly when cancelled", async () => {
    const controller = new AbortController();
    const provider = scriptedProvider([
      { kind: "tools", calls: [{ id: "c", name: "calculator", arguments: { expression: "1+1" } }] },
    ]);
    const result = await runReasoningLoop(
      {
        streamChat: provider.streamChat,
        tools: [CALCULATOR],
        executeTool: async () => {
          controller.abort();
          return { ok: true, content: "2" };
        },
      },
      [{ role: "user", content: "cancel me" }],
      { maxIterations: 50, signal: controller.signal }
    );
    expect(result.stopReason).toBe("cancelled");
  });

  it("runs exactly one self-correction round when verification fails, then accepts", async () => {
    const provider = scriptedProvider([
      { kind: "text", content: "The answer is 42." },
      { kind: "text", content: "Corrected: the answer is 391." },
    ]);
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "does not match the computed value" })
      .mockResolvedValue({ ok: true });

    const result = await runReasoningLoop(
      { streamChat: provider.streamChat, tools: [], executeTool: async () => ({ ok: true, content: "" }), verify },
      [{ role: "user", content: "What is 17*23?" }]
    );

    expect(result.answer).toContain("391");
    expect(result.stopReason).toBe("answered");
    // The correction prompt must actually reach the model.
    const secondTurn = provider.seenRequests[1].messages;
    expect(secondTurn.some((m) => m.role === "user" && m.content.includes("did not pass verification"))).toBe(true);
  });

  it("marks a truncated turn instead of presenting it as a complete answer", async () => {
    async function* truncated(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      yield {
        type: "done",
        message: { role: "assistant", content: "This answer was cut off mid-" },
        usage: { inputTokens: 1, outputTokens: 1 },
        provider: "scripted",
        model: "m",
        finishReason: "length",
      };
    }
    const result = await runReasoningLoop(
      { streamChat: truncated, tools: [], executeTool: async () => ({ ok: true, content: "" }) },
      [{ role: "user", content: "write a lot" }]
    );
    expect(result.answer).toContain("output limit");
  });
});

/**
 * The tool-argument validator. Before ADR-059 `inputSchema` was decorative — nothing checked
 * a model's arguments against it, which matters far more once a model is choosing them.
 */
describe("validateToolArguments", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string", maxLength: 10 },
      count: { type: "integer", minimum: 1, maximum: 5 },
      mode: { type: "string", enum: ["fast", "slow"] },
      nested: { type: "object", properties: { flag: { type: "boolean" } }, required: ["flag"] },
      items: { type: "array", items: { type: "string" } },
    },
    required: ["path"],
    additionalProperties: false,
  };

  it("accepts valid arguments", () => {
    expect(() =>
      validateToolArguments(schema, { path: "a.txt", count: 3, mode: "fast", items: ["x"] })
    ).not.toThrow();
  });

  it("rejects a missing required field", () => {
    expect(() => validateToolArguments(schema, { count: 1 })).toThrow(/path is required/);
  });

  it("rejects a wrong type, naming the path", () => {
    expect(() => validateToolArguments(schema, { path: 42 })).toThrow(/path must be of type "string"/);
  });

  it("rejects a non-integer for an integer field", () => {
    expect(() => validateToolArguments(schema, { path: "a", count: 1.5 })).toThrow(/count must be of type "integer"/);
  });

  it("enforces enum, bounds and maxLength", () => {
    expect(() => validateToolArguments(schema, { path: "a", mode: "medium" })).toThrow(/must be one of/);
    expect(() => validateToolArguments(schema, { path: "a", count: 99 })).toThrow(/must be <= 5/);
    expect(() => validateToolArguments(schema, { path: "waaaaaaaaaaaay-too-long" })).toThrow(/at most 10/);
  });

  it("rejects an unknown parameter when additionalProperties is false", () => {
    expect(() => validateToolArguments(schema, { path: "a", surprise: 1 })).toThrow(/not a recognised parameter/);
  });

  it("validates nested objects and array items", () => {
    expect(() => validateToolArguments(schema, { path: "a", nested: {} })).toThrow(/nested.flag is required/);
    expect(() => validateToolArguments(schema, { path: "a", items: ["ok", 5] })).toThrow(/items\[1\] must be of type/);
  });

  it("throws ValidationError specifically, so callers can distinguish it", () => {
    expect(() => validateToolArguments(schema, {})).toThrow(ValidationError);
  });
});

/**
 * The real run this guards: qwen2.5:7b ended three turns with a call written as text — a stray
 * token where `<tool_call>` belonged — and each was taken as a final answer.
 */
describe("runReasoningLoop recovers a tool call the model wrote as text", () => {
  const RECORDED =
    "It appears that even after applying the patch, the test is still failing.\n\n Ronaldo\n" +
    '{"name": "calculator", "arguments": {"expression": "17*23"}}\n</tool_call>';

  it("runs it through the ordinary call path and lets the model answer from the result", async () => {
    const provider = scriptedProvider([
      { kind: "text", content: RECORDED },
      { kind: "text", content: "17 times 23 is 391." },
    ]);
    const executeTool = vi.fn(async (_input: { call: ToolCall }): Promise<ToolExecutionOutcome> => ({ ok: true, content: "391" }));

    const result = await runReasoningLoop({ streamChat: provider.streamChat, tools: [CALCULATOR], executeTool }, [
      { role: "user", content: "What is 17*23?" },
    ]);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][0].call).toMatchObject({ name: "calculator", arguments: { expression: "17*23" } });
    expect(result.answer).toBe("17 times 23 is 391.");
    // The provider saw the call as a call on the next turn, with its result after it.
    const next = provider.seenRequests[1].messages;
    expect(next.some((m) => m.role === "assistant" && m.toolCalls?.[0]?.name === "calculator")).toBe(true);
    expect(next.some((m) => m.role === "tool")).toBe(true);
  });

  it("does not run a tool that was not offered, or text that merely looks like JSON", async () => {
    for (const content of [
      '{"name": "fs.delete_file", "arguments": {"path": "x"}}',
      'The config is {"name": "calculator"} with no arguments.',
      'Here is an example: {"name": "calculator", "arguments": "17*23"}',
    ]) {
      const provider = scriptedProvider([{ kind: "text", content }]);
      const executeTool = vi.fn();
      const result = await runReasoningLoop({ streamChat: provider.streamChat, tools: [CALCULATOR], executeTool }, [
        { role: "user", content: "hi" },
      ]);
      expect(executeTool, content).not.toHaveBeenCalled();
      expect(result.stopReason).toBe("answered");
    }
  });
});
