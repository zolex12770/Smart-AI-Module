import type { ChatMessage, ChatRequest, ChatStreamEvent, LLMProvider } from "@ai-platform/shared";
import { ProviderError, parseSseStream } from "@ai-platform/shared";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

export interface GoogleProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Injectable for tests — defaults to global fetch. See docs/21_TESTING_STRATEGY.md. */
  fetchImpl?: typeof fetch;
}

/**
 * Real adapter against the Gemini Developer API's `streamGenerateContent` endpoint
 * (docs/04_MODEL_PROVIDER_RESEARCH.md §3.2-3.4, docs/28_API_PROVIDER_MATRIX.md —
 * `generateContent` chosen over the newer Interactions API per that doc's explicit
 * recommendation: better documented today, lower migration risk). Vertex AI's
 * IAM/ADC-based auth path (docs/26_DECISIONS.md ADR-010, `GOOGLE_APPLICATION_CREDENTIALS`)
 * is NOT implemented by this adapter — only the API-key Developer API path
 * (`GOOGLE_API_KEY`/`GEMINI_API_KEY`) is. Built with `fetch` against the raw documented
 * shape, not the official SDK — docs/26_DECISIONS.md ADR-023.
 *
 * Verification status (honest — see the identical note in llm-anthropic/src/index.ts):
 * unit-tested against a fixture matching the documented `GenerateContentResponse` chunk
 * shape. A real network call was also made against the live
 * `https://generativelanguage.googleapis.com` endpoint with a deliberately invalid key —
 * it returned a real HTTP 400 (`"API key not valid."`) in Google's real error shape,
 * confirming this adapter reaches the real endpoint and model path correctly. The
 * success path (parsing a real streamed response) is still unverified — required
 * follow-up once a real GOOGLE_API_KEY is available (PROJECT_STATUS.md).
 */
export class GoogleProvider implements LLMProvider {
  readonly name = "google";
  readonly isMock = false;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GoogleProviderOptions) {
    if (!options.apiKey) {
      throw new Error("GoogleProvider requires an apiKey (GOOGLE_API_KEY or GEMINI_API_KEY).");
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gemini-3.5-flash";
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const model = request.model ?? this.model;
    const { systemInstruction, contents } = toGeminiContents(request.messages);

    const res = await this.fetchImpl(
      `${this.baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": this.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contents,
          ...(systemInstruction ? { systemInstruction } : {}),
        }),
      }
    );

    if (!res.ok || !res.body) {
      const bodyText = await safeReadText(res);
      throw new ProviderError(`Google Gemini API request failed (${res.status}): ${truncate(bodyText)}`);
    }

    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;

    // Google's SSE has no typed micro-events (docs/04 §3.4) — each `data:` frame is a
    // full, growing GenerateContentResponse chunk; there is no explicit stream-end
    // sentinel, so `done` is yielded once the underlying HTTP stream closes.
    for await (const { data } of parseSseStream(res.body)) {
      if (!data) continue;
      let payload: GenerateContentResponseChunk;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }

      const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (text) {
        content += text;
        yield { type: "token", delta: text };
      }
      if (payload.usageMetadata) {
        inputTokens = payload.usageMetadata.promptTokenCount ?? inputTokens;
        outputTokens = payload.usageMetadata.candidatesTokenCount ?? outputTokens;
      }
      if (payload.error) {
        throw new ProviderError(`Google Gemini stream error: ${payload.error.message ?? "unknown error"}`);
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

function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction: { parts: [{ text: string }] } | undefined;
  contents: Array<{ role: "user" | "model"; parts: [{ text: string }] }>;
} {
  const systemMessages = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  return {
    systemInstruction:
      systemMessages.length > 0
        ? { parts: [{ text: systemMessages.map((m) => m.content).join("\n\n") }] }
        : undefined,
    // Gemini uses "model" where our schema uses "assistant" — the one role-name
    // divergence among the three providers.
    contents: rest.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
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

interface GenerateContentResponseChunk {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}
