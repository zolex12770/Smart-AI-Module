import type { ChatRequest, ChatStreamEvent, LLMProvider } from "@ai-platform/shared";
import { ProviderError, parseSseStream } from "@ai-platform/shared";

const DEFAULT_BASE_URL = "https://api.openai.com";

export interface OpenAIProviderOptions {
  apiKey: string;
  model?: string;
  organizationId?: string;
  projectId?: string;
  baseUrl?: string;
  /** Injectable for tests — defaults to global fetch. See docs/21_TESTING_STRATEGY.md. */
  fetchImpl?: typeof fetch;
}

/**
 * Real adapter against OpenAI's Responses API (docs/04_MODEL_PROVIDER_RESEARCH.md §2,
 * docs/28_API_PROVIDER_MATRIX.md — Responses chosen over Chat Completions per that doc's
 * explicit recommendation: it's the forward-looking surface and its typed streaming
 * events are cheaper to normalize than Chat Completions' raw delta chunks). Built with
 * `fetch` against the raw documented shape, not the official SDK — docs/26_DECISIONS.md
 * ADR-023.
 *
 * Verification status (honest — see the identical note in llm-anthropic/src/index.ts):
 * unit-tested against a fixture matching the documented event names
 * (`response.output_text.delta`, `response.completed`); the exact field layout of those
 * events was reconstructed from docs/04_MODEL_PROVIDER_RESEARCH.md's description rather
 * than a captured real payload. A real network call was also made against the live
 * `https://api.openai.com/v1/responses` endpoint with a deliberately invalid key — it
 * returned a real HTTP 401 in OpenAI's real error shape, confirming this adapter reaches
 * the real endpoint correctly. The success path (parsing a real streamed response) is
 * still unverified — required follow-up once a real OPENAI_API_KEY is available
 * (PROJECT_STATUS.md).
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  readonly isMock = false;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly organizationId?: string;
  private readonly projectId?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIProviderOptions) {
    if (!options.apiKey) {
      throw new Error("OpenAIProvider requires an apiKey (OPENAI_API_KEY).");
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gpt-5.6-terra";
    this.organizationId = options.organizationId;
    this.projectId = options.projectId;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
    if (this.organizationId) headers["OpenAI-Organization"] = this.organizationId;
    if (this.projectId) headers["OpenAI-Project"] = this.projectId;

    const res = await this.fetchImpl(`${this.baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: request.model ?? this.model,
        input: request.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      const bodyText = await safeReadText(res);
      throw new ProviderError(`OpenAI API request failed (${res.status}): ${truncate(bodyText)}`);
    }

    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let model = this.model;

    for await (const { event, data } of parseSseStream(res.body)) {
      if (!data || data === "[DONE]") continue;
      let payload: OpenAIResponseEventPayload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }

      const type = event ?? payload.type;
      if (type === "response.output_text.delta" && typeof payload.delta === "string") {
        content += payload.delta;
        yield { type: "token", delta: payload.delta };
      } else if (type === "response.completed") {
        inputTokens = payload.response?.usage?.input_tokens ?? inputTokens;
        outputTokens = payload.response?.usage?.output_tokens ?? outputTokens;
        model = payload.response?.model ?? model;
        yield {
          type: "done",
          message: { role: "assistant", content },
          usage: { inputTokens, outputTokens },
          provider: this.name,
          model,
        };
        return;
      } else if (type === "error") {
        throw new ProviderError(`OpenAI stream error: ${payload.message ?? "unknown error"}`);
      }
    }

    yield {
      type: "done",
      message: { role: "assistant", content },
      usage: { inputTokens, outputTokens },
      provider: this.name,
      model,
    };
  }
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

interface OpenAIResponseEventPayload {
  type?: string;
  delta?: string;
  response?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  message?: string;
}
