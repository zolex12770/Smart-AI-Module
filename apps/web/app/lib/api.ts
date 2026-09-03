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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    // Only declare a JSON content-type when there's actually a body — Fastify's default
    // body parser rejects a bodyless request (e.g. DELETE) that claims application/json
    // with FST_ERR_CTP_EMPTY_JSON_BODY, a real 400 caught only by driving this in a real
    // browser (curl doesn't send Content-Type unless told to, so it never hit this).
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
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

export interface VideoProject {
  id: string;
  prompt: string;
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
  /** Set for uploads (the bytes live in the asset store); null for the path flow. */
  assetId: string | null;
  status: "ingesting" | "ready" | "failed";
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
}

export const listMemory = () => request<{ items: MemoryItem[] }>("/api/v1/memory");
export const addMemory = (scope: MemoryItem["scope"], content: string) =>
  request<{ item: MemoryItem }>("/api/v1/memory", { method: "POST", body: JSON.stringify({ scope, content }) });
export const deleteMemory = (id: string) => request<{ ok: true }>(`/api/v1/memory/${id}`, { method: "DELETE" });

export function assetUrl(assetId: string): string {
  return `${API_URL}/api/v1/assets/${assetId}`;
}

export type { GeneratedImage };
