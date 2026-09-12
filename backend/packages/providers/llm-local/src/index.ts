import {
  ProviderError,
  parseSseStream,
  type ChatRequest,
  type ChatStreamEvent,
  type FinishReason,
  type LLMProvider,
  type ProviderCapabilities,
  type ToolCall,
} from "@ai-platform/shared";

/**
 * A provider for any server that speaks the OpenAI `/v1/chat/completions` wire format —
 * docs/26_DECISIONS.md ADR-056.
 *
 * This is the adapter that makes the platform independent of any single vendor (§7 of the
 * product brief). That format is the de facto standard for self-hosted inference: Ollama,
 * vLLM, llama.cpp's server, LM Studio, text-generation-webui and every OpenAI-compatible
 * gateway all implement it. Pointing `LLM_BASE_URL` at any of them gives the platform a
 * complete, local, no-third-party AI runtime with tool calling — the same code path a hosted
 * gateway would use, so there is no "local mode" that behaves differently from production.
 *
 * `/v1/chat/completions` rather than the newer Responses API precisely because it is what
 * self-hosted runtimes implement; the hosted OpenAI adapter (packages/providers/llm-openai)
 * targets Responses separately.
 *
 * Tool calling is real here: tools are sent as JSON Schema function definitions, streamed
 * `tool_calls` deltas are reassembled (they arrive fragmented across chunks, indexed by
 * position), and a `tool_calls` finish reason is surfaced so the agent loop knows the model
 * wants to act rather than answer.
 */
export interface LocalProviderOptions {
  /** e.g. `http://127.0.0.1:11434/v1` for Ollama, `http://127.0.0.1:8000/v1` for vLLM. */
  baseUrl: string;
  model: string;
  /** Most self-hosted runtimes ignore this; gateways may require it. */
  apiKey?: string;
  /** Reported to the router; self-hosted models vary widely. */
  contextWindow?: number;
  /** Set false for a model without function-calling support, so the router will not pick it. */
  supportsTools?: boolean;
  /** Display name, so two local runtimes can be registered side by side. */
  name?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

interface ChoiceDelta {
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface CompletionChunk {
  choices?: Array<{ delta?: ChoiceDelta; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
}

export class LocalOpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly isMock = false;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly contextWindow: number | null;
  private readonly supportsTools: boolean;
  private readonly requestTimeoutMs: number;

  constructor(options: LocalProviderOptions) {
    this.name = options.name ?? "local";
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.contextWindow = options.contextWindow ?? null;
    this.supportsTools = options.supportsTools ?? true;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 300_000;
  }

  capabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: this.supportsTools,
      structuredOutput: true,
      vision: false,
      contextWindow: this.contextWindow,
    };
  }

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const model = request.model ?? this.model;
    const body: Record<string, unknown> = {
      model,
      stream: true,
      // Ask for usage on the final chunk; runtimes that do not support it ignore the option.
      stream_options: { include_usage: true },
      messages: request.messages.map(toWireMessage),
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
    if (request.tools?.length) {
      if (!this.supportsTools) {
        throw new ProviderError(`Model "${model}" on ${this.name} is not configured for tool calling.`);
      }
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
      body.tool_choice = request.toolChoice ?? "auto";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new ProviderError(
        `Could not reach the local model runtime at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }

    try {
      if (!res.ok) {
        throw new ProviderError(`Local model runtime request failed (${res.status}): ${truncate(await safeText(res))}`);
      }
      if (!res.body) throw new ProviderError("Local model runtime returned no response body.");

      let content = "";
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason: FinishReason = "unknown";
      let sawAnyChunk = false;
      // Streamed tool calls arrive fragmented and out of order; `index` is the only stable key.
      const partialCalls = new Map<number, { id: string; name: string; args: string }>();

      for await (const { data } of parseSseStream(res.body)) {
        if (!data || data === "[DONE]") continue;
        let payload: CompletionChunk;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        if (payload.error) {
          throw new ProviderError(`Local model runtime stream error: ${payload.error.message ?? "unknown error"}`);
        }
        sawAnyChunk = true;

        const choice = payload.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) {
          content += delta.content;
          yield { type: "token", delta: delta.content };
        }
        for (const tc of delta?.tool_calls ?? []) {
          const existing = partialCalls.get(tc.index) ?? { id: "", name: "", args: "" };
          partialCalls.set(tc.index, {
            id: tc.id ?? existing.id,
            name: tc.function?.name ?? existing.name,
            args: existing.args + (tc.function?.arguments ?? ""),
          });
        }
        if (choice?.finish_reason) finishReason = mapFinishReason(choice.finish_reason);
        if (payload.usage) {
          inputTokens = payload.usage.prompt_tokens ?? inputTokens;
          outputTokens = payload.usage.completion_tokens ?? outputTokens;
        }
      }

      const toolCalls: ToolCall[] = [];
      for (const [index, partial] of [...partialCalls.entries()].sort((a, b) => a[0] - b[0])) {
        if (!partial.name) continue;
        let args: Record<string, unknown>;
        try {
          args = partial.args.trim() ? JSON.parse(partial.args) : {};
        } catch {
          // A model that emits malformed JSON arguments is a real failure, not something to
          // paper over with an empty object — the agent loop must see it and can re-prompt.
          throw new ProviderError(
            `Model returned unparseable arguments for tool "${partial.name}": ${truncate(partial.args, 200)}`
          );
        }
        const call: ToolCall = { id: partial.id || `call_${index}`, name: partial.name, arguments: args };
        toolCalls.push(call);
        yield { type: "tool_call", call };
      }

      if (!sawAnyChunk) {
        throw new ProviderError("Local model runtime returned an empty stream.");
      }
      // An empty answer with no tool calls is a failure, not an empty success (ADR-045).
      if (!content && toolCalls.length === 0) {
        throw new ProviderError(
          `Local model runtime returned no content (finish reason: ${finishReason}).`
        );
      }
      if (toolCalls.length > 0 && finishReason === "unknown") finishReason = "tool_calls";

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
    } finally {
      clearTimeout(timer);
    }
  }
}

function toWireMessage(m: ChatRequest["messages"][number]): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", content: m.content, tool_call_id: m.toolCallId, name: m.name };
  }
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "unknown";
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(could not read response body)";
  }
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * Embeddings from the same runtime (`/v1/embeddings`). Ollama, vLLM and LM Studio all expose
 * it, which is what lets the platform have real semantic retrieval with no hosted provider.
 */
export class LocalEmbeddingProvider {
  readonly name: string;
  readonly isDeterministicFallback = false;
  constructor(
    private readonly options: {
      baseUrl: string;
      model: string;
      dimensions: number;
      apiKey?: string;
      name?: string;
      fetchImpl?: typeof fetch;
    }
  ) {
    this.name = options.name ?? "local";
  }

  get model(): string {
    return this.options.model;
  }
  get dimensions(): number {
    return this.options.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.options.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.options.model, input: texts }),
    });
    if (!res.ok) {
      throw new ProviderError(`Local embedding request failed (${res.status}): ${truncate(await safeText(res))}`);
    }
    const payload = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const rows = payload.data ?? [];
    if (rows.length !== texts.length) {
      throw new ProviderError(`Local embedding runtime returned ${rows.length} vectors for ${texts.length} inputs.`);
    }
    // `index` is authoritative; some runtimes return out of order.
    const out = new Array<number[]>(texts.length);
    rows.forEach((row, i) => {
      const vector = row.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new ProviderError("Local embedding runtime returned an empty vector.");
      }
      out[row.index ?? i] = vector;
    });
    return out;
  }
}
