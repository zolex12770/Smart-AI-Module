import type { AgentEngine } from "@ai-platform/agent-core";
import type {
  ConversationRepository,
  DocumentChunkRepository,
  DocumentRepository,
  MemoryItemRepository,
  MessageRepository,
  TaskNodeRepository,
  TaskRepository,
} from "@ai-platform/database";
import type { EmbeddingProvider } from "@ai-platform/embeddings";
import type { JobQueue } from "@ai-platform/jobs";
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
  documents: DocumentRepository;
  documentChunks: DocumentChunkRepository;
  memoryItems: MemoryItemRepository;
  embeddings: EmbeddingProvider;
  sandboxRoot: string;
  jobQueue: JobQueue;
}
