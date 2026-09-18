import { v4 as uuid } from "uuid";
import type {
  VideoProject,
  VideoProjectRepository,
  VideoSceneRepository,
  VideoSceneScope,
} from "@ai-platform/database";
import type { VideoProjectRequest, VideoProvider } from "@ai-platform/shared";
import type { JobQueue } from "@ai-platform/jobs";
import { writeVideoScript, type ScriptModel } from "./video-script.js";
import type { SpeechProvider } from "./speech.js";
import type { AssetStore } from "./asset-store.js";

/**
 * Tenant project + long-form video project — the pair every scoped repository call in this
 * pipeline needs (ADR-049). `projectId` is the tenant whose predicate in the SQL `WHERE`
 * makes a read an access control; `videoProjectId` is the video whose scenes these are.
 * Aliased from the database package's `VideoSceneScope` rather than redeclared, so the two
 * can never drift apart.
 */
export type VideoProjectScope = VideoSceneScope;

/**
 * The `video.generate_scene` payload. It carries the whole scope because a worker handed a
 * bare scene id would have no tenant to scope its reads to, and `video_scenes` deliberately
 * exposes no unscoped read: a scene is always reached through its parent (ADR-049).
 */
export interface VideoSceneJobPayload {
  projectId: string;
  videoProjectId: string;
  sceneId: string;
  requestId?: string;
}

/** The `video.render` payload — same reasoning as `VideoSceneJobPayload`. */
export interface VideoRenderJobPayload {
  projectId: string;
  videoProjectId: string;
  requestId?: string;
}

export interface VideoOrchestrationDeps {
  projectRepo: VideoProjectRepository;
  sceneRepo: VideoSceneRepository;
  jobQueue: JobQueue;
}

export interface CreateVideoProjectOptions {
  /** Tenant project the video, its scenes and every asset they produce belong to (ADR-049). */
  projectId: string;
  /** The new video project's own id — distinct from `projectId`, which is the tenant. */
  videoProjectId: string;
  /** Who asked for it; null only for system-initiated work. Never defaulted here. */
  createdByUserId: string | null;
  request: VideoProjectRequest;
}

export async function createVideoProject(
  deps: Pick<VideoOrchestrationDeps, "projectRepo" | "sceneRepo"> & { scriptModel?: ScriptModel },
  input: CreateVideoProjectOptions
): Promise<VideoProject> {
  /**
   * The script and storyboard stages now really run — docs/07 Part 2 §2.2 stages 1-2, ADR-080.
   *
   * This used to call `planScenes` directly, whose entire shot description was the string
   * `"Scene 3 of 7: <the user's prompt>"`. Every scene therefore asked the video provider for
   * the same picture, and nothing was ever narrated. `writeVideoScript` asks a model for a real
   * storyboard and falls back to that same deterministic decomposition when there is no chat
   * provider — recording WHICH happened on the project, because a mechanical decomposition that
   * looks authored is exactly the kind of fake completion this platform refuses.
   */
  const script = await writeVideoScript({ model: deps.scriptModel }, input.request);
  const project = await deps.projectRepo.create({
    id: input.videoProjectId,
    projectId: input.projectId,
    createdByUserId: input.createdByUserId,
    prompt: input.request.prompt,
    // Persisted so the API and the UI can show what was written, and so the distinction between
    // an authored and a mechanical storyboard survives past this function.
    script: {
      title: script.title,
      scriptSource: script.scriptSource,
      model: script.model,
      fallbackReason: script.fallbackReason,
      /**
       * How much of this storyboard the model really wrote — docs/26_DECISIONS.md ADR-137.
       *
       * A reply describing two shots for a five-scene video was padded by cycling those two, and
       * the project still recorded `scriptSource: "model"` with no qualification — so a screen
       * reading "Written by qwen2.5" was describing three shots the model never wrote. Persisted
       * beside the source so the distinction survives the request that made it.
       */
      scenesWritten: script.scenesWritten,
      scenes: script.scenes.map((scene) => ({
        sceneIndex: scene.sceneIndex,
        shotDescription: scene.shotDescription,
        // `undefined` rather than null for a silent scene: `VideoScriptScene.narration` is
        // optional, and an explicit null would serialise a field that means "absent".
        narration: scene.narration ?? undefined,
        durationSeconds: scene.durationSeconds,
      })),
    },
    targetDurationSeconds: input.request.targetDurationSeconds,
    sceneClipSeconds: input.request.sceneClipSeconds,
    sceneCount: script.scenes.length,
    // Straight into `generating_scenes`: the script stage has already completed by the time this
    // line runs (it is awaited above), so no stage remains that `planning` would be waiting for,
    // and a row parked there forever would be a status that lies about what is happening.
    status: "generating_scenes",
  });
  await deps.sceneRepo.createMany(
    { projectId: input.projectId, videoProjectId: input.videoProjectId },
    script.scenes.map((s) => ({
      id: uuid(),
      sceneIndex: s.sceneIndex,
      shotDescription: s.shotDescription,
      // Null when no script stage ran, never an empty string: the audio stage must be able to
      // tell "there is no script" from "this scene is deliberately silent" (ADR-079).
      narration: s.narration,
      durationSeconds: s.durationSeconds,
    }))
  );
  return project;
}

/**
 * The resumability mechanism itself (docs/07 §2.3 point 3): only scenes that still need a
 * generation attempt are (re-)enqueued. Safe to call repeatedly on the same project — an
 * initial call after `createVideoProject` enqueues every scene; a later call (e.g. after a
 * manual fix to one permanently-failed scene) enqueues only that scene, leaving every
 * already-succeeded scene's asset and row completely untouched.
 *
 * "Still needs an attempt" is narrower than "not succeeded", and that difference is the
 * retry defect the audit found. A scene sitting at `pending` **with a job id** has already
 * been enqueued and is only waiting for a free worker; re-submitting it runs the provider
 * twice for one scene and writes two usage rows for work that happened once. Redelivering a
 * job that already exists is pg-boss's responsibility (stale-lock expiry -> requeue, docs/07
 * §1.2), not this function's. A freshly created scene is also `pending` but has no job id
 * yet, which is exactly what distinguishes "never submitted" from "already queued".
 */
export async function orchestrateVideoProject(
  deps: VideoOrchestrationDeps,
  scope: VideoProjectScope,
  requestId?: string
): Promise<void> {
  const project = await deps.projectRepo.get(scope.projectId, scope.videoProjectId);
  if (!project) {
    throw new Error(`Unknown video project "${scope.videoProjectId}" in project "${scope.projectId}".`);
  }

  // The other half of the retry defect: a project that already reached `succeeded` has every
  // scene generated and its render settled, so a retry has nothing to regenerate — it would
  // only spend provider calls and write usage rows for an identical result. The old code
  // went straight to the scene list and, finding nothing outstanding, still fell through to
  // the completion check below.
  if (project.status === "succeeded") return;

  // A render that terminally failed still holds the slot it claimed. This function is the
  // explicit-retry entry point (`POST /api/v1/videos/:id/retry`), so hand the slot back —
  // otherwise it is a one-shot latch and the completion check below could never enqueue the
  // second render this retry exists to produce. A `pending`/`processing` render is still in
  // flight and keeps its claim.
  if (project.renderStatus === "failed") {
    await deps.projectRepo.releaseRenderSlot(scope.videoProjectId);
  }

  const outstanding = await deps.sceneRepo.listNotSucceeded(scope);
  for (const scene of outstanding) {
    if (scene.status === "processing") continue; // in a provider call right now
    if (scene.status === "pending" && scene.jobId !== null) continue; // queued already; see the note above
    // docs/20_OBSERVABILITY.md §3.2 — propagated into the scene job so its worker-side logs
    // (backend/src/index.ts's `runJob`) correlate back to the request that created (or
    // retried) this project. `processVideoScene` forwards the same id into
    // `checkProjectCompletion` below, so the eventual `video.render` job carries it too.
    const jobId = await deps.jobQueue.enqueue<VideoSceneJobPayload>("video.generate_scene", {
      projectId: scope.projectId,
      videoProjectId: scope.videoProjectId,
      sceneId: scene.id,
      requestId,
    });
    if (jobId) await deps.sceneRepo.updateStatus(scope, scene.id, "pending", { jobId });
  }
  // Reconciles a project that had nothing left to submit — every remaining scene was already
  // queued or in flight, or all of them are terminal and only the render still has to be
  // (re-)claimed.
  await checkProjectCompletion(deps, scope, requestId);
}

export interface VideoSceneProcessingDeps extends VideoOrchestrationDeps {
  assetStore: AssetStore;
  provider: VideoProvider;
  /**
   * Narration synthesis (ADR-079). Absent means no speech provider is configured and the scene
   * stays silent — which the render stage then reports as `skipped_no_narration` rather than
   * muxing silence and calling it a voice-over.
   */
  speech?: SpeechProvider;
  logger?: { warn(obj: unknown, msg: string): void };
}

/** Runs inside the `video.generate_scene` job worker — one scene, one provider call. */
export async function processVideoScene(
  deps: VideoSceneProcessingDeps,
  scope: VideoProjectScope,
  sceneId: string,
  requestId?: string
): Promise<void> {
  const scene = await deps.sceneRepo.get(scope, sceneId);
  if (!scene) {
    throw new Error(
      `video.generate_scene job referenced unknown scene "${sceneId}" in video project "${scope.videoProjectId}".`
    );
  }

  /**
   * Cancelled while queued — ADR-122. The project carries the request (`requestCancel`), and
   * nothing used to read it: every scene of a cancelled 900-scene project still generated, and
   * on a billed provider every one was paid for.
   */
  const project = await deps.projectRepo.get(scope.projectId, scope.videoProjectId);
  if (project?.cancelRequestedAt) {
    await deps.sceneRepo.updateStatus(scope, sceneId, "cancelled", { lastError: "Cancelled before generation started." });
    return;
  }

  await deps.sceneRepo.updateStatus(scope, sceneId, "processing");

  try {
    const result = await deps.provider.generateVideo(
      { prompt: scene.shotDescription, sceneIndex: scene.sceneIndex, durationSeconds: scene.durationSeconds },
      // The clip belongs to the tenant that asked for the video (ADR-049) — `assets.project_id`
      // is the scope every later read of these bytes, including the render's, filters on.
      (bytes, mimeType, ext) => deps.assetStore.store(scope.projectId, bytes, mimeType, ext, "video")
    );

    if (result.status !== "succeeded" || !result.video) {
      await deps.sceneRepo.updateStatus(scope, sceneId, "failed", {
        lastError: result.error ?? "Provider returned no video.",
        incrementRetry: true,
      });
    } else {
      /**
       * The narration stage, per scene — docs/07 Part 2 §2.2 stage 5, ADR-079.
       *
       * It runs HERE, in the same job as the clip, rather than in its own queue: the two are
       * the same unit of work for one scene, they retry together, and a separate queue would
       * add a second failure mode (a scene whose clip succeeded and whose audio was dead-lettered
       * elsewhere) for no gain in parallelism that matters at this scale.
       *
       * A failed synthesis does NOT fail the scene. The clip is real and usable, so the scene
       * succeeds with no audio asset and the render composes it silently — degrading the video
       * rather than throwing away work that was already paid for.
       */
      let audioAssetId: string | undefined;
      const narration = (scene.narration ?? "").trim();
      if (deps.speech && narration !== "") {
        try {
          const audio = await deps.speech.synthesize({ text: narration });
          audioAssetId = await deps.assetStore.store(
            scope.projectId,
            audio.bytes,
            audio.mimeType,
            audio.ext,
            "video"
          );
        } catch (error) {
          deps.logger?.warn(
            {
              sceneId,
              videoProjectId: scope.videoProjectId,
              error: error instanceof Error ? error.message : String(error),
            },
            "narration synthesis failed — the scene keeps its clip and renders silently"
          );
        }
      }
      await deps.sceneRepo.updateStatus(scope, sceneId, "succeeded", {
        assetId: result.video.assetId,
        ...(audioAssetId ? { audioAssetId } : {}),
      });
    }
  } catch (err) {
    await deps.sceneRepo.updateStatus(scope, sceneId, "failed", {
      lastError: err instanceof Error ? err.message : String(err),
      incrementRetry: true,
    });
  }

  await checkProjectCompletion(deps, scope, requestId);
}

/**
 * Called after every scene settles. Moves the project to `assembling` (and enqueues
 * `video.render`) only once every scene has reached a terminal state and all of them
 * succeeded; otherwise records how many failed so the project ends in an honest
 * `partially_succeeded` state rather than hanging or silently claiming success.
 *
 * Scene workers run at concurrency 3 (docs/07 §1.6), so the last few scenes settle together
 * and every one of them observes "all succeeded". The audit found that all of them then
 * enqueued `video.render` — duplicate ffmpeg runs, duplicate final assets, one project. A
 * read-then-write guard cannot fix that (both callers read "no render requested yet" before
 * either writes), so the guard is the repository's `claimRenderSlot`: a single
 * `UPDATE ... WHERE render_requested_at IS NULL` that exactly one concurrent caller can
 * match. Only the caller that won the claim enqueues.
 */
export async function checkProjectCompletion(
  deps: Pick<VideoOrchestrationDeps, "sceneRepo" | "projectRepo" | "jobQueue">,
  scope: VideoProjectScope,
  requestId?: string
): Promise<void> {
  const scenes = await deps.sceneRepo.listByVideoProject(scope);
  const stillInFlight = scenes.some((s) => s.status === "pending" || s.status === "processing");
  if (stillInFlight) return;

  const allSucceeded = scenes.length > 0 && scenes.every((s) => s.status === "succeeded");
  if (allSucceeded) {
    // Lost the race to another scene that settled at the same moment: that caller is
    // enqueuing the one render, so this one has nothing left to do.
    if (!(await deps.projectRepo.claimRenderSlot(scope.videoProjectId))) return;
    await deps.projectRepo.updateStatus(scope.projectId, scope.videoProjectId, "assembling");
    try {
      await deps.jobQueue.enqueue<VideoRenderJobPayload>("video.render", {
        projectId: scope.projectId,
        videoProjectId: scope.videoProjectId,
        requestId,
      });
    } catch (err) {
      // The claim is only worth holding if a render job actually exists. Hand it back so a
      // retry (or this scene job's own pg-boss retry) can claim it again, rather than leaving
      // the project stuck in `assembling` with nothing queued to move it on.
      await deps.projectRepo.releaseRenderSlot(scope.videoProjectId);
      throw err;
    }
    return;
  }

  const failedCount = scenes.filter((s) => s.status === "failed").length;
  const cancelledCount = scenes.filter((s) => s.status === "cancelled").length;

  /**
   * A cancelled project says it was cancelled — docs/26_DECISIONS.md ADR-140.
   *
   * `VideoProjectStatus` has always included `"cancelled"` and nothing could ever set it. ADR-122
   * gave the SCENES a cancelled status a worker really observes, but this function only asked
   * "did every scene succeed?" — so a user who stopped their own render found the project marked
   * `partially_succeeded` with the message "0 of 2 scene(s) failed to generate", inviting them to
   * retry the work they had just asked to stop. Nothing failed. They cancelled it, and the only
   * record of that was scene rows nobody reads.
   */
  if (failedCount === 0 && cancelledCount > 0) {
    await deps.projectRepo.updateStatus(scope.projectId, scope.videoProjectId, "cancelled", {
      errorMessage: `Cancelled before ${cancelledCount} of ${scenes.length} scene(s) were generated.`,
    });
    return;
  }

  await deps.projectRepo.updateStatus(scope.projectId, scope.videoProjectId, "partially_succeeded", {
    errorMessage:
      `${failedCount} of ${scenes.length} scene(s) failed to generate` +
      (cancelledCount > 0 ? `, and ${cancelledCount} were cancelled` : "") +
      ". Re-run orchestration (POST /api/v1/videos/:id/retry) to regenerate only the failed scene(s).",
  });
}
