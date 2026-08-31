import { z } from "zod";

/**
 * Provider-agnostic chat types. Concrete provider adapters (packages/providers/*)
 * translate to/from these — see docs/04_MODEL_PROVIDER_RESEARCH.md and
 * docs/12_MODEL_ROUTING.md for why the normalization lives here, not per-provider.
 */

export const chatRoleSchema = z.enum(["system", "user", "assistant"]);
export type ChatRole = z.infer<typeof chatRoleSchema>;

export const chatMessageSchema = z.object({
  role: chatRoleSchema,
  content: z.string().min(1),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  messages: z.array(chatMessageSchema).min(1),
  provider: z.string().optional(),
  model: z.string().optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Streamed over SSE as `event: <type>\ndata: <json>\n\n` — see docs/15_API_ARCHITECTURE.md. */
export type ChatStreamEvent =
  | { type: "token"; delta: string }
  | { type: "done"; message: ChatMessage; usage: TokenUsage; provider: string; model: string }
  | { type: "error"; message: string };

export interface LLMProvider {
  readonly name: string;
  readonly isMock: boolean;
  streamChat(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown>;
}
