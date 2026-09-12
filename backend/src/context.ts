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
  DrizzleDb,
} from "@ai-platform/database";
import type { EmbeddingService } from "@ai-platform/embeddings";
import type { JobQueue } from "@ai-platform/jobs";
import type { AssetStore, SpeechProvider } from "@ai-platform/media";
import type { ModelRegistry, ModelRouter } from "@ai-platform/model-router";
import type { McpManager } from "@ai-platform/mcp";
import type { QuotaManager } from "@ai-platform/quota";
import type { MalwareScanner } from "@ai-platform/scanning";
import type { ToolRegistry } from "@ai-platform/tools";
import type { MemoryService } from "@ai-platform/memory";
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
  /** Retrieval + injection + extraction. The repository above is the store; this is the
   * subsystem that makes memory reach a model at all (ADR-063). */
  memory: MemoryService;
  embeddings: EmbeddingService;
  sandboxRoot: string;
  jobQueue: JobQueue;
  assets: AssetRepository;
  assetsRoot: string;
  /** Rolling-summarization thresholds (FR-030, ADR-103). */
  conversationWindow: { maxPromptTokens: number; liveWindowMessages: number };
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
  /** False when nothing real is configured and the mock may not run — which is every
   * production boot, since ADR-013 forbids a mock there. The routes then refuse with a real
   * capability error instead of queueing work no worker will do (ADR-045). Since ADR-065 and
   * ADR-085 both capabilities have a real provider, so "false" now means unconfigured rather
   * than unimplemented. */
  /**
   * Image and video are separate capabilities with separate providers (ADR-065): a deployment
   * can have a real image server and no video one, and reporting them through a single flag
   * would either disable something that works or advertise something that does not.
   */
  imageGenerationAvailable: boolean;
  videoGenerationAvailable: boolean;
  /**
   * Narration synthesis for long-form video (ADR-079). Null means no speech provider is
   * configured, and the render stage then skips the audio track and records that it did —
   * never substituting silence for a voice-over.
   */
  speech: SpeechProvider | null;
  /** Reported by `/api/v1/models` so an operator can see the narration stage's real state. */
  speechAvailable: boolean;

  /**
   * The database handle itself, for the two consumers that are genuinely not repositories:
   * the shared rate-limit store (ADR-071) and the readiness probe. Routes must keep using
   * repositories — those are where the `project_id` predicate that IS the authorization model
   * lives (ADR-049), and a route reaching past them would bypass it.
   */
  db: DrizzleDb;

  // --- identity, tenancy and isolation (ADR-049 / ADR-055) -------------------------------
  /** The single authentication and authorization decision point. */
  auth: AuthService;
  /** Session cookies are Secure in production; false allows plain-HTTP local development. */
  cookieSecure: boolean;
  /** Signup/login attempts per 10 minutes, per IP (ADR-070). */
  authRateLimitMax: number;
  /** Resolved SameSite policy for the session and CSRF cookies (ADR-070). */
  cookieSameSite: "lax" | "none" | "strict";
  /** Container-isolated when configured; process-isolated (env-scrubbed, kill-on-timeout)
   * otherwise. Every agent-initiated command execution goes through this. */
  sandbox: ExecutionSandbox;
  /** Hard ceilings the model cannot raise (ADR-057). */
  agentLimits: { maxIterations: number; maxTokensPerRun: number };
  /** True when a real (non-fallback) embedding model is configured, so RAG can report
   * honestly whether retrieval is semantic or lexical. */
  semanticEmbeddingsAvailable: boolean;

  // --- platform introspection (ADR-066) --------------------------------------------------
  /** The registry behind the router, so `/api/v1/models` can report capabilities honestly. */
  registry: ModelRegistry;
  /** Multi-server MCP lifecycle: status, reconnect, shutdown (ADR-067). */
  mcp: McpManager;
  /** Real readiness checks, unlike `/api/health`, which is a liveness literal. */
  health: {
    database(): Promise<boolean>;
    queue(): Promise<boolean>;
    stats(): Promise<Record<string, number>>;
  };
}
