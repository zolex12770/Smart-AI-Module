import type { ConversationRepository, MessageRepository } from "@ai-platform/database";
import type { ModelRouter } from "@ai-platform/model-router";

/**
 * Composition-root context passed into route registration — plain constructor
 * injection, no DI framework. See docs/17_BACKEND_ARCHITECTURE.md.
 */
export interface AppContext {
  router: ModelRouter;
  conversations: ConversationRepository;
  messages: MessageRepository;
  corsOrigin: string;
}
