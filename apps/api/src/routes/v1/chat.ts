import type { FastifyInstance } from "fastify";
import { estimateLlmCostUsd, estimatePromptTokens } from "@ai-platform/model-router";
import { SpanStatusCode, withSpan } from "@ai-platform/observability";
import { chatRequestSchema, NotFoundError, QuotaExceededError, ValidationError, type ChatStreamEvent } from "@ai-platform/shared";
import { v4 as uuid } from "uuid";
import type { AppContext } from "../../context.js";

/**
 * POST /api/v1/chat — streams a chat completion as Server-Sent Events.
 * See docs/15_API_ARCHITECTURE.md ("Streaming: SSE, not WebSockets, as the default").
 */
export function registerChatRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/v1/conversations", async () => ({ conversations: await ctx.conversations.list() }));

  app.get<{ Params: { id: string } }>("/api/v1/conversations/:id/messages", async (request) => {
    const conversation = await ctx.conversations.get(request.params.id);
    if (!conversation) throw new NotFoundError(`Conversation "${request.params.id}" not found.`);
    return { messages: await ctx.messages.listByConversation(conversation.id) };
  });

  app.post("/api/v1/chat", async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.message);
    }
    const chatRequest = parsed.data;

    const conversation = chatRequest.conversationId
      ? await ctx.conversations.get(chatRequest.conversationId)
      : await ctx.conversations.create();

    if (!conversation) {
      throw new ValidationError(`Unknown conversationId "${chatRequest.conversationId}".`);
    }

    const lastUserMessage = [...chatRequest.messages].reverse().find((m) => m.role === "user");
    if (lastUserMessage) {
      await ctx.messages.add({
        conversationId: conversation.id,
        role: "user",
        content: lastUserMessage.content,
      });
    }

    // FR-063 — checked before any provider call is made, never after (docs/22_COST_AND_
    // QUOTA_STRATEGY.md): a rough pre-flight estimate (real token counts aren't known until
    // the provider responds) decides only whether to reject now; the usage actually
    // recorded below is always the real post-call figure.
    const estimatedTokens = estimatePromptTokens(chatRequest.messages.map((m) => m.content).join(" "));
    const quotaCheck = await ctx.quota.checkLlmTokens(estimatedTokens);
    if (!quotaCheck.allowed) {
      throw new QuotaExceededError(quotaCheck.reason ?? "Token quota exceeded.");
    }

    // reply.hijack() below bypasses @fastify/cors' onSend hook entirely, so the
    // CORS header has to be written by hand here — otherwise the browser blocks
    // the whole streamed response even though the server sent it successfully.
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Conversation-Id": conversation.id,
      "Access-Control-Allow-Origin": ctx.corsOrigin,
      "Access-Control-Expose-Headers": "X-Conversation-Id",
    });
    reply.hijack();

    const send = (event: ChatStreamEvent) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    // docs/20_OBSERVABILITY.md §3.3 `gen_ai.chat` span + §1.2 provider-call log fields —
    // `request.id` (Fastify's own per-request id, already present on every request/response
    // log line) is the correlation id threaded through here; the job-queue paths thread the
    // same id through job payloads (see routes/v1/images.ts) so a job's worker-side and
    // provider-call logs can be found from the originating request, and vice versa.
    const startedAt = Date.now();
    await withSpan(
      "gen_ai.chat",
      { "gen_ai.system": "unknown", request_id: request.id, conversation_id: conversation.id },
      async (span) => {
        // docs/26_DECISIONS.md ADR-044 — every provider the router skipped, in order. Without
        // this the only structured record of a failed real-provider call would be the
        // `provider: "mock", status: "success"` line below, which reads as a perfectly healthy
        // request; an operator (or a first real-key verification) could not tell "the key
        // worked" from "the key failed and the mock answered in its place".
        const fellBackFrom: string[] = [];
        try {
          for await (const event of ctx.router.streamChat(
            { ...chatRequest, conversationId: conversation.id },
            {
              onFallback: (fallback) => {
                fellBackFrom.push(fallback.provider);
                request.log.warn(
                  {
                    request_id: request.id,
                    provider: fallback.provider,
                    stage: fallback.stage,
                    error: fallback.message,
                    status: "fallback",
                  },
                  "provider call failed, falling back to the next provider"
                );
              },
            }
          )) {
            send(event);
            if (event.type === "done") {
              await ctx.messages.add({
                conversationId: conversation.id,
                role: "assistant",
                content: event.message.content,
                providerUsed: event.provider,
                modelUsed: event.model,
                usage: event.usage,
              });
              // FR-061/FR-063 — the real post-call usage, not the pre-flight estimate above
              // (docs/22: "only actuals count against quota"). estimatedCostUsd is null, not
              // a fabricated figure, for any provider/model without researched pricing
              // (packages/model-router/src/cost-estimator.ts) — today that's only the mock
              // provider; the three real providers' current default models are priced.
              await ctx.usage.create({
                id: uuid(),
                kind: "llm",
                provider: event.provider,
                model: event.model,
                inputTokens: event.usage.inputTokens,
                outputTokens: event.usage.outputTokens,
                units: null,
                estimatedCostUsd: estimateLlmCostUsd(event.provider, event.model, event.usage),
                requestId: request.id,
              });
              span.setAttributes({
                "gen_ai.system": event.provider,
                "gen_ai.request.model": event.model,
                "gen_ai.usage.input_tokens": event.usage.inputTokens,
                "gen_ai.usage.output_tokens": event.usage.outputTokens,
                "gen_ai.fell_back_from": fellBackFrom.join(","),
              });
              request.log.info(
                {
                  request_id: request.id,
                  provider: event.provider,
                  model: event.model,
                  tokens_input: event.usage.inputTokens,
                  tokens_output: event.usage.outputTokens,
                  latency_ms: Date.now() - startedAt,
                  status: "success",
                  // ADR-044: empty on a clean call; naming the skipped providers otherwise, so
                  // this line alone answers "did a real provider actually serve this?"
                  fell_back_from: fellBackFrom,
                },
                "provider call completed"
              );
            }
          }
        } catch (err) {
          // Handled here (an SSE error event is sent to the client, not re-thrown) — but the
          // span must still reflect ERROR, or a real failure would misleadingly read as a
          // successful `gen_ai.chat` call in any trace view.
          span.recordException(err instanceof Error ? err : String(err));
          span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
          request.log.error(
            { request_id: request.id, err, latency_ms: Date.now() - startedAt, status: "error" },
            "chat stream failed"
          );
          send({ type: "error", message: "The model provider failed to respond. Please try again." });
        }
      }
    );
    reply.raw.end();
  });
}
