import {
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ChatStreamEvent,
  type FinishReason,
  type LLMProvider,
  type ProviderCapabilities,
  type ToolCall,
} from "@ai-platform/shared";

/**
 * Deterministic mock LLM provider — no external calls, no API key required.
 * Exists so the platform runs end-to-end with zero credentials (docs/26_DECISIONS.md ADR-010)
 * and so tests never hit paid APIs (docs/21_TESTING_STRATEGY.md).
 *
 * It speaks the real tool-calling protocol (ADR-047) so the agent loop
 * (packages/agent-core/src/reasoning-loop.ts) can be exercised in development and in tests
 * WITHOUT a real model — otherwise the one code path that most needs coverage would only
 * ever run against a paid API. Because a mock must never pretend to reason, the trigger is
 * an explicit, clearly-labelled directive rather than anything resembling a decision:
 *
 *   "look it up [[call:web_search {"query":"kites"}]]"  ->  tool call web_search({query:"kites"})
 *
 * The directive is honoured only when the caller actually offered tools and did not set
 * `toolChoice: "none"`. Once a tool result comes back, the mock answers with clearly-marked
 * mock text quoting that result, so the loop terminates after one round instead of calling
 * the same tool forever.
 *
 * ADR-013: mock providers must refuse to activate in production so a missing real
 * API key can never silently serve mock responses in a live deployment.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = "mock";
  readonly isMock = true;
  readonly model = "mock-1";

  constructor(private readonly tokenDelayMs = 20) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "MockLLMProvider cannot be instantiated when NODE_ENV=production (docs/26_DECISIONS.md ADR-013)."
      );
    }
  }

  /**
   * Honest about what this provider can and cannot do. `toolCalling` is true because the
   * scripted protocol above really does emit `tool_call` events the agent loop executes;
   * `structuredOutput` and `vision` are false because nothing here can constrain output to a
   * schema or read an image, and the router must not select the mock for work that needs
   * either (packages/model-router/src/registry.ts). `contextWindow` is null — "the adapter
   * cannot know" — since no context is ever sent anywhere.
   */
  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      structuredOutput: false,
      vision: false,
      contextWindow: null,
    };
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const lastUserIndex = findLastIndex(request.messages, (m) => m.role === "user");
    const lastUserMessage = lastUserIndex >= 0 ? request.messages[lastUserIndex] : undefined;
    // Tool results that arrived after the latest user turn — i.e. answers to calls this
    // provider already asked for in this same turn of the loop.
    const toolResults = request.messages
      .slice(lastUserIndex + 1)
      .filter((m): m is ChatMessage & { role: "tool" } => m.role === "tool");

    const toolsOffered = (request.tools?.length ?? 0) > 0 && request.toolChoice !== "none";
    const directives = toolsOffered && toolResults.length === 0
      ? parseCallDirectives(lastUserMessage?.content ?? "")
      : [];

    if (directives.length > 0) {
      const preface =
        `[mock tool call — no real model chose this] ` +
        `Honouring the scripted directive(s) in the last user message: ` +
        `${directives.map((d) => d.name).join(", ")}.`;
      yield* this.streamText(preface);
      for (const call of directives) {
        yield { type: "tool_call", call };
      }
      yield this.done(request, preface, "tool_calls", directives);
      return;
    }

    const reply = this.buildReply(lastUserMessage?.content ?? "", toolResults);
    yield* this.streamText(reply);
    yield this.done(request, reply, "stop");
  }

  private async *streamText(text: string): AsyncGenerator<ChatStreamEvent, void, unknown> {
    for (const word of text.split(/(?<=\s)/)) {
      if (this.tokenDelayMs > 0) {
        await sleep(this.tokenDelayMs);
      }
      yield { type: "token", delta: word };
    }
  }

  private done(
    request: ChatRequest,
    content: string,
    finishReason: FinishReason,
    toolCalls?: ToolCall[]
  ): ChatStreamEvent {
    return {
      type: "done",
      message: {
        role: "assistant",
        content,
        ...(toolCalls?.length ? { toolCalls } : {}),
      },
      usage: {
        inputTokens: estimateTokens(request.messages.map((m) => m.content).join(" ")),
        outputTokens: estimateTokens(content),
      },
      provider: this.name,
      model: this.model,
      finishReason,
    };
  }

  private buildReply(userText: string, toolResults: Array<ChatMessage & { role: "tool" }>): string {
    if (toolResults.length > 0) {
      // Quoting the result is what makes an end-to-end agent-loop assertion possible without
      // a real model: the answer provably depends on what the tool returned.
      return (
        `[mock response — no real model produced this answer] ` +
        `Tool result(s) received: ` +
        `${toolResults.map((r) => `${r.name ?? "tool"} -> ${r.content}`).join("; ")}.`
      );
    }
    if (!userText.trim()) {
      return "I didn't receive any message content. Try sending some text.";
    }
    return (
      // docs/26_DECISIONS.md ADR-044: this used to assert "no real LLM provider is
      // configured", which is FALSE in the case that matters most — a configured real
      // provider whose call failed, where ADR-024's fallback routes here. A user with a
      // valid-but-rate-limited key was told their key was missing. The wording below is
      // true in both cases and points at the log line that distinguishes them.
      `[mock response — no real model produced this answer] ` +
      `You said: "${userText.trim()}". ` +
      `If no ANTHROPIC_API_KEY, OPENAI_API_KEY or GOOGLE_API_KEY is set, set one to talk to a real model. ` +
      `If one IS set, the real provider call failed and the router fell back — look for a ` +
      `"provider call failed, falling back" line in the logs for the reason.`
    );
  }
}

/**
 * `[[call:<toolName> {json}]]` — the JSON object is optional and defaults to no arguments.
 * The tool name is NOT checked against the offered tools on purpose: passing an unknown name
 * straight through is how a test exercises the harness's own rejection path
 * (packages/tools' registry validates the name and the arguments before anything runs).
 */
const CALL_DIRECTIVE = /\[\[call:([A-Za-z0-9_.:-]+)\s*(\{[\s\S]*?\})?\]\]/g;

function parseCallDirectives(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const match of text.matchAll(CALL_DIRECTIVE)) {
    const [, name, rawArgs] = match;
    let args: Record<string, unknown> = {};
    if (rawArgs) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawArgs);
      } catch {
        // A malformed directive is an authoring mistake in a test or a dev prompt. Failing
        // loudly beats silently calling the tool with no arguments, which would look like a
        // model bug later.
        throw new ProviderError(
          `Mock tool-call directive for "${name}" has unparseable JSON arguments: ${rawArgs}`
        );
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ProviderError(
          `Mock tool-call directive for "${name}" must carry a JSON object, got: ${rawArgs}`
        );
      }
      args = parsed as Record<string, unknown>;
    }
    calls.push({ id: `mock-call-${calls.length + 1}`, name, arguments: args });
  }
  return calls;
}

/** `Array.prototype.findLastIndex` needs a newer lib target than tsconfig.base.json's ES2022. */
function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
