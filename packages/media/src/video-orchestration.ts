import { v4 as uuid } from "uuid";
import type {
  VideoProject,
  VideoProjectRepository,
  VideoSceneRepository,
} from "@ai-platform/database";
import type { VideoProjectRequest, VideoProvider } from "@ai-platform/shared";
import type { JobQueue } from "@ai-platform/jobs";
import { planScenes } from "./video-storyboard.js";
import type { LocalAssetStore } from "./asset-store.js";

export interface VideoOrchestrationDeps {
  projectRepo: VideoProjectRepository;
  sceneRepo: VideoSceneRepository;
  jobQueue: JobQueue;
}

export async function createVideoProject(
  deps: Pick<VideoOrchestrationDeps, "projectRepo" | "sceneRepo">,
  id: string,
  request: VideoProjectRequest
): Promise<VideoProject> {
  const planned = planScenes(request);
  const project = await deps.projectRepo.create({
    id,
    prompt: request.prompt,
    targetDurationSeconds: request.targetDurationSeconds,
    sceneClipSeconds: request.sceneClipSeconds,
    sceneCount: planned.length,
  });
  await deps.sceneRepo.createMany(
    planned.map((s) => ({
      id: uuid(),
      projectId: id,
      sceneIndex: s.sceneIndex,
      shotDescription: s.shotDescription,
      durationSeconds: s.durationSeconds,
    }))
  );
  return project;
}

/**
 * The resumability mechanism itself (docs/07 §2.3 point 3): only scenes NOT already
 * `succeeded` are (re-)enqueued. Safe to call repeatedly on the same project — an initial
 * call after `createVideoProject` enqueues every scene; a later call (e.g. after a manual
 * fix to one permanently-failed scene) enqueues only that scene, leaving every already-
 * succeeded scene's asset and row completely untouched.
 */
export async function orchestrateVideoProject(
  deps: VideoOrchestrationDeps,
  projectId: string,
  requestId?: string
): Promise<void> {
  const outstanding = await deps.sceneRepo.listNotSucceeded(projectId);
  for (const scene of outstanding) {
    if (scene.status === "processing") continue; // already in flight; don't double-submit
    // docs/20_OBSERVABILITY.md §3.2 — propagated into the scene job so its worker-side logs
    // (apps/api/src/index.ts's `runJob`) correlate back to the request that created (or
    // retried) this project. `processVideoScene` forwards the same id into
    // `checkProjectCompletion` below, so the eventual `video.render` job carries it too.
    const jobId = await deps.jobQueue.enqueue("video.generate_scene", { sceneId: scene.id, requestId });
    if (jobId) await deps.sceneRepo.updateStatus(scene.id, "pending", { jobId });
  }
  // Reconciles a project that had nothing outstanding (e.g. re-invoked after everything
  // had already succeeded, or every remaining scene was already `processing`).
  await checkProjectCompletion(deps, projectId, requestId);
}

export interface VideoSceneProcessingDeps extends VideoOrchestrationDeps {
  assetStore: LocalAssetStore;
  provider: VideoProvider;
}

/** Runs inside the `video.generate_scene` job worker — one scene, one provider call. */
export async function processVideoScene(deps: VideoSceneProcessingDeps, sceneId: string, requestId?: string): Promise<void> {
  const scene = await deps.sceneRepo.get(sceneId);
  if (!scene) throw new Error(`video.generate_scene job referenced unknown scene "${sceneId}".`);

  await deps.sceneRepo.updateStatus(sceneId, "processing");

  try {
    const result = await deps.provider.generateVideo(
      { prompt: scene.shotDescription, sceneIndex: scene.sceneIndex, durationSeconds: scene.durationSeconds },
      (bytes, mimeType, ext) => deps.assetStore.store(bytes, mimeType, ext, "video")
    );

    if (result.status !== "succeeded" || !result.video) {
      await deps.sceneRepo.updateStatus(sceneId, "failed", {
        lastError: result.error ?? "Provider returned no video.",
        incrementRetry: true,
      });
    } else {
      await deps.sceneRepo.updateStatus(sceneId, "succeeded", { assetId: result.video.assetId });
    }
  } catch (err) {
    await deps.sceneRepo.updateStatus(sceneId, "failed", {
      lastError: err instanceof Error ? err.message : String(err),
      incrementRetry: true,
    });
  }

  await checkProjectCompletion(deps, scene.projectId, requestId);
}

/**
 * Called after every scene settles. Moves the project to `assembling` (and enqueues
 * `video.render`) only once every scene has reached a terminal state and all of them
 * succeeded; otherwise records how many failed so the project ends in an honest
 * `partially_succeeded` state rather than hanging or silently claiming success.
 */
export async function checkProjectCompletion(
  deps: Pick<VideoOrchestrationDeps, "sceneRepo" | "projectRepo" | "jobQueue">,
  projectId: string,
  requestId?: string
): Promise<void> {
  const scenes = await deps.sceneRepo.listByProject(projectId);
  const stillInFlight = scenes.some((s) => s.status === "pending" || s.status === "processing");
  if (stillInFlight) return;

  const allSucceeded = scenes.length > 0 && scenes.every((s) => s.status === "succeeded");
  if (allSucceeded) {
    await deps.projectRepo.updateStatus(projectId, "assembling");
    await deps.jobQueue.enqueue("video.render", { projectId, requestId });
    return;
  }

  const failedCount = scenes.filter((s) => s.status === "failed").length;
  await deps.projectRepo.updateStatus(projectId, "partially_succeeded", {
    errorMessage:
      `${failedCount} of ${scenes.length} scene(s) failed to generate. ` +
      "Re-run orchestration (POST /api/v1/videos/:id/retry) to regenerate only the failed scene(s).",
  });
}
