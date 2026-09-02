import type { FastifyInstance } from "fastify";
import { chatRequestSchema, NotFoundError, ValidationError, type ChatStreamEvent } from "@ai-platform/shared";
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

    try {
      for await (const event of ctx.router.streamChat({ ...chatRequest, conversationId: conversation.id })) {
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
        }
      }
    } catch (err) {
      request.log.error(err, "chat stream failed");
      send({ type: "error", message: "The model provider failed to respond. Please try again." });
    } finally {
      reply.raw.end();
    }
  });
}
