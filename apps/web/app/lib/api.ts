import { apiFetch } from "./auth-client";
import type { GeneratedImage, ImageGenerationRequest, Task, TaskNode, TaskType, VideoProjectRequest } from "@ai-platform/shared";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

// Mirrors of the API's response shapes for `conversations`/`messages` — deliberately local
// rather than importing @ai-platform/database's repository types, since the web app treats
// the API as its contract (docs/16_FRONTEND_ARCHITECTURE.md: "thin client of the real API"),
// not as a consumer of internal backend packages.
export interface Conversation {
  id: string;
  title: string | null;
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "system" | "user" | "assistant";
  content: string;
  providerUsed: string | null;
  modelUsed: string | null;
  createdAt: string;
}

/**
 * Every call in this module goes through `apiFetch` — docs/26_DECISIONS.md ADR-070.
 *
 * It used to call `fetch` directly, which was fine when the API had no authentication and
 * became a real bug the moment it did: no session cookie, no CSRF header and no project scope
 * meant every one of the 24 functions below returned 401 against the authenticated API. The
 * end-to-end suite caught it on the first run — signup succeeded, then the very next call for
 * the user's conversations was refused and the app bounced back to the login screen.
 *
 * Having exactly one place that talks to the backend is the point: a second one drifts.
 * `apiFetch` still only declares a JSON content type when there is actually a body, because
 * Fastify's parser rejects a bodyless request that claims `application/json` with
 * FST_ERR_CTP_EMPTY_JSON_BODY — a real 400 originally found by driving a DELETE in a browser.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return apiFetch<T>(path, {
    method: init?.method,
    headers: init?.headers,
    // `apiFetch` serialises; this module already holds JSON strings, so hand them back as
    // parsed values rather than double-encoding them.
    body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
  });
}

// --- Conversations / chat history --------------------------------------------------

export const listConversations = () => request<{ conversations: Conversation[] }>("/api/v1/conversations");
export const getConversationMessages = (id: string) =>
  request<{ messages: Message[] }>(`/api/v1/conversations/${id}/messages`);

// --- Agent tasks ---------------------------------------------------------------------

export const listTasks = () => request<{ tasks: Task[] }>("/api/v1/agent/tasks");
export const getTask = (id: string) => request<{ task: Task; nodes: TaskNode[] }>(`/api/v1/agent/tasks/${id}`);
export const createTask = (taskType: TaskType, input: Record<string, unknown>) =>
  request<{ task: Task }>("/api/v1/agent/tasks", { method: "POST", body: JSON.stringify({ taskType, input }) });
export const approveNode = (taskId: string, nodeId: string) =>
  request<{ ok: true }>(`/api/v1/agent/tasks/${taskId}/approve`, { method: "POST", body: JSON.stringify({ nodeId }) });
export const rejectNode = (taskId: string, nodeId: string) =>
  request<{ ok: true }>(`/api/v1/agent/tasks/${taskId}/reject`, { method: "POST", body: JSON.stringify({ nodeId }) });
export const cancelTask = (taskId: string) =>
  request<{ ok: true }>(`/api/v1/agent/tasks/${taskId}/cancel`, { method: "POST" });

// --- Images ----------------------------------------------------------------------------

export interface ImageGeneration {
  id: string;
  prompt: string;
  request: ImageGenerationRequest;
  status: "pending" | "processing" | "succeeded" | "failed";
  providerName: string | null;
  resultAssetId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export const listImages = () => request<{ generations: ImageGeneration[] }>("/api/v1/images");
export const getImage = (id: string) => request<{ generation: ImageGeneration }>(`/api/v1/images/${id}`);
export const createImage = (body: Partial<ImageGenerationRequest> & { prompt: string }) =>
  request<{ generation: ImageGeneration }>("/api/v1/images", { method: "POST", body: JSON.stringify(body) });

// --- Videos ----------------------------------------------------------------------------

/** The model-written script and storyboard, or a record that the planner produced it (ADR-080). */
export interface VideoScript {
  title?: string;
  /**
   * `model` when a model really wrote the storyboard; `deterministic` when the mechanical planner
   * did. Rendered on the detail screen, because the two are indistinguishable from the scenes
   * alone and a mechanical decomposition that reads as authored is exactly the confusion the
   * platform's honesty rule exists to prevent.
   */
  scriptSource?: "model" | "deterministic";
  model?: string | null;
  fallbackReason?: string | null;
  scenes?: Array<{ sceneIndex: number; shotDescription: string; narration?: string }>;
}

export interface VideoProject {
  id: string;
  prompt: string;
  script?: VideoScript | null;
  targetDurationSeconds: number;
  sceneClipSeconds: number;
  sceneCount: number;
  status: "generating_scenes" | "assembling" | "succeeded" | "partially_succeeded" | "failed";
  renderStatus: "pending" | "processing" | "succeeded" | "skipped_no_ffmpeg" | "failed" | null;
  renderAssetId: string | null;
  renderError: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VideoScene {
  id: string;
  projectId: string;
  sceneIndex: number;
  shotDescription: string;
  /** The line spoken over the shot; null for a scene with no script or no speech provider. */
  narration?: string | null;
  /** Set once narration has really been synthesised and stored (ADR-079). */
  audioAssetId?: string | null;
  durationSeconds: number;
  status: "pending" | "processing" | "succeeded" | "failed";
  jobId: string | null;
  assetId: string | null;
  retryCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export const listVideos = () => request<{ projects: VideoProject[] }>("/api/v1/videos");
export const getVideo = (id: string) => request<{ project: VideoProject; scenes: VideoScene[] }>(`/api/v1/videos/${id}`);
export const createVideo = (body: VideoProjectRequest) =>
  request<{ project: VideoProject }>("/api/v1/videos", { method: "POST", body: JSON.stringify(body) });
export const retryVideo = (id: string) => request<{ project: VideoProject }>(`/api/v1/videos/${id}/retry`, { method: "POST" });

// --- Files / RAG -------------------------------------------------------------------------

export interface DocumentRecord {
  id: string;
  filename: string;
  /** Set for the sandbox-path flow; null for uploads. */
  sourcePath: string | null;
  /** Set for uploads (the bytes live in the asset store); null for the path flow, and cleared
   * again if an upload is rejected as infected. */
  assetId: string | null;
  status: "scanning" | "ingesting" | "ready" | "failed" | "rejected";
  /** What the malware scan did (ADR-042): null for never-scanned path-based documents. */
  scanStatus: "pending" | "clean" | "infected" | "skipped_no_scanner" | null;
  errorMessage: string | null;
  createdAt: string;
}

export const listFiles = () => request<{ documents: DocumentRecord[] }>("/api/v1/files");
export const ingestFile = (path: string) =>
  request<{ document: DocumentRecord }>("/api/v1/files", { method: "POST", body: JSON.stringify({ path }) });

/** Real multipart upload (ADR-041). Deliberately NOT through `request()`: the browser must set
 * the multipart Content-Type itself (it includes the boundary), so no JSON header here. */
export async function uploadFile(file: File): Promise<{ document: DocumentRecord }> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`${API_URL}/api/v1/files/upload`, { method: "POST", body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Upload failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as { document: DocumentRecord };
}

// --- Memory / settings ---------------------------------------------------------------------

export interface MemoryItem {
  id: string;
  scope: "conversation" | "task" | "user" | "project" | "semantic";
  ownerId: string;
  content: string;
  createdAt: string;
  /**
   * How many times this fact has actually been retrieved into a prompt.
   *
   * The API has always returned it; this type simply did not declare it, so no screen could show
   * it. It is the field that distinguishes a fact quietly shaping every answer from one stored
   * months ago and never recalled — which is exactly what a user inspecting their memory wants to
   * know (ADR-084).
   */
  useCount?: number;
  lastUsedAt?: string | null;
}

export const listMemory = () => request<{ items: MemoryItem[] }>("/api/v1/memory");
export const addMemory = (scope: MemoryItem["scope"], content: string) =>
  request<{ item: MemoryItem }>("/api/v1/memory", { method: "POST", body: JSON.stringify({ scope, content }) });
export const deleteMemory = (id: string) => request<{ ok: true }>(`/api/v1/memory/${id}`, { method: "DELETE" });

export function assetUrl(assetId: string): string {
  return `${API_URL}/api/v1/assets/${assetId}`;
}

export type { GeneratedImage };

/** `POST /api/v1/rag/query` — ADR-076. */
export interface RagSource {
  marker: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  distance: number;
  excerpt: string;
}

export interface RagAnswer {
  question: string;
  answer: string | null;
  sources: RagSource[];
  /**
   * False when the API caught the model answering beyond its evidence (ADR-075). Surfaced rather
   * than folded into the answer text so a caller can tell "nothing matched" from "the model went
   * off-piste and we rejected it" — two different situations with different remedies.
   */
  grounded: boolean;
  groundingViolation?: string;
  groundingReason?: string;
  retrievedCount?: number;
  model?: string;
  provider?: string;
}

export const ragQuery = (question: string, topK?: number) =>
  request<RagAnswer>("/api/v1/rag/query", {
    method: "POST",
    body: JSON.stringify(topK === undefined ? { question } : { question, topK }),
  });
