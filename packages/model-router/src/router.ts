import type { ChatRequest, ChatStreamEvent } from "@ai-platform/shared";
import { ProviderError } from "@ai-platform/shared";
import type { ModelRegistry } from "./registry.js";

/**
 * Phase 1: route to the requested provider by name, or the registry default.
 * Fallback-on-failure (docs/12_MODEL_ROUTING.md, docs/23_FAILURE_RECOVERY.md) is a
 * Phase 2 concern once there is more than one real provider to fall back to.
 */
export class ModelRouter {
  constructor(private readonly registry: ModelRegistry) {}

  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const provider = request.provider ? this.registry.get(request.provider) : undefined;
    const resolved = provider ?? this.registry.getDefault();

    if (request.provider && !provider) {
      throw new ProviderError(`Unknown provider "${request.provider}".`);
    }

    yield* resolved.streamChat(request);
  }
}
