import type { ChatMessage, ChatRequest, ChatStreamEvent, LLMProvider } from "@ai-platform/shared";
import { ProviderError, parseSseStream } from "@ai-platform/shared";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Injectable for tests — defaults to global fetch. See docs/21_TESTING_STRATEGY.md. */
  fetchImpl?: typeof fetch;
}

/**
 * Real adapter against Anthropic's Messages API (docs/04_MODEL_PROVIDER_RESEARCH.md §1,
 * docs/28_API_PROVIDER_MATRIX.md). Built against the raw documented HTTP/SSE shape with
 * `fetch`, not the official SDK — see docs/26_DECISIONS.md ADR-023 for why.
 *
 * Verification status (honest, per docs/00_PROJECT_VISION.md's principles): request
 * construction and SSE response parsing are unit-tested against fixture payloads
 * matching the documented format (index.test.ts). Additionally, a real network call was
 * made against the live `https://api.anthropic.com/v1/messages` endpoint with a
 * deliberately invalid key (no real key exists in this environment) — it returned a real
 * HTTP 401 in exactly the documented error shape (`{"type":"error","error":{"type":
 * "authentication_error",...}}`), confirming this adapter reaches the real endpoint and
 * constructs a request the real API understands well enough to parse and reject
 * correctly. That does NOT confirm the success path (parsing a real streamed response)
 * works — only a valid key can verify that, tracked as a required follow-up in
 * PROJECT_STATUS.md. Do not treat this as equivalent to full live verification.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly isMock = false;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) {
      throw new Error("AnthropicProvider requires an apiKey (ANTHROPIC_API_KEY).");
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? "claude-sonnet-5";
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const { system, messages } = splitSystemMessage(request.messages);

    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model ?? this.model,
        max_tokens: 4096,
        ...(system ? { system } : {}),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      const bodyText = await safeReadText(res);
      throw new ProviderError(`Anthropic API request failed (${res.status}): ${truncate(bodyText)}`);
    }

    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let model = this.model;

    for await (const { event, data } of parseSseStream(res.body)) {
      if (!data) continue;
      let payload: AnthropicSseEventPayload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }

      switch (event ?? payload.type) {
        case "message_start":
          inputTokens = payload.message?.usage?.input_tokens ?? 0;
          model = payload.message?.model ?? model;
          break;
        case "content_block_delta":
          if (payload.delta?.type === "text_delta" && payload.delta.text) {
            content += payload.delta.text;
            yield { type: "token", delta: payload.delta.text };
          }
          break;
        case "message_delta":
          outputTokens = payload.usage?.output_tokens ?? outputTokens;
          break;
        case "error":
          throw new ProviderError(`Anthropic stream error: ${payload.error?.message ?? "unknown error"}`);
        case "message_stop":
          yield {
            type: "done",
            message: { role: "assistant", content },
            usage: { inputTokens, outputTokens },
            provider: this.name,
            model,
          };
          return;
      }
    }

    // Stream ended without an explicit message_stop — still surface what we got rather
    // than silently dropping it, but this is an unexpected shape worth investigating.
    yield {
      type: "done",
      message: { role: "assistant", content },
      usage: { inputTokens, outputTokens },
      provider: this.name,
      model,
    };
  }
}

function splitSystemMessage(messages: ChatMessage[]): { system: string | undefined; messages: ChatMessage[] } {
  const systemMessages = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  return {
    system: systemMessages.length > 0 ? systemMessages.map((m) => m.content).join("\n\n") : undefined,
    messages: rest,
  };
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(could not read response body)";
  }
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

interface AnthropicSseEventPayload {
  type?: string;
  message?: { usage?: { input_tokens?: number }; model?: string };
  delta?: { type?: string; text?: string; output_tokens?: number };
  usage?: { output_tokens?: number };
  error?: { message?: string };
}
