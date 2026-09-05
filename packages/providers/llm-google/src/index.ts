import {
  ProviderError,
  parseSseStream,
  type ChatMessage,
  type ChatRequest,
  type ChatStreamEvent,
  type FinishReason,
  type LLMProvider,
  type ProviderCapabilities,
  type ToolCall,
  type ToolChoice,
} from "@ai-platform/shared";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-3.5-flash";

/**
 * Documented context windows from docs/04_MODEL_PROVIDER_RESEARCH.md §3.1 (access date
 * 2026-08-31; the same "re-verify before relying on it" warning applies). A model absent
 * from this table reports `null` rather than a guess, because the router filters on this
 * number (packages/model-router/src/registry.ts) and a wrong one silently misroutes.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-3.1-pro-preview": 1_000_000,
  "gemini-3.7-flash": 1_000_000,
  "gemini-3.6-flash": 1_000_000,
  "gemini-3.5-flash": 1_000_000,
  "gemini-3.5-flash-lite": 1_000_000,
  "gemini-3.1-flash-lite": 1_000_000,
};

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
 * Tool calling is real here (ADR-047) in Gemini's own idiom (docs/04 §3.3): tools are
 * declared as `tools: [{functionDeclarations: [...]}]`, the model answers with
 * `{functionCall: {name, args}}` *parts* rather than a separate field, and our `tool` role
 * messages are mapped back to `{functionResponse: {name, response}}` parts. Parallel calls
 * are native — one candidate may carry several functionCall parts, and all of them are
 * emitted.
 *
 * Verification status (honest — see the identical note in llm-anthropic/src/index.ts):
 * unit-tested against a fixture matching the documented `GenerateContentResponse` chunk
 * shape, for text and for functionCall parts. A real network call was also made against the
 * live `https://generativelanguage.googleapis.com` endpoint with a deliberately invalid
 * key — it returned a real HTTP 400 (`"API key not valid."`) in Google's real error shape,
 * confirming this adapter reaches the real endpoint and model path correctly. The
 * success path (parsing a real streamed response) is still unverified — required
 * follow-up once a real GOOGLE_API_KEY is available (PROJECT_STATUS.md).
 */
export class GoogleProvider implements LLMProvider {
  readonly name = "google";
  readonly isMock = false;
  /** Public: the router records and logs which model a provider will actually call. */
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GoogleProviderOptions) {
    if (!options.apiKey) {
      throw new Error("GoogleProvider requires an apiKey (GOOGLE_API_KEY or GEMINI_API_KEY).");
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Declared so the router can refuse an impossible request up front rather than discover it
   * mid-stream (docs/12_MODEL_ROUTING.md §2). All Gemini 3.x models are multimodal by
   * default (docs/04 §3.1, §3.5) and support a constrained-JSON-Schema response format
   * (§3.6), so vision and structured output are honest here.
   */
  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      structuredOutput: true,
      vision: true,
      contextWindow: lookupContextWindow(this.model),
    };
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const model = request.model ?? this.model;
    const { systemInstruction, contents } = toGeminiContents(request.messages);

    const body: Record<string, unknown> = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
    };
    const generationConfig: Record<string, unknown> = {};
    if (request.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = request.maxOutputTokens;
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
    if (request.tools?.length) {
      // docs/04 §3.3 — one `tools` entry holding all functionDeclarations, each
      // {name, description, parameters} where parameters is a JSON-Schema subset.
      body.tools = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        },
      ];
      body.toolConfig = { functionCallingConfig: { mode: toGeminiFunctionCallingMode(request.toolChoice) } };
    }

    const res = await this.fetchImpl(
      `${this.baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": this.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    if (!res.ok || !res.body) {
      const bodyText = await safeReadText(res);
      throw new ProviderError(`Google Gemini API request failed (${res.status}): ${truncate(bodyText)}`);
    }

    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;
    // docs/26_DECISIONS.md ADR-045 — everything needed to tell a genuinely empty answer from
    // a swallowed failure. Gemini returns HTTP 200 for a safety block, an output-cap stop
    // with no emitted text, and a frame this parser could not read; without these, all three
    // ended as a `done` event with empty content, attributed to google, logged as a success.
    let sawUsage = false;
    let unparseableFrames = 0;
    let rawFinishReason: string | undefined;
    let blockReason: string | undefined;
    const toolCalls: ToolCall[] = [];

    // Google's SSE has no typed micro-events (docs/04 §3.4) — each `data:` frame is a
    // full, growing GenerateContentResponse chunk; there is no explicit stream-end
    // sentinel, so `done` is yielded once the underlying HTTP stream closes.
    for await (const { data } of parseSseStream(res.body)) {
      if (!data) continue;
      let payload: GenerateContentResponseChunk;
      try {
        payload = JSON.parse(data);
      } catch {
        unparseableFrames++;
        continue;
      }

      const parts = payload.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p) => p.text ?? "").join("");
      if (text) {
        content += text;
        yield { type: "token", delta: text };
      }
      // Unlike Anthropic and OpenAI, Gemini does not fragment tool arguments — each
      // functionCall part arrives whole, so a call can be emitted the moment it is seen.
      for (const part of parts) {
        if (!part.functionCall?.name) continue;
        const call: ToolCall = {
          // `generateContent` has no per-call id (the Interactions API added one, §3.2), so
          // the position in this turn is synthesised as a stable correlation key for the
          // functionResponse we send back.
          id: part.functionCall.id ?? `gemini-call-${toolCalls.length + 1}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        };
        toolCalls.push(call);
        yield { type: "tool_call", call };
      }
      if (payload.candidates?.[0]?.finishReason) rawFinishReason = payload.candidates[0].finishReason;
      if (payload.promptFeedback?.blockReason) blockReason = payload.promptFeedback.blockReason;
      if (payload.usageMetadata) {
        sawUsage = true;
        inputTokens = payload.usageMetadata.promptTokenCount ?? inputTokens;
        // Thinking tokens are billed as output but reported separately, so reading only
        // candidatesTokenCount undercounts both the usage ledger and the cost estimate on
        // every reasoning-capable model (ADR-045).
        outputTokens =
          (payload.usageMetadata.candidatesTokenCount ?? outputTokens) +
          (payload.usageMetadata.thoughtsTokenCount ?? 0);
      }
      if (payload.error) {
        throw new ProviderError(`Google Gemini stream error: ${payload.error.message ?? "unknown error"}`);
      }
    }

    let finishReason: FinishReason = blockReason
      ? "content_filter"
      : rawFinishReason
        ? mapFinishReason(rawFinishReason)
        : "unknown";
    // Gemini reports STOP for a turn that ended in functionCall parts, so the parts
    // themselves are the authoritative signal that the model wants to act.
    if (toolCalls.length > 0 && (finishReason === "stop" || finishReason === "unknown")) {
      finishReason = "tool_calls";
    }

    // A response that produced neither text nor a tool call is a failure, not an empty
    // success. Throwing here (rather than yielding an empty `done`) is what lets the router
    // fall back — and, since ADR-044, log why — instead of recording a 0-token "successful"
    // google call.
    if (!content && toolCalls.length === 0) {
      const why = blockReason
        ? `blocked by a safety filter (blockReason: ${blockReason})`
        : rawFinishReason && rawFinishReason !== "STOP"
          ? `stopped early (finishReason: ${rawFinishReason})`
          : unparseableFrames > 0
            ? `${unparseableFrames} stream frame(s) could not be parsed`
            : "the stream contained no text";
      throw new ProviderError(`Google Gemini returned no content: ${why} (finish reason: ${finishReason}).`);
    }
    if (unparseableFrames > 0 || !sawUsage) {
      // Partial answers are still served — but the caller must not be told the token counts
      // are authoritative when they are not. Zero usage flows through to a null cost estimate
      // rather than a fabricated $0 (packages/model-router/src/cost-estimator.ts).
      // eslint-disable-next-line no-console
      console.warn(
        `[llm-google] response served with incomplete telemetry (unparseable_frames=${unparseableFrames}, usage_metadata_seen=${sawUsage}) — token counts may be understated.`
      );
    }

    yield {
      type: "done",
      message: {
        role: "assistant",
        content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      usage: { inputTokens, outputTokens },
      provider: this.name,
      model,
      finishReason,
    };
  }
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction: { parts: [{ text: string }] } | undefined;
  contents: GeminiContent[];
} {
  const systemMessages = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  return {
    systemInstruction:
      systemMessages.length > 0
        ? { parts: [{ text: systemMessages.map((m) => m.content).join("\n\n") }] }
        : undefined,
    contents: rest.map(toGeminiContent),
  };
}

function toGeminiContent(message: ChatMessage): GeminiContent {
  if (message.role === "tool") {
    // docs/04 §3.3 — a tool result is a functionResponse *part*, keyed by the function's
    // name rather than by a call id (classic `generateContent` has no call ids). `contents`
    // accepts only the roles "user" and "model", so the result travels as a user turn.
    return {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: message.name ?? "unknown_tool",
            response: toFunctionResponsePayload(message.content),
          },
        },
      ],
    };
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    const parts: GeminiPart[] = [];
    if (message.content) parts.push({ text: message.content });
    for (const call of message.toolCalls) {
      parts.push({ functionCall: { name: call.name, args: call.arguments } });
    }
    // Gemini uses "model" where our schema uses "assistant" — the one role-name
    // divergence among the three providers.
    return { role: "model", parts };
  }

  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  };
}

/**
 * Gemini requires `functionResponse.response` to be a JSON object, but a tool result reaches
 * us as a string (docs/10_TOOL_AND_MCP_ARCHITECTURE.md §3.1 — the harness serializes
 * `ToolCallResult.output`). Structured results are passed through as-is so the model sees
 * the fields it asked for; plain text is wrapped rather than sent as a bare string, which
 * the API rejects.
 */
function toFunctionResponsePayload(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* not JSON — fall through to the wrapped form */
  }
  return { output: content };
}

/** Gemini's documented `finishReason` enum (docs/04 §3.3-3.4), normalized. */
function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    default:
      // Includes MALFORMED_FUNCTION_CALL and OTHER: real outcomes we must not report as a
      // clean stop.
      return "unknown";
  }
}

/** Gemini spells tool choice as a mode enum on toolConfig.functionCallingConfig. */
function toGeminiFunctionCallingMode(choice: ToolChoice | undefined): "AUTO" | "NONE" | "ANY" {
  switch (choice) {
    case "none":
      return "NONE";
    case "required":
      return "ANY";
    default:
      return "AUTO";
  }
}

function lookupContextWindow(model: string): number | null {
  const exact = CONTEXT_WINDOWS[model];
  if (exact !== undefined) return exact;
  // Versioned aliases (`gemini-3.5-flash-002`) share their base model's window.
  const prefixMatch = Object.keys(CONTEXT_WINDOWS)
    .filter((known) => model.startsWith(known))
    .sort((a, b) => b.length - a.length)[0];
  return prefixMatch ? CONTEXT_WINDOWS[prefixMatch] : null;
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
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        /** `id` exists only on the newer surfaces; classic generateContent omits it (§3.2). */
        functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
      }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    /** Billed as output tokens but reported separately by reasoning-capable models. */
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string };
}
