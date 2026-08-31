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
 */
export class ModelRouter {
  constructor(private readonly registry: ModelRegistry) {}

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    if (request.provider) {
      const provider = this.registry.get(request.provider);
      if (!provider) throw new ProviderError(`Unknown provider "${request.provider}".`);
      yield* provider.streamChat(request);
      return;
    }

    const candidates = this.fallbackOrder();
    let lastError: unknown;

    for (const provider of candidates) {
      const iterator = provider.streamChat(request)[Symbol.asyncIterator]();
      let first: IteratorResult<ChatStreamEvent>;
      try {
        first = await iterator.next();
      } catch (err) {
        lastError = err;
        // eslint-disable-next-line no-console
        console.warn(`[model-router] provider "${provider.name}" failed before its first event, falling back:`, err);
        continue;
      }
      if (first.done) continue;
      if (first.value.type === "error") {
        lastError = new ProviderError(first.value.message);
        // eslint-disable-next-line no-console
        console.warn(`[model-router] provider "${provider.name}" returned an error event, falling back:`, first.value.message);
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
