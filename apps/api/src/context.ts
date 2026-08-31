import type { AgentEngine } from "@ai-platform/agent-core";
import type { ConversationRepository, MessageRepository, TaskNodeRepository, TaskRepository } from "@ai-platform/database";
import type { ModelRouter } from "@ai-platform/model-router";
import type { ToolRegistry } from "@ai-platform/tools";

/**
 * Composition-root context passed into route registration — plain constructor
 * injection, no DI framework. See docs/17_BACKEND_ARCHITECTURE.md.
 */
export interface AppContext {
  router: ModelRouter;
  conversations: ConversationRepository;
  messages: MessageRepository;
  corsOrigin: string;
  engine: AgentEngine;
  tasks: TaskRepository;
  taskNodes: TaskNodeRepository;
  toolRegistry: ToolRegistry;
}
