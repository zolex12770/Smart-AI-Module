import type { AgentEngine } from "@ai-platform/agent-core";
import type {
  AssetRepository,
  ConversationRepository,
  DocumentChunkRepository,
  DocumentRepository,
  ImageGenerationRepository,
  MemoryItemRepository,
  MessageRepository,
  TaskNodeRepository,
  TaskRepository,
  UsageRecordRepository,
  VideoProjectRepository,
  VideoSceneRepository,
} from "@ai-platform/database";
import type { EmbeddingProvider } from "@ai-platform/embeddings";
import type { JobQueue } from "@ai-platform/jobs";
import type { AssetStore } from "@ai-platform/media";
import type { ModelRouter } from "@ai-platform/model-router";
import type { QuotaManager } from "@ai-platform/quota";
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
  assets: AssetRepository;
  assetsRoot: string;
  /** The only sanctioned way to read an asset's bytes — never `readFile(asset.storagePath)`
   * directly, since that path may be a `gs://` URI (docs/26_DECISIONS.md ADR-040). */
  assetStore: AssetStore;
  imageGenerations: ImageGenerationRepository;
  videoProjects: VideoProjectRepository;
  videoScenes: VideoSceneRepository;
  usage: UsageRecordRepository;
  quota: QuotaManager;
}
