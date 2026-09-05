import { z } from "zod";

/**
 * Provider-agnostic chat types. Concrete provider adapters (packages/providers/*)
 * translate to/from these — see docs/04_MODEL_PROVIDER_RESEARCH.md and
 * docs/12_MODEL_ROUTING.md for why the normalization lives here, not per-provider.
 *
 * These types carry real tool calling (docs/26_DECISIONS.md ADR-047): the model may ask for
 * a tool, receive its result, and continue reasoning. That is what makes the agent loop
 * model-driven rather than a hardcoded workflow, so it belongs in the provider contract
 * itself rather than in any one adapter.
 */

export const chatRoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type ChatRole = z.infer<typeof chatRoleSchema>;

/** A tool invocation the MODEL asked for. `arguments` is already JSON-parsed. */
export const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof toolCallSchema>;

export const chatMessageSchema = z.object({
  role: chatRoleSchema,
  /** May be empty on an assistant turn that is purely tool calls. */
  content: z.string(),
  /** Set on `role: "assistant"` when the model requested tools. */
  toolCalls: z.array(toolCallSchema).optional(),
  /** Set on `role: "tool"` — which call this message answers. */
  toolCallId: z.string().optional(),
  /** Set on `role: "tool"` — the tool's name, which some providers require. */
  name: z.string().optional(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** What the model is told a tool looks like. Mirrors JSON Schema, which every provider accepts. */
export const toolSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type ToolSpec = z.infer<typeof toolSpecSchema>;

export const toolChoiceSchema = z.enum(["auto", "none", "required"]);
export type ToolChoice = z.infer<typeof toolChoiceSchema>;

export const chatRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  messages: z.array(chatMessageSchema).min(1),
  provider: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(toolSpecSchema).optional(),
  toolChoice: toolChoiceSchema.optional(),
  maxOutputTokens: z.number().int().positive().max(200_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Why a turn ended. `tool_calls` is the signal the agent loop uses to decide it must execute
 * tools and call the model again; `length` means the answer was truncated by the output cap
 * and must never be mistaken for a complete one.
 */
export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "unknown";

/** Streamed over SSE as `event: <type>\ndata: <json>\n\n` — see docs/15_API_ARCHITECTURE.md. */
export type ChatStreamEvent =
  | { type: "token"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | {
      type: "done";
      message: ChatMessage;
      usage: TokenUsage;
      provider: string;
      model: string;
      finishReason: FinishReason;
    }
  | { type: "error"; message: string };

/** What a provider can do. The router uses this to refuse impossible requests loudly. */
export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  vision: boolean;
  /** Maximum input context in tokens, or null when the adapter cannot know. */
  contextWindow: number | null;
}

export interface LLMProvider {
  readonly name: string;
  readonly isMock: boolean;
  readonly model: string;
  capabilities(): ProviderCapabilities;
  streamChat(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown>;
}

/** Embeddings are a separate capability with a separate lifecycle from chat (ADR-048). */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  readonly isDeterministicFallback: boolean;
  embed(texts: string[]): Promise<number[][]>;
}
