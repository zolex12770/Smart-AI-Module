import {
  ProviderError,
  type ChatMessage,
  type ChatStreamEvent,
  type ToolCall,
  type ToolSpec,
} from "@ai-platform/shared";

/**
 * The model-driven agent loop — docs/26_DECISIONS.md ADR-057, implementing §5 of the product
 * brief.
 *
 * Everything the agent does between "here is a request" and "here is an answer" is decided
 * by the model, not by this file. The loop's only job is to be the safe, observable harness
 * around that decision:
 *
 *   observe -> model reasons -> model may call tools -> execute under policy -> observe
 *   result -> model reasons again -> ... -> model answers -> verify -> maybe correct
 *
 * What the MODEL decides: whether a tool is needed at all, which one, with what arguments,
 * whether the result is sufficient, whether to call another tool, when the task is done, and
 * how to recover from a tool error.
 *
 * What the HARNESS decides (and the model cannot override): the iteration ceiling, the token
 * budget, which tools exist and whether the caller may use them, whether a call needs human
 * approval, argument validity against the tool's schema, execution isolation, and
 * cancellation. This is the split the brief asks for — AI drives execution; the deterministic
 * engine enforces safety, budgets, permissions and invariants.
 *
 * A tool *error* is deliberately fed back to the model as an observation rather than
 * terminating the run: recovering from a failed call is exactly the reasoning we want the
 * model to do. Only harness-level failures (budget, cancellation, provider outage) stop it.
 */

export interface ToolExecutionRequest {
  call: ToolCall;
  iteration: number;
}

export interface ToolExecutionOutcome {
  /** Content handed back to the model as the `tool` message. */
  content: string;
  ok: boolean;
  /** Set when the harness paused the run for human approval instead of executing. */
  awaitingApproval?: boolean;
}

export interface ReasoningLoopDeps {
  /** Streams one model turn. Tools are passed through to the provider (ADR-047). */
  streamChat(request: {
    messages: ChatMessage[];
    tools?: ToolSpec[];
    toolChoice?: "auto" | "none" | "required";
    maxOutputTokens?: number;
  }): AsyncGenerator<ChatStreamEvent, void, unknown>;
  /** The tools this specific caller is allowed to see. Authorization happens before here. */
  tools: ToolSpec[];
  /** Executes one call under policy: schema validation, approval, isolation, timeout. */
  executeTool(request: ToolExecutionRequest): Promise<ToolExecutionOutcome>;
  /** Optional final check on the answer; returning a reason triggers one correction round. */
  verify?(answer: string, transcript: ChatMessage[]): Promise<{ ok: boolean; reason?: string }>;
  /** Progress for SSE/observability. Must never throw. */
  onEvent?(event: ReasoningEvent): void;
}

export type ReasoningEvent =
  | { type: "iteration"; iteration: number }
  | { type: "token"; delta: string }
  | { type: "tool_call"; call: ToolCall; iteration: number }
  | { type: "tool_result"; callId: string; ok: boolean; content: string; iteration: number }
  | { type: "awaiting_approval"; call: ToolCall; iteration: number }
  | { type: "verification"; ok: boolean; reason?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number };

export interface ReasoningLoopOptions {
  /** Hard ceiling on model turns. The model cannot raise it. */
  maxIterations?: number;
  /** Hard ceiling on total tokens across the whole run. */
  maxTotalTokens?: number;
  maxOutputTokensPerTurn?: number;
  signal?: AbortSignal;
}

export interface ReasoningResult {
  answer: string;
  transcript: ChatMessage[];
  iterations: number;
  usage: { inputTokens: number; outputTokens: number };
  toolCallCount: number;
  stopReason: "answered" | "max_iterations" | "budget_exhausted" | "cancelled" | "awaiting_approval";
  verification?: { ok: boolean; reason?: string };
}

const DEFAULTS = { maxIterations: 12, maxTotalTokens: 200_000, maxOutputTokensPerTurn: 4096 };

export async function runReasoningLoop(
  deps: ReasoningLoopDeps,
  initialMessages: ChatMessage[],
  options: ReasoningLoopOptions = {}
): Promise<ReasoningResult> {
  const maxIterations = options.maxIterations ?? DEFAULTS.maxIterations;
  const maxTotalTokens = options.maxTotalTokens ?? DEFAULTS.maxTotalTokens;
  const maxOutputTokens = options.maxOutputTokensPerTurn ?? DEFAULTS.maxOutputTokensPerTurn;

  const transcript: ChatMessage[] = [...initialMessages];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let toolCallCount = 0;
  let correctionUsed = false;
  const emit = (event: ReasoningEvent) => {
    try {
      deps.onEvent?.(event);
    } catch {
      /* observability must never break execution */
    }
  };

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (options.signal?.aborted) {
      return finish("cancelled");
    }
    if (usage.inputTokens + usage.outputTokens >= maxTotalTokens) {
      return finish("budget_exhausted");
    }
    emit({ type: "iteration", iteration });

    // --- one model turn ------------------------------------------------------------------
    let assistantContent = "";
    const pendingCalls: ToolCall[] = [];
    let sawDone = false;

    for await (const event of deps.streamChat({
      messages: transcript,
      tools: deps.tools.length > 0 ? deps.tools : undefined,
      toolChoice: deps.tools.length > 0 ? "auto" : undefined,
      maxOutputTokens,
    })) {
      if (options.signal?.aborted) return finish("cancelled");
      switch (event.type) {
        case "token":
          assistantContent += event.delta;
          emit({ type: "token", delta: event.delta });
          break;
        case "tool_call":
          pendingCalls.push(event.call);
          break;
        case "error":
          throw new ProviderError(event.message);
        case "done":
          sawDone = true;
          usage.inputTokens += event.usage.inputTokens;
          usage.outputTokens += event.usage.outputTokens;
          emit({ type: "usage", inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens });
          // The provider is authoritative about what it actually produced.
          assistantContent = event.message.content || assistantContent;
          if (event.message.toolCalls?.length) {
            pendingCalls.length = 0;
            pendingCalls.push(...event.message.toolCalls);
          }
          // A truncated answer must never be presented as a finished one.
          if (event.finishReason === "length") {
            assistantContent +=
              "\n\n[The model hit its output limit before finishing this turn.]";
          }
          break;
      }
    }

    if (!sawDone) {
      throw new ProviderError("The model stream ended without a completion event.");
    }

    transcript.push({
      role: "assistant",
      content: assistantContent,
      ...(pendingCalls.length > 0 ? { toolCalls: pendingCalls } : {}),
    });

    // --- the model asked to act ----------------------------------------------------------
    if (pendingCalls.length > 0) {
      for (const call of pendingCalls) {
        if (options.signal?.aborted) return finish("cancelled");
        emit({ type: "tool_call", call, iteration });
        toolCallCount++;

        let outcome: ToolExecutionOutcome;
        try {
          outcome = await deps.executeTool({ call, iteration });
        } catch (err) {
          // A harness failure while executing is still an observation the model can use;
          // only a thrown ValidationError about the loop itself would be fatal.
          outcome = {
            ok: false,
            content: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        if (outcome.awaitingApproval) {
          emit({ type: "awaiting_approval", call, iteration });
          return finish("awaiting_approval");
        }

        emit({ type: "tool_result", callId: call.id, ok: outcome.ok, content: outcome.content, iteration });
        transcript.push({
          role: "tool",
          content: outcome.content,
          toolCallId: call.id,
          name: call.name,
        });
      }
      // Loop again so the model can reason about what it just learned.
      continue;
    }

    // --- the model answered ---------------------------------------------------------------
    if (deps.verify && !correctionUsed) {
      const verdict = await deps.verify(assistantContent, transcript);
      emit({ type: "verification", ok: verdict.ok, reason: verdict.reason });
      if (!verdict.ok) {
        // Self-correction: hand the model its own failure and let it fix the answer. One
        // round only — an unbounded correct-then-recheck cycle is how agents burn budget.
        correctionUsed = true;
        transcript.push({
          role: "user",
          content:
            `Your previous answer did not pass verification: ${verdict.reason ?? "unspecified"}. ` +
            `Correct it. If a tool is needed to establish the facts, call it.`,
        });
        continue;
      }
      return finish("answered", verdict);
    }

    return finish("answered");
  }

  return finish("max_iterations");

  function finish(
    stopReason: ReasoningResult["stopReason"],
    verification?: { ok: boolean; reason?: string }
  ): ReasoningResult {
    const lastAssistant = [...transcript].reverse().find((m) => m.role === "assistant" && m.content);
    return {
      answer: lastAssistant?.content ?? "",
      transcript,
      iterations: transcript.filter((m) => m.role === "assistant").length,
      usage,
      toolCallCount,
      stopReason,
      verification,
    };
  }
}
