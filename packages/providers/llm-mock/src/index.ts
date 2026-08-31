import type { ChatRequest, ChatStreamEvent, LLMProvider } from "@ai-platform/shared";

/**
 * Deterministic mock LLM provider — no external calls, no API key required.
 * Exists so the platform runs end-to-end with zero credentials (docs/26_DECISIONS.md ADR-010)
 * and so tests never hit paid APIs (docs/21_TESTING_STRATEGY.md).
 *
 * ADR-013: mock providers must refuse to activate in production so a missing real
 * API key can never silently serve mock responses in a live deployment.
 */
export class MockLLMProvider implements LLMProvider {
  readonly name = "mock";
  readonly isMock = true;

  constructor(private readonly tokenDelayMs = 20) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "MockLLMProvider cannot be instantiated when NODE_ENV=production (docs/26_DECISIONS.md ADR-013)."
      );
    }
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const lastUserMessage = [...request.messages].reverse().find((m) => m.role === "user");
    const reply = this.buildReply(lastUserMessage?.content ?? "");
    const words = reply.split(/(?<=\s)/);

    for (const word of words) {
      if (this.tokenDelayMs > 0) {
        await sleep(this.tokenDelayMs);
      }
      yield { type: "token", delta: word };
    }

    yield {
      type: "done",
      message: { role: "assistant", content: reply },
      usage: {
        inputTokens: estimateTokens(request.messages.map((m) => m.content).join(" ")),
        outputTokens: estimateTokens(reply),
      },
      provider: this.name,
      model: "mock-1",
    };
  }

  private buildReply(userText: string): string {
    if (!userText.trim()) {
      return "I didn't receive any message content. Try sending some text.";
    }
    return (
      `[mock response — no real LLM provider is configured] ` +
      `You said: "${userText.trim()}". ` +
      `Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY to talk to a real model instead.`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
