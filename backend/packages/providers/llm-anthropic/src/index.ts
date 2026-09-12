import {
  ProviderError,
  ValidationError,
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

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-5";
/** Anthropic requires `max_tokens` on every request; used when the caller names no budget. */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * Documented context windows from docs/04_MODEL_PROVIDER_RESEARCH.md §1.1 (access date
 * 2026-08-31 — that document's own warning that these figures rotate every few weeks
 * applies). A model absent from this table reports `null`, not a guess: the router treats
 * null as "assume sufficient" (backend/packages/model-router/src/registry.ts), whereas an invented
 * number would silently exclude a model that fits or select one that does not.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-fable-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-mythos-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
};

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
 * Tool calling is real here (ADR-047): tools are sent as Anthropic's `{name, description,
 * input_schema}` definitions, streamed `tool_use` blocks are reassembled from
 * `content_block_start` plus chunked `input_json_delta` fragments, and our `tool` role
 * messages are mapped back to the `tool_result` blocks Anthropic expects. That is what lets
 * the agent loop (backend/packages/agent-core/src/reasoning-loop.ts) run against a real model rather
 * than only against the mock.
 *
 * Verification status (honest, per docs/00_PROJECT_VISION.md's principles): request
 * construction and SSE response parsing — text and tool calls both — are unit-tested
 * against fixture payloads matching the documented format (index.test.ts). Additionally, a
 * real network call was made against the live `https://api.anthropic.com/v1/messages`
 * endpoint with a deliberately invalid key (no real key exists in this environment) — it
 * returned a real HTTP 401 in exactly the documented error shape (`{"type":"error","error":
 * {"type":"authentication_error",...}}`), confirming this adapter reaches the real endpoint
 * and constructs a request the real API understands well enough to parse and reject
 * correctly. That does NOT confirm the success path (parsing a real streamed response)
 * works — only a valid key can verify that, tracked as a required follow-up in
 * PROJECT_STATUS.md. Do not treat this as equivalent to full live verification.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly isMock = false;
  /** Public: the router records and logs which model a provider will actually call. */
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) {
      throw new Error("AnthropicProvider requires an apiKey (ANTHROPIC_API_KEY).");
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Declared so the router can refuse an impossible request up front instead of discovering
   * it mid-stream (docs/12_MODEL_ROUTING.md §2). Every current Claude model accepts image
   * input and supports tool use natively (docs/04 §1.1, §1.4); structured output is the
   * `output_config` JSON-schema surface (§1.6).
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
    const { system, messages } = splitSystemMessage(request.messages);

    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(system ? { system } : {}),
      messages,
      stream: true,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools?.length) {
      // docs/04 §1.2 — a top-level `tools` array of {name, description, input_schema}.
      // `strict: true` is deliberately NOT set: it additionally requires every schema to
      // declare `additionalProperties: false` and `required`, which our tool definitions
      // (docs/10_TOOL_AND_MCP_ARCHITECTURE.md §3.1) do not all do, and a request rejected
      // over a schema detail would surface as a model failure.
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
      body.tool_choice = toAnthropicToolChoice(request.toolChoice);
    }

    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const bodyText = await safeReadText(res);
      throw new ProviderError(`Anthropic API request failed (${res.status}): ${truncate(bodyText)}`);
    }

    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let model = request.model ?? this.model;
    let stopReason: string | undefined;
    let sawMessageStop = false;
    let unparseableFrames = 0;
    const toolCalls: ToolCall[] = [];
    // A tool_use block's arguments arrive as chunked partial JSON spread over many
    // `input_json_delta` events (docs/04 §1.3), correlated only by the block's `index`.
    const partialToolUse = new Map<number, PartialToolUse>();

    for await (const { event, data } of parseSseStream(res.body)) {
      if (!data) continue;
      let payload: AnthropicSseEventPayload;
      try {
        payload = JSON.parse(data);
      } catch {
        unparseableFrames++;
        continue;
      }

      switch (event ?? payload.type) {
        case "message_start":
          inputTokens = payload.message?.usage?.input_tokens ?? 0;
          model = payload.message?.model ?? model;
          break;
        case "content_block_start":
          if (payload.content_block?.type === "tool_use") {
            partialToolUse.set(payload.index ?? 0, {
              id: payload.content_block.id ?? "",
              name: payload.content_block.name ?? "",
              json: "",
            });
          }
          break;
        case "content_block_delta":
          if (payload.delta?.type === "text_delta" && payload.delta.text) {
            content += payload.delta.text;
            yield { type: "token", delta: payload.delta.text };
          } else if (payload.delta?.type === "input_json_delta") {
            const partial = partialToolUse.get(payload.index ?? 0);
            if (partial) partial.json += payload.delta.partial_json ?? "";
          }
          break;
        case "content_block_stop": {
          // Emitted at block close rather than held to message_stop, so the agent loop
          // learns the model wants to act as early as the wire allows.
          const index = payload.index ?? 0;
          const partial = partialToolUse.get(index);
          if (partial) {
            partialToolUse.delete(index);
            const call = finalizeToolUse(partial, index);
            toolCalls.push(call);
            yield { type: "tool_call", call };
          }
          break;
        }
        case "message_delta":
          outputTokens = payload.usage?.output_tokens ?? outputTokens;
          stopReason = payload.delta?.stop_reason ?? stopReason;
          break;
        case "error":
          throw new ProviderError(`Anthropic stream error: ${payload.error?.message ?? "unknown error"}`);
        case "message_stop":
          sawMessageStop = true;
          break;
      }
      if (sawMessageStop) break;
    }

    let finishReason: FinishReason = stopReason ? mapStopReason(stopReason) : "unknown";
    // A turn that produced tool_use blocks is a tool turn even if the stop_reason frame was
    // lost, because that is the branch the agent loop takes.
    if (toolCalls.length > 0 && finishReason === "unknown") finishReason = "tool_calls";

    // docs/26_DECISIONS.md ADR-045 — an empty answer must not look like a success. That
    // hardening was originally applied only to llm-google, but the same failure modes exist
    // here (a refusal, an output cap hit before any text was emitted, a stream this parser
    // could not read); all of them used to end as a `done` event with empty content,
    // attributed to anthropic and recorded as a successful 0-token call. Throwing is what
    // lets the router fall back and — since ADR-044 — log why.
    if (!content && toolCalls.length === 0) {
      const why = stopReason
        ? `the turn ended with stop_reason "${stopReason}" (finish reason: ${finishReason})`
        : unparseableFrames > 0
          ? `${unparseableFrames} stream frame(s) could not be parsed (finish reason: ${finishReason})`
          : `the stream contained no text and no tool calls (finish reason: ${finishReason})`;
      throw new ProviderError(`Anthropic returned no content: ${why}.`);
    }

    if (!sawMessageStop || unparseableFrames > 0) {
      // The stream ended without the documented terminator, or frames were dropped. What did
      // arrive is still served — but the caller must not be told the token counts are
      // authoritative when they are not (the same reasoning as llm-google's warning; zero
      // usage flows through to a null cost estimate rather than a fabricated $0).
      // eslint-disable-next-line no-console
      console.warn(
        `[llm-anthropic] response served with incomplete telemetry (message_stop_seen=${sawMessageStop}, unparseable_frames=${unparseableFrames}) — token counts may be understated.`
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

interface PartialToolUse {
  id: string;
  name: string;
  json: string;
}

function finalizeToolUse(partial: PartialToolUse, index: number): ToolCall {
  let parsed: unknown;
  try {
    parsed = partial.json.trim() ? JSON.parse(partial.json) : {};
  } catch {
    // Malformed arguments are a real failure the agent loop can re-prompt around — not
    // something to paper over with an empty object and a tool call that then quietly does
    // the wrong thing.
    throw new ProviderError(
      `Anthropic returned unparseable JSON arguments for tool "${partial.name}": ${truncate(partial.json, 200)}`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProviderError(
      `Anthropic returned non-object arguments for tool "${partial.name}": ${truncate(partial.json, 200)}`
    );
  }
  return {
    id: partial.id || `toolu_${index}`,
    name: partial.name,
    arguments: parsed as Record<string, unknown>,
  };
}

/** Anthropic's documented `stop_reason` values (docs/04 §1.2-1.3), normalized. */
function mapStopReason(reason: string): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
    case "content_filter":
      return "content_filter";
    default:
      return "unknown";
  }
}

/** Anthropic spells "you must call some tool" as `any`, not `required`. */
function toAnthropicToolChoice(choice: ToolChoice | undefined): { type: "auto" | "any" | "none" } {
  switch (choice) {
    case "none":
      return { type: "none" };
    case "required":
      return { type: "any" };
    default:
      return { type: "auto" };
  }
}

function lookupContextWindow(model: string): number | null {
  const exact = CONTEXT_WINDOWS[model];
  if (exact !== undefined) return exact;
  // Dated aliases (`claude-haiku-4-5-20251001`) share their base model's window.
  const prefixMatch = Object.keys(CONTEXT_WINDOWS)
    .filter((known) => model.startsWith(known))
    .sort((a, b) => b.length - a.length)[0];
  return prefixMatch ? CONTEXT_WINDOWS[prefixMatch] : null;
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicWireMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

function splitSystemMessage(messages: ChatMessage[]): {
  system: string | undefined;
  messages: AnthropicWireMessage[];
} {
  const systemMessages = messages.filter((m) => m.role === "system");
  return {
    system: systemMessages.length > 0 ? systemMessages.map((m) => m.content).join("\n\n") : undefined,
    messages: toAnthropicMessages(messages.filter((m) => m.role !== "system")),
  };
}

function toAnthropicMessages(messages: ChatMessage[]): AnthropicWireMessage[] {
  const out: AnthropicWireMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.toolCallId) {
        throw new ValidationError(
          `A tool message for "${message.name ?? "an unnamed tool"}" carries no toolCallId; Anthropic requires tool_result.tool_use_id to match the tool_use block it answers.`
        );
      }
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
      };
      // docs/04 §1.2 — every tool_result for one assistant turn must travel in a SINGLE
      // user message; splitting them across messages degrades parallel tool use.
      const previous = out[out.length - 1];
      if (
        previous &&
        previous.role === "user" &&
        Array.isArray(previous.content) &&
        previous.content.every((b) => b.type === "tool_result")
      ) {
        previous.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      const blocks: AnthropicContentBlock[] = [];
      // An assistant turn may be purely tool use, and Anthropic rejects an empty text block.
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }

    out.push({ role: message.role === "assistant" ? "assistant" : "user", content: message.content });
  }
  return out;
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
  index?: number;
  message?: { usage?: { input_tokens?: number }; model?: string };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    /** Chunked partial JSON for a tool_use block's arguments — docs/04 §1.3. */
    partial_json?: string;
    stop_reason?: string;
    output_tokens?: number;
  };
  usage?: { output_tokens?: number };
  error?: { message?: string };
}
