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

const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_MODEL = "gpt-5.6-terra";

/**
 * Documented context windows from docs/04_MODEL_PROVIDER_RESEARCH.md §2.1 (access date
 * 2026-08-31; that document explicitly warns these figures rotate — GPT-5.2 → 5.4 → 5.5 →
 * 5.6 inside a single year — and to pin exact IDs from `/v1/models`). A model absent from
 * this table reports `null` rather than a guess, because the router filters on this number
 * (packages/model-router/src/registry.ts) and a wrong one silently misroutes.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gpt-5.5": 1_000_000,
  "gpt-5.4": 400_000,
  "gpt-5.2": 400_000,
};

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
 * Tool calling is real here (ADR-047) and uses the Responses shapes, which differ from Chat
 * Completions (docs/04 §2.2): tools are flat `{type:"function", name, description,
 * parameters}` definitions with no nested `function` wrapper, the model emits `function_call`
 * *items* in the output array rather than a `tool_calls` field, and results are returned as
 * `function_call_output` items keyed by `call_id`. Streamed argument fragments arrive as
 * `response.function_call_arguments.delta` and are reassembled here.
 *
 * Verification status (honest — see the identical note in llm-anthropic/src/index.ts):
 * unit-tested against a fixture matching the documented event names
 * (`response.output_text.delta`, `response.function_call_arguments.delta`,
 * `response.completed`); the exact field layout of those events was reconstructed from
 * docs/04_MODEL_PROVIDER_RESEARCH.md's description rather than a captured real payload. A
 * real network call was also made against the live `https://api.openai.com/v1/responses`
 * endpoint with a deliberately invalid key — it returned a real HTTP 401 in OpenAI's real
 * error shape, confirming this adapter reaches the real endpoint correctly. The success
 * path (parsing a real streamed response) is still unverified — required follow-up once a
 * real OPENAI_API_KEY is available (PROJECT_STATUS.md).
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  readonly isMock = false;
  /** Public: the router records and logs which model a provider will actually call. */
  readonly model: string;

  private readonly apiKey: string;
  private readonly organizationId?: string;
  private readonly projectId?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIProviderOptions) {
    if (!options.apiKey) {
      throw new Error("OpenAIProvider requires an apiKey (OPENAI_API_KEY).");
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.organizationId = options.organizationId;
    this.projectId = options.projectId;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Declared so the router can refuse an impossible request up front rather than discover it
   * mid-stream (docs/12_MODEL_ROUTING.md §2). All GPT-5.x flagship-family models accept image
   * input (docs/04 §2.4) and support strict JSON-schema structured output (§2.6).
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
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
    if (this.organizationId) headers["OpenAI-Organization"] = this.organizationId;
    if (this.projectId) headers["OpenAI-Project"] = this.projectId;

    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      input: toResponsesInput(request.messages),
      stream: true,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
    if (request.tools?.length) {
      // docs/04 §2.2 — Responses takes the FLAT tool shape; the nested
      // `{type:"function", function:{...}}` form belongs to Chat Completions and is rejected
      // here. `strict: true` is not set, for the same reason as in llm-anthropic: it demands
      // schema properties our tool definitions do not universally declare.
      body.tools = request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }));
      // Our ToolChoice vocabulary ("auto"/"none"/"required") is already OpenAI's, so this
      // passes through unmapped — unlike Anthropic, which spells "required" as "any".
      const toolChoice: ToolChoice = request.toolChoice ?? "auto";
      body.tool_choice = toolChoice;
    }

    const res = await this.fetchImpl(`${this.baseUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const bodyText = await safeReadText(res);
      throw new ProviderError(`OpenAI API request failed (${res.status}): ${truncate(bodyText)}`);
    }

    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let model = request.model ?? this.model;
    let finishReason: FinishReason = "unknown";
    let sawTerminalEvent = false;
    let unparseableFrames = 0;
    const toolCalls: ToolCall[] = [];
    const emittedCallIds = new Set<string>();
    // A function_call item's arguments stream in as fragments correlated by `output_index`
    // (falling back to `item_id`, which the same events also carry).
    const partialCalls = new Map<string, PartialFunctionCall>();

    for await (const { event, data } of parseSseStream(res.body)) {
      if (!data || data === "[DONE]") continue;
      let payload: OpenAIResponseEventPayload;
      try {
        payload = JSON.parse(data);
      } catch {
        unparseableFrames++;
        continue;
      }

      const type = event ?? payload.type;
      const key = itemKey(payload);

      if (type === "response.output_text.delta" && typeof payload.delta === "string") {
        content += payload.delta;
        yield { type: "token", delta: payload.delta };
      } else if (type === "response.output_item.added" && payload.item?.type === "function_call") {
        partialCalls.set(key, {
          callId: payload.item.call_id ?? payload.item.id ?? "",
          name: payload.item.name ?? "",
          args: payload.item.arguments ?? "",
        });
      } else if (type === "response.function_call_arguments.delta" && typeof payload.delta === "string") {
        const partial = partialCalls.get(key) ?? { callId: "", name: "", args: "" };
        partial.args += payload.delta;
        partialCalls.set(key, partial);
      } else if (type === "response.function_call_arguments.done") {
        // The `.done` event carries the complete argument string; prefer it over our own
        // concatenation, which is only as good as the fragments that survived the wire.
        const partial = partialCalls.get(key) ?? { callId: "", name: "", args: "" };
        if (typeof payload.arguments === "string") partial.args = payload.arguments;
        if (payload.name) partial.name = payload.name;
        if (payload.call_id) partial.callId = payload.call_id;
        partialCalls.set(key, partial);
      } else if (type === "response.output_item.done" && payload.item?.type === "function_call") {
        partialCalls.delete(key);
        const call = finalizeFunctionCall({
          callId: payload.item.call_id ?? payload.item.id ?? "",
          name: payload.item.name ?? "",
          args: payload.item.arguments ?? "",
        });
        if (!emittedCallIds.has(call.id)) {
          emittedCallIds.add(call.id);
          toolCalls.push(call);
          yield { type: "tool_call", call };
        }
      } else if (type === "response.completed" || type === "response.incomplete") {
        // `response.incomplete` is the terminal sibling of `response.completed` for a run
        // that stopped early. It is handled here rather than ignored so a truncated answer
        // is reported as `length`, never as a finished one (ADR-045).
        sawTerminalEvent = true;
        inputTokens = payload.response?.usage?.input_tokens ?? inputTokens;
        outputTokens = payload.response?.usage?.output_tokens ?? outputTokens;
        model = payload.response?.model ?? model;
        // The event name is itself a status, and is the only signal on a stream that omits
        // `status`/`incomplete_details` — a normal completion must not be reported as an
        // unknown finish reason just because the optional field was absent.
        finishReason = mapFinishReason(
          payload.response?.incomplete_details?.reason ??
            payload.response?.status ??
            (type === "response.completed" ? "completed" : "incomplete")
        );
        // A stream that carried only the final output array (no per-item events) still has
        // to yield its tool calls, so the agent loop is never silently handed an empty turn.
        for (const item of payload.response?.output ?? []) {
          if (item.type !== "function_call") continue;
          const call = finalizeFunctionCall({
            callId: item.call_id ?? item.id ?? "",
            name: item.name ?? "",
            args: item.arguments ?? "",
          });
          if (emittedCallIds.has(call.id)) continue;
          emittedCallIds.add(call.id);
          toolCalls.push(call);
          yield { type: "tool_call", call };
        }
        break;
      } else if (type === "error" || type === "response.failed") {
        throw new ProviderError(
          `OpenAI stream error: ${payload.message ?? payload.response?.error?.message ?? "unknown error"}`
        );
      }
    }

    // A call whose item never got its own `output_item.done` (a stream that only sent
    // argument fragments, or one cut short after them) is still a call the model asked for.
    // Dropping it silently would strand the agent loop waiting for an answer that never came.
    for (const partial of partialCalls.values()) {
      if (!partial.name) continue;
      const call = finalizeFunctionCall(partial);
      if (emittedCallIds.has(call.id)) continue;
      emittedCallIds.add(call.id);
      toolCalls.push(call);
      yield { type: "tool_call", call };
    }

    // Responses reports a tool-calling turn as status "completed" — there is no
    // `tool_calls` status the way Chat Completions has a `tool_calls` finish_reason — so the
    // presence of function_call items is the authoritative signal for the agent loop.
    if (toolCalls.length > 0 && (finishReason === "stop" || finishReason === "unknown")) {
      finishReason = "tool_calls";
    }

    // docs/26_DECISIONS.md ADR-045 — an empty answer must not look like a success. This
    // hardening was originally applied only to llm-google; the same failure modes exist here
    // (a refusal, the output cap hit before any text, a stream this parser could not read),
    // and each used to end as a `done` event with empty content attributed to openai and
    // recorded as a successful 0-token call. Throwing is what lets the router fall back and —
    // since ADR-044 — log why.
    if (!content && toolCalls.length === 0) {
      const why =
        unparseableFrames > 0
          ? `${unparseableFrames} stream frame(s) could not be parsed (finish reason: ${finishReason})`
          : !sawTerminalEvent
            ? `the stream ended without a response.completed event (finish reason: ${finishReason})`
            : `the response contained no text and no tool calls (finish reason: ${finishReason})`;
      throw new ProviderError(`OpenAI returned no content: ${why}.`);
    }

    if (!sawTerminalEvent || unparseableFrames > 0) {
      // Partial answers are still served — but the caller must not be told the token counts
      // are authoritative when they are not. Zero usage flows through to a null cost estimate
      // rather than a fabricated $0 (packages/model-router/src/cost-estimator.ts).
      // eslint-disable-next-line no-console
      console.warn(
        `[llm-openai] response served with incomplete telemetry (terminal_event_seen=${sawTerminalEvent}, unparseable_frames=${unparseableFrames}) — token counts may be understated.`
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

interface PartialFunctionCall {
  callId: string;
  name: string;
  args: string;
}

function itemKey(payload: OpenAIResponseEventPayload): string {
  return String(payload.output_index ?? payload.item_id ?? payload.item?.id ?? 0);
}

function finalizeFunctionCall(partial: PartialFunctionCall): ToolCall {
  let parsed: unknown;
  try {
    parsed = partial.args.trim() ? JSON.parse(partial.args) : {};
  } catch {
    // Malformed arguments are a real failure the agent loop can re-prompt around — not
    // something to paper over with an empty object and a tool call that then quietly does
    // the wrong thing.
    throw new ProviderError(
      `OpenAI returned unparseable JSON arguments for tool "${partial.name}": ${truncate(partial.args, 200)}`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProviderError(
      `OpenAI returned non-object arguments for tool "${partial.name}": ${truncate(partial.args, 200)}`
    );
  }
  if (!partial.name) {
    throw new ProviderError("OpenAI returned a function_call item with no tool name.");
  }
  return {
    id: partial.callId || `fc_${partial.name}`,
    name: partial.name,
    arguments: parsed as Record<string, unknown>,
  };
}

/**
 * Responses reports `status` ("completed"/"incomplete") plus `incomplete_details.reason`
 * ("max_output_tokens"/"content_filter"); the Chat Completions vocabulary
 * ("stop"/"tool_calls"/"length") is accepted too, since OpenAI-compatible gateways in front
 * of this endpoint emit it. Anything unrecognised stays "unknown" rather than being
 * optimistically read as a clean stop.
 */
function mapFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case "completed":
    case "stop":
    case "stop_sequence":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
    case "max_tokens":
    case "max_output_tokens":
      return "length";
    case "content_filter":
    case "content_filtered":
    case "refusal":
      return "content_filter";
    default:
      return "unknown";
  }
}

function lookupContextWindow(model: string): number | null {
  const exact = CONTEXT_WINDOWS[model];
  if (exact !== undefined) return exact;
  // Dated/snapshot suffixes (`gpt-5.6-terra-2026-05-01`) share the base model's window.
  const prefixMatch = Object.keys(CONTEXT_WINDOWS)
    .filter((known) => model.startsWith(known))
    .sort((a, b) => b.length - a.length)[0];
  return prefixMatch ? CONTEXT_WINDOWS[prefixMatch] : null;
}

type OpenAIInputItem =
  | { role: "system" | "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/**
 * Responses models a conversation as a flat array of typed items, not a messages array:
 * an assistant tool turn becomes one `function_call` item per call, and our `tool` role
 * messages become `function_call_output` items keyed by the same `call_id` (docs/04 §2.2).
 */
function toResponsesInput(messages: ChatMessage[]): OpenAIInputItem[] {
  const items: OpenAIInputItem[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.toolCallId) {
        throw new ValidationError(
          `A tool message for "${message.name ?? "an unnamed tool"}" carries no toolCallId; the Responses API requires function_call_output.call_id to match the call it answers.`
        );
      }
      items.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (message.content) items.push({ role: "assistant", content: message.content });
      for (const call of message.toolCalls) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
      continue;
    }
    items.push({ role: message.role, content: message.content });
  }
  return items;
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

interface OpenAIOutputItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface OpenAIResponseEventPayload {
  type?: string;
  delta?: string;
  /** Present on function-call argument events. */
  arguments?: string;
  name?: string;
  call_id?: string;
  item_id?: string;
  output_index?: number;
  item?: OpenAIOutputItem;
  response?: {
    model?: string;
    status?: string;
    incomplete_details?: { reason?: string };
    output?: OpenAIOutputItem[];
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };
  message?: string;
}
