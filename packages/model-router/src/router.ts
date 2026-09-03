import type { ChatRequest, ChatStreamEvent } from "@ai-platform/shared";
import { ProviderError } from "@ai-platform/shared";
import type { ModelRegistry } from "./registry.js";

/**
 * Routes to a specific requested provider (no fallback substitution — if a caller names
 * a provider explicitly, silently swapping it for another would violate their intent),
 * or, when no provider is named, tries the default provider first and falls back through
 * the rest of the registry in order (docs/12_MODEL_ROUTING.md, docs/23_FAILURE_RECOVERY.md
 * "Circuit breaking"/fallback section).
 *
 * Fallback only happens BEFORE a provider yields its first real event — once a provider
 * has started streaming tokens to the caller, switching to a different provider mid-
 * stream would mean sending a partial response from one model followed by a full
 * response from another, which is more confusing than just surfacing the failure. A
 * failure after the first token is a clean stream-ending error, not a silent retry.
 *
 * A fallback is REPORTED, never silent (docs/26_DECISIONS.md ADR-044). This was originally
 * a bare `console.warn`, which meant that when a real provider failed and the mock answered
 * in its place, the only *structured* record of the request said `provider: "mock",
 * status: "success"` — a failed real call was indistinguishable from a healthy mock one in
 * the JSON logs. Callers now receive every fallback through `onFallback`, either per call
 * (so it can be correlated with a request id) or per router instance; the `console.warn`
 * remains only as the default when no caller supplies a hook.
 */
export interface ProviderFallback {
  /** The provider that failed and was skipped — NOT the one that ultimately answered. */
  provider: string;
  /** Where it failed: it threw before yielding anything, or its first event was an error. */
  stage: "no_first_event" | "error_event";
  message: string;
  error: unknown;
}

export interface StreamChatOptions {
  /** Called once per skipped provider, before the next candidate is tried. */
  onFallback?: (fallback: ProviderFallback) => void;
}

export class ModelRouter {
  constructor(
    private readonly registry: ModelRegistry,
    private readonly options: StreamChatOptions = {}
  ) {}

  async *streamChat(
    request: ChatRequest,
    callOptions: StreamChatOptions = {}
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    if (request.provider) {
      const provider = this.registry.get(request.provider);
      if (!provider) throw new ProviderError(`Unknown provider "${request.provider}".`);
      yield* provider.streamChat(request);
      return;
    }

    const report = (fallback: ProviderFallback): void => {
      const handler = callOptions.onFallback ?? this.options.onFallback;
      if (handler) {
        handler(fallback);
        return;
      }
      // eslint-disable-next-line no-console
      console.warn(`[model-router] provider "${fallback.provider}" ${fallback.stage === "no_first_event" ? "failed before its first event" : "returned an error event"}, falling back:`, fallback.error);
    };

    const candidates = this.fallbackOrder();
    let lastError: unknown;

    for (const provider of candidates) {
      const iterator = provider.streamChat(request)[Symbol.asyncIterator]();
      let first: IteratorResult<ChatStreamEvent>;
      try {
        first = await iterator.next();
      } catch (err) {
        lastError = err;
        report({
          provider: provider.name,
          stage: "no_first_event",
          message: err instanceof Error ? err.message : String(err),
          error: err,
        });
        continue;
      }
      if (first.done) continue;
      if (first.value.type === "error") {
        lastError = new ProviderError(first.value.message);
        report({
          provider: provider.name,
          stage: "error_event",
          message: first.value.message,
          error: lastError,
        });
        continue;
      }

      // Committed to this provider now that it has produced a real first event.
      yield first.value;
      while (true) {
        let next: IteratorResult<ChatStreamEvent>;
        try {
          next = await iterator.next();
        } catch {
          yield { type: "error", message: "The model provider failed partway through responding." };
          return;
        }
        if (next.done) return;
        yield next.value;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new ProviderError("All configured LLM providers failed to respond.");
  }

  private fallbackOrder() {
    const all = this.registry.list();
    const primary = this.registry.getDefault();
    return [primary, ...all.filter((p) => p !== primary)];
  }
}
