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
import type { EmbeddingService } from "@ai-platform/embeddings";
import type { JobQueue } from "@ai-platform/jobs";
import type { AssetStore } from "@ai-platform/media";
import type { ModelRouter } from "@ai-platform/model-router";
import type { QuotaManager } from "@ai-platform/quota";
import type { MalwareScanner } from "@ai-platform/scanning";
import type { ToolRegistry } from "@ai-platform/tools";
import type { AuthService } from "@ai-platform/security";
import type { ExecutionSandbox } from "@ai-platform/security";

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
  embeddings: EmbeddingService;
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
  /** Null when no scanner is configured (docs/26_DECISIONS.md ADR-042). The upload route
   * only checks presence; the worker role is what actually talks to it. */
  scanner: MalwareScanner | null;
  /** When true and `scanner` is null, uploads are refused (503) rather than accepted unscanned. */
  uploadScanRequired: boolean;
  /** False in production, where the mock-only image/video providers (ADR-009) may not run
   * (ADR-013): the routes refuse with a 503 instead of queueing work no worker will do.
   * docs/26_DECISIONS.md ADR-045. */
  mediaGenerationAvailable: boolean;

  // --- identity, tenancy and isolation (ADR-049 / ADR-055) -------------------------------
  /** The single authentication and authorization decision point. */
  auth: AuthService;
  /** Session cookies are Secure in production; false allows plain-HTTP local development. */
  cookieSecure: boolean;
  /** Container-isolated when configured; process-isolated (env-scrubbed, kill-on-timeout)
   * otherwise. Every agent-initiated command execution goes through this. */
  sandbox: ExecutionSandbox;
  /** Hard ceilings the model cannot raise (ADR-057). */
  agentLimits: { maxIterations: number; maxTokensPerRun: number };
  /** True when a real (non-fallback) embedding model is configured, so RAG can report
   * honestly whether retrieval is semantic or lexical. */
  semanticEmbeddingsAvailable: boolean;
}
