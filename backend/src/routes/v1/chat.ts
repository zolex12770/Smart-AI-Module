import type { FastifyInstance } from "fastify";
import { estimateLlmCostUsd, estimatePromptTokens } from "@ai-platform/model-router";
import {
  CONVERSATION_SUMMARY_PROMPT,
  MEMORY_EXTRACTION_PROMPT,
  applyConversationWindow,
  parseExtractedFacts,
} from "@ai-platform/memory";
import { wrapUntrustedContent } from "@ai-platform/agent-core";
import {
  SpanStatusCode,
  withSpan,
} from "@ai-platform/observability";
import {
  chatRequestSchema,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
  type AuthContext,
  type ChatStreamEvent,
  type ToolCall,
} from "@ai-platform/shared";
import { v4 as uuid } from "uuid";
import type { AppContext } from "../../context.js";
import { requireProject } from "../../plugins/auth.js";

/**
 * POST /api/v1/chat — streams a chat completion as Server-Sent Events.
 * See docs/15_API_ARCHITECTURE.md ("Streaming: SSE, not WebSockets, as the default").
 *
 * Every route in this file is project-scoped (docs/26_DECISIONS.md ADR-049). There is no
 * "current owner" any more: the caller's identity comes from the session cookie or API key
 * resolved by plugins/auth.ts, and the project scope comes from `requireProject`, which is
 * also where the permission check happens. A conversation is therefore never read by id
 * alone — `projectId` is a predicate in the repository's `WHERE`, so a conversation in
 * another project is reported exactly like one that does not exist.
 */

/**
 * `AuthContext.projectId` is optional at the type level because an `AuthContext` exists
 * before a request has been resolved against a project. Everything `requireProject` returns
 * *has* been, so this narrows once, at the boundary, rather than scattering non-null
 * assertions through every repository call below.
 */
function scopedProjectId(authCtx: AuthContext): string {
  if (!authCtx.projectId) {
    throw new ValidationError("A projectId is required (send it as a query parameter or in the body).");
  }
  return authCtx.projectId;
}

export function registerChatRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/v1/conversations", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    return { conversations: await ctx.conversations.list(scopedProjectId(authCtx)) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/conversations/:id/messages", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    const projectId = scopedProjectId(authCtx);

    // Scoped read, then a scoped read of the children: `messages` has no project column of
    // its own and inherits scope through its FK to `conversations` (ADR-049), which is why
    // the repository takes the project here too rather than trusting the id we just checked.
    const conversation = await ctx.conversations.get(projectId, request.params.id);
    if (!conversation) throw new NotFoundError(`Conversation "${request.params.id}" not found.`);
    return { messages: await ctx.messages.listByConversation(projectId, conversation.id) };
  });

  app.post(
    "/api/v1/chat",
    // docs/13_SECURITY_ARCHITECTURE.md §4 "Layer 1 — edge/API rate limiting". This is the
    // endpoint that spends provider tokens, and it was the only expensive one with no
    // per-route limit of its own (image/video/agent-task creation all had one) — the global
    // 300/minute default would have allowed a runaway client to burn the whole token budget
    // before FR-063's quota check could even be consulted. 30/minute is far above interactive
    // human use and far below what a loop can do.
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      // Permission first: nothing is read, written or spent before the caller is known to be
      // allowed to spend it in this project.
      const authCtx = await requireProject(request, ctx.auth, "chat:write");
      const projectId = scopedProjectId(authCtx);

      const parsed = chatRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.message);
      }
      const chatRequest = parsed.data;

      // An existing conversation is fetched *within* the project; a new one is created in it
      // and attributed to the authenticated principal, never to a hardcoded owner (ADR-049).
      const conversation = chatRequest.conversationId
        ? await ctx.conversations.get(projectId, chatRequest.conversationId)
        : await ctx.conversations.create({ projectId, createdByUserId: authCtx.user.id });

      if (!conversation) {
        throw new ValidationError(`Unknown conversationId "${chatRequest.conversationId}".`);
      }

      const lastUserMessage = [...chatRequest.messages].reverse().find((m) => m.role === "user");
      if (lastUserMessage) {
        await ctx.messages.add({
          projectId,
          conversationId: conversation.id,
          role: "user",
          content: lastUserMessage.content,
        });
      }

      /**
       * Long-term memory joins the prompt here — docs/26_DECISIONS.md ADR-063.
       *
       * This is the step whose absence made memory a SKELETON in the ADR-047 audit: rows were
       * stored and listed, and nothing ever put one in front of a model. Retrieval is scoped
       * to this project, this user and this conversation in SQL, and a match below the
       * embedder's relevance threshold is dropped rather than padded in — an irrelevant fact
       * asserted as background is worse than no memory at all.
       *
       * It runs before the quota estimate on purpose: the injected block is real prompt input,
       * so it must be counted, not smuggled in after the budget check.
       */
      const memoryQuery = lastUserMessage?.content ?? "";
      const { messages: messagesWithMemory, injected } = memoryQuery
        ? await ctx.memory.withMemoryContext(
            {
              projectId,
              userId: authCtx.user.id,
              query: memoryQuery,
              conversationId: conversation.id,
            },
            chatRequest.messages
          )
        : { messages: chatRequest.messages, injected: [] };

      if (injected.length > 0) {
        request.log.info(
          {
            request_id: request.id,
            conversation_id: conversation.id,
            memories_injected: injected.length,
            memory_ids: injected.map((m) => m.item.id),
          },
          "long-term memory injected into the prompt"
        );
      }

      /**
       * Rolling summarization of the turns that no longer fit — FR-030, ADR-103.
       *
       * Before this the route forwarded whatever array the client sent, so a long conversation
       * was neither summarized nor truncated: it grew until the provider rejected it at its
       * context limit. The `summary` column, the `summarized_message_count` column and
       * `updateSummary` had all existed, unused, since ADR-051.
       *
       * It runs AFTER memory injection and BEFORE the quota estimate, which is the only correct
       * position for both: the injected system block is part of the prompt being measured, and
       * the estimate must see the prompt that will actually be sent, not the one that would
       * have been.
       */
      const windowed = await applyConversationWindow(
        {
          conversationRepo: ctx.conversations,
          summarize: async ({ previousSummary, transcript }) => {
            const prompt = [
              previousSummary ? "Earlier summary:\n" + previousSummary : null,
              "New turns:\n" + transcript,
            ]
              .filter(Boolean)
              .join("\n\n");

            // ADR-046 applies to this call as much as to the answer it makes room for: a project
            // out of quota must not be able to spend on bookkeeping either.
            const summaryEstimate = estimatePromptTokens(CONVERSATION_SUMMARY_PROMPT + prompt);
            const allowed = await ctx.quota.checkLlmTokens(projectId, summaryEstimate);
            if (!allowed.allowed) {
              throw new QuotaExceededError(allowed.reason ?? "Token quota exceeded.");
            }

            let text = "";
            let usage: { inputTokens: number; outputTokens: number } | null = null;
            let usedProvider = "";
            let usedModel = "";
            // A summary cut off at the output limit is stored as complete by nothing (ADR-110): it
            // would become the base of every later pass, and its missing tail would be lost for good.
            let truncated = false;
            for await (const event of ctx.router.streamChat({
              messages: [
                { role: "system", content: CONVERSATION_SUMMARY_PROMPT },
                { role: "user", content: prompt },
              ],
              // Zero temperature: a summary is a record, not a composition, and a different
              // paraphrase on every request would make the conversation drift by itself.
              temperature: 0,
            })) {
              if (event.type === "token") text += event.delta;
              else if (event.type === "done") {
                usage = event.usage;
                usedProvider = event.provider;
                usedModel = event.model;
                if (event.finishReason === "length") truncated = true;
              } else if (event.type === "error") throw new Error(event.message);
            }

            if (usage) {
              await ctx.usage.create({
                id: uuid(),
                projectId,
                userId: authCtx.user.id,
                kind: "llm",
                provider: usedProvider,
                model: usedModel,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                units: null,
                estimatedCostUsd: estimateLlmCostUsd(usedProvider, usedModel, usage),
                requestId: request.id,
                // One key per PROVIDER CALL (ADR-110). It was the conversation id plus the stored
                // count, which two real calls share whenever they start from the same count — two
                // tabs, or a pass whose summary failed to persist — and a conflict on this unique
                // index silently DROPS the second call's real tokens. `summarize` runs once per
                // request and is never retried, so a fresh key cannot double-charge anything.
                idempotencyKey: "llm:summary:" + uuid(),
              });
            }
            if (truncated) {
              throw new Error("The summary was cut off at the output limit; it was not stored.");
            }
            return text;
          },
        },
        { projectId, conversation, messages: messagesWithMemory },
        ctx.conversationWindow
      );

      if (windowed.error) {
        // Degraded, not failed: the model sees less history, which is the situation that existed
        // before ADR-103. A chat request must not fail because a bookkeeping call did.
        request.log.warn(
          { request_id: request.id, conversation_id: conversation.id, err: windowed.error },
          "conversation summarization failed; continuing with the live window only"
        );
      } else if (windowed.summarized) {
        request.log.info(
          {
            request_id: request.id,
            conversation_id: conversation.id,
            summarized_message_count: windowed.summarizedMessageCount,
            prompt_messages: windowed.messages.length,
          },
          "conversation summarized: older turns replaced by a rolling summary"
        );
      }

      if (windowed.invalidated) {
        // The history this request sent no longer matches the turns the stored summary was built
        // from — an edited, branched or reloaded conversation (ADR-110). The summary was rebuilt
        // (or, if that failed, the turns were sent verbatim) instead of being trusted.
        request.log.warn(
          { request_id: request.id, conversation_id: conversation.id },
          "stored conversation summary discarded: the history sent no longer matches it"
        );
      }

      const promptMessages = windowed.messages;


      // FR-063 — checked before any provider call is made, never after (docs/22_COST_AND_
      // QUOTA_STRATEGY.md): a rough pre-flight estimate (real token counts aren't known until
      // the provider responds) decides only whether to reject now; the usage actually
      // recorded below is always the real post-call figure.
      const estimatedTokens = estimatePromptTokens(promptMessages.map((m) => m.content).join(" "));
      // Quota is per project (ADR-049): one project's spend must never exhaust another's
      // allowance, so the scope goes into the check itself rather than being a global counter.
      const quotaCheck = await ctx.quota.checkLlmTokens(projectId, estimatedTokens);
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
        // The browser sends this request with `credentials: "include"` (the session cookie), and
        // the CORS rules then REQUIRE this header on the response — without it every streamed
        // answer is blocked by the browser after the server sent it perfectly (ADR-123).
        // @fastify/cors adds it to ordinary responses; a hijacked one bypasses that hook.
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Expose-Headers": "X-Conversation-Id",
      });
      reply.hijack();

      // Started before the abort plumbing so every outcome — success, failure, cancellation —
      // reports latency measured from the same instant.
      const startedAt = Date.now();

      /**
       * A hijacked response is no longer managed by Fastify, so nothing else notices when the
       * browser navigates away or the user hits stop: the generator below would keep pulling
       * from the provider to completion and the tokens would still be billed, for an answer
       * nobody can receive. The router re-checks the signal before it tries each candidate
       * provider and before any retry; the loop below additionally *stops pulling*, which is
       * what actually cancels an already-streaming call — abandoning a `for await` calls
       * `return()` up the generator chain and closes the provider's response body.
       *
       * The listener is on `reply.raw`, NOT `request.raw`, and that distinction is load-
       * bearing rather than stylistic. Fastify has already read and destroyed the request
       * stream by the time this handler runs (it had to, to parse the JSON body), so on a
       * POST `request.raw` emits `close` immediately — measured at 0 ms here, before the
       * first token — and using it would abort every chat instead of only abandoned ones.
       * `reply.raw` emits `close` when the response finishes *or* the connection dies, so
       * `writableEnded` is what separates "done" from "gone". (The GET event stream in
       * agent.ts can safely watch `request.raw`: a bodyless GET is never drained, so its
       * `close` really does mean the client left.)
       */
      const abort = new AbortController();
      const onClientClose = () => {
        if (reply.raw.writableEnded || abort.signal.aborted) return;
        abort.abort();
        request.log.warn(
          { request_id: request.id, project_id: projectId, conversation_id: conversation.id, status: "client_disconnected" },
          "client disconnected — aborting the provider stream"
        );
      };
      reply.raw.on("close", onClientClose);

      const send = (event: ChatStreamEvent) => {
        // Writing to a destroyed socket throws `ERR_STREAM_WRITE_AFTER_END`, and there is
        // nobody to read it anyway once the client is gone.
        if (abort.signal.aborted || reply.raw.writableEnded || reply.raw.destroyed) return;
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };

      const logCancelled = () =>
        request.log.info(
          {
            request_id: request.id,
            project_id: projectId,
            conversation_id: conversation.id,
            latency_ms: Date.now() - startedAt,
            status: "cancelled",
          },
          "chat stream cancelled by the client"
        );

      // docs/20_OBSERVABILITY.md §3.3 `gen_ai.chat` span + §1.2 provider-call log fields —
      // `request.id` (Fastify's own per-request id, already present on every request/response
      // log line) is the correlation id threaded through here; the job-queue paths thread the
      // same id through job payloads (see routes/v1/images.ts) so a job's worker-side and
      // provider-call logs can be found from the originating request, and vice versa.
      try {
        await withSpan(
          "gen_ai.chat",
          {
            "gen_ai.system": "unknown",
            request_id: request.id,
            conversation_id: conversation.id,
            // Tenancy on the span too: a trace that cannot say which project it belongs to is
            // useless for both cost attribution and incident scoping (ADR-049).
            project_id: projectId,
            user_id: authCtx.user.id,
          },
          async (span) => {
            // docs/26_DECISIONS.md ADR-044 — every provider the router skipped, in order. Without
            // this the only structured record of a failed real-provider call would be the
            // `provider: "mock", status: "success"` line below, which reads as a perfectly healthy
            // request; an operator (or a first real-key verification) could not tell "the key
            // worked" from "the key failed and the mock answered in its place".
            const fellBackFrom: string[] = [];
            // ADR-047: a turn may be tool calls rather than prose. The provider reports them
            // as they stream, and repeats them on the `done` message; collecting them here
            // means a provider that only streams them still produces a complete `done` event
            // and a complete stored message.
            const streamedToolCalls: ToolCall[] = [];
            /** Set once the turn finished, so a disconnect *after* a completed answer is not
             * also logged as a cancellation of it. */
            let completed = false;
            try {
              for await (const event of ctx.router.streamChat(
                { ...chatRequest, messages: promptMessages, conversationId: conversation.id },
                {
                  signal: abort.signal,
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
                // The cancellation that matters: stop consuming. `break` runs the generator
                // chain's `return()`, which closes the provider's HTTP response body — the
                // difference between "we ignore the rest" and "we are no longer billed for
                // the rest". Checked here rather than only in `send` so a disconnect ends the
                // call instead of quietly draining it into a discarded write.
                if (abort.signal.aborted) break;

                if (event.type === "tool_call") {
                  streamedToolCalls.push(event.call);
                }

                if (event.type !== "done") {
                  send(event);
                  continue;
                }

                // ADR-047 — the wire event and the stored row must agree about tool calls, so
                // both are built from the same value. Absent (not an empty array) when the turn
                // asked for no tools: a message with no tool calls and one that predates tool
                // calling are the same thing, and there is nothing to distinguish.
                const toolCalls =
                  event.message.toolCalls ?? (streamedToolCalls.length > 0 ? streamedToolCalls : undefined);
                const doneEvent: ChatStreamEvent = toolCalls
                  ? { ...event, message: { ...event.message, toolCalls } }
                  : event;
                send(doneEvent);

                const assistantMessage = await ctx.messages.add({
                  projectId,
                  conversationId: conversation.id,
                  role: "assistant",
                  content: event.message.content,
                  ...(toolCalls ? { toolCalls } : {}),
                  providerUsed: event.provider,
                  modelUsed: event.model,
                  usage: event.usage,
                });
                // FR-061/FR-063 — the real post-call usage, not the pre-flight estimate above
                // (docs/22: "only actuals count against quota"). estimatedCostUsd is null, not
                // a fabricated figure, for any provider/model without researched pricing
                // (backend/packages/model-router/src/cost-estimator.ts) — today that's only the mock
                // provider; the three real providers' current default models are priced.
                await ctx.usage.create({
                  id: uuid(),
                  // Which project spent it and who spent it (ADR-049). A ledger row that
                  // cannot name a project cannot be charged to one or reported to it.
                  projectId,
                  userId: authCtx.user.id,
                  kind: "llm",
                  provider: event.provider,
                  model: event.model,
                  inputTokens: event.usage.inputTokens,
                  outputTokens: event.usage.outputTokens,
                  units: null,
                  estimatedCostUsd: estimateLlmCostUsd(event.provider, event.model, event.usage),
                  requestId: request.id,
                  // ADR-054: the natural key for this charge is the assistant message it paid
                  // for. One message, one charge — so a retry that somehow re-recorded this
                  // turn conflicts on the unique index instead of double-charging.
                  idempotencyKey: `llm:message:${assistantMessage.id}`,
                });

                /**
                 * Learning something from the exchange — docs/26_DECISIONS.md ADR-141.
                 *
                 * `MEMORY_EXTRACTION_PROMPT`, `parseExtractedFacts` and
                 * `MemoryService.recordExtracted` all shipped, all tested, and nothing in
                 * production ever called any of them. So memory could only ever hold what a user
                 * typed into the Memory screen by hand: the platform RETRIEVED memories and
                 * injected them, and never formed one. "The platform remembers what you tell it
                 * across conversations" was true only in the sense that a notebook remembers.
                 *
                 * Deliberately after the response has been sent, never awaited by it: this is a
                 * second model call, and a user waiting on their answer must not pay for it in
                 * latency. A failure is logged and dropped — not learning a fact is a small loss,
                 * and failing a completed turn over it would be a large one.
                 */
                void extractMemories(ctx, {
                  projectId,
                  userId: authCtx.user.id,
                  conversationId: conversation.id,
                  userMessage: lastUserMessage,
                  assistantMessage: event.message.content,
                  requestId: request.id,
                  logger: request.log,
                });

                /**
                 * The metrics used to be emitted HERE, and only here — moved to the router in
                 * ADR-132.
                 *
                 * This block sat below a `continue` that skips every event but the terminal
                 * `done`, so `provider_request_count` only ever counted chat that worked: a
                 * failed chat, summarisation, RAG and every agent step were invisible, and a
                 * dashboard read 100% success during an outage. The router is the one thing all
                 * of them pass through, so it reports them all — including this one, which is
                 * why nothing is recorded here any more. The span below stays: it answers "what
                 * happened in THIS request", which a counter cannot.
                 */
                span.setAttributes({
                  "gen_ai.system": event.provider,
                  "gen_ai.request.model": event.model,
                  "gen_ai.usage.input_tokens": event.usage.inputTokens,
                  "gen_ai.usage.output_tokens": event.usage.outputTokens,
                  "gen_ai.fell_back_from": fellBackFrom.join(","),
                  "gen_ai.tool_calls": toolCalls?.length ?? 0,
                });
                request.log.info(
                  {
                    request_id: request.id,
                    project_id: projectId,
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
                completed = true;
              }
              // Reached by the `break` above; the router can also throw its own cancellation
              // error, which the catch below routes to exactly the same place.
              if (abort.signal.aborted && !completed) logCancelled();
            } catch (err) {
              // A stream the client itself abandoned is not a provider failure. Recording it as
              // one would make every "user pressed stop" show up as an ERROR span and page
              // somebody; it is logged as the cancellation it is, and no error event is sent
              // because there is nobody left on the socket to read it.
              if (abort.signal.aborted) {
                if (!completed) logCancelled();
                return;
              }
              // Handled here (an SSE error event is sent to the client, not re-thrown) — but the
              // span must still reflect ERROR, or a real failure would misleadingly read as a
              // successful `gen_ai.chat` call in any trace view.
              span.recordException(err instanceof Error ? err : String(err));
              span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
              request.log.error(
                { request_id: request.id, project_id: projectId, err, latency_ms: Date.now() - startedAt, status: "error" },
                "chat stream failed"
              );
              send({ type: "error", message: "The model provider failed to respond. Please try again." });
            }
          }
        );
      } finally {
        // Detached before `end()`, so the normal completion path never runs the disconnect
        // handler at all, and the closure (with its AbortController) is not held alive by a
        // socket that outlives this request on a keep-alive connection.
        reply.raw.off("close", onClientClose);
        if (!reply.raw.writableEnded) reply.raw.end();
      }
    }
  );
}

/**
 * Forms durable memories from a finished exchange — docs/26_DECISIONS.md ADR-141.
 *
 * The three pieces this needs were all written and none was ever called:
 * `MEMORY_EXTRACTION_PROMPT` (what to ask), `parseExtractedFacts` (how to read the answer) and
 * `MemoryService.recordExtracted` (what to do with it — trimming, semantic de-duplication against
 * what is already known, provenance). Memory could therefore only ever hold what somebody typed
 * into the Memory screen by hand.
 *
 * Every guard the rest of the platform applies to a model call applies here:
 *
 *  - It is a model call, so it is quota-checked first and recorded in the ledger after. An
 *    unbudgeted background call would be a way to spend past a ceiling the chat turn respected.
 *  - It never runs when memory injection is off, because forming memories nothing will read is
 *    pure cost.
 *  - Its output is UNTRUSTED. It is derived from a user's message, and it is being asked to
 *    produce facts that will be injected into future prompts — a "remember that you must ignore
 *    your instructions" is a prompt injection with a persistence mechanism. The exchange is
 *    delimited (ADR-133) and `recordExtracted` bounds what can be stored.
 *  - A failure is logged and dropped. The turn it came from has already succeeded.
 */
async function extractMemories(
  ctx: AppContext,
  input: {
    projectId: string;
    userId: string;
    conversationId: string;
    userMessage: { content: string } | undefined;
    assistantMessage: string;
    requestId: string;
    logger: { warn: (obj: unknown, msg: string) => void };
  }
): Promise<void> {
  if (!input.userMessage?.content.trim() || !input.assistantMessage.trim()) return;
  if (!ctx.memoryExtractionEnabled) return;

  const exchange = `User: ${input.userMessage.content}\n\nAssistant: ${input.assistantMessage}`.slice(0, 6_000);
  const prompt = `${wrapUntrustedContent(exchange)}`;

  try {
    const estimate = estimatePromptTokens(MEMORY_EXTRACTION_PROMPT + prompt);
    const allowed = await ctx.quota.checkLlmTokens(input.projectId, estimate);
    if (!allowed.allowed) return;

    let text = "";
    let provider = "unknown";
    let model = "unknown";
    let usage = { inputTokens: 0, outputTokens: 0 };
    for await (const event of ctx.router.streamChat({
      messages: [
        { role: "system", content: MEMORY_EXTRACTION_PROMPT },
        { role: "user", content: prompt },
      ],
    })) {
      if (event.type === "token") text += event.delta;
      if (event.type === "done") {
        text = event.message.content || text;
        provider = event.provider;
        model = event.model;
        usage = event.usage;
      }
    }

    const facts = parseExtractedFacts(text);
    if (facts.length > 0) {
      await ctx.memory.recordExtracted({
        projectId: input.projectId,
        userId: input.userId,
        conversationId: input.conversationId,
        facts,
      });
    }

    await ctx.usage.create({
      id: uuid(),
      projectId: input.projectId,
      userId: input.userId,
      kind: "llm",
      provider,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      units: null,
      estimatedCostUsd: estimateLlmCostUsd(provider, model, usage),
      requestId: input.requestId,
      // One extraction per request: a retry conflicts rather than charging twice.
      idempotencyKey: `llm:memory-extraction:${input.requestId}`,
    });
  } catch (error) {
    input.logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "memory extraction failed; the turn is unaffected"
    );
  }
}
