import { v4 as uuid } from "uuid";
import type {
  VideoProject,
  VideoProjectRepository,
  VideoSceneRepository,
  VideoSceneScope,
} from "@ai-platform/database";
import type { ModelCallMeter, SpeechMeter, VideoProjectRequest, VideoProvider } from "@ai-platform/shared";
import type { JobQueue } from "@ai-platform/jobs";
import { writeVideoScript, type ScriptModel } from "./video-script.js";
import type { SpeechProvider } from "./speech.js";
import { describeFailureForCaller } from "./failure-message.js";
import { watchForCancellation } from "./cancellation-watch.js";
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
  deps: Pick<VideoOrchestrationDeps, "projectRepo" | "sceneRepo"> & {
    scriptModel?: ScriptModel;
    /**
     * Budget and ledger for the storyboard call — ADR-150.
     *
     * `POST /api/v1/videos` checked video-seconds and nothing else, so the storyboard spent real
     * LLM tokens against no budget and wrote no usage row: the dashboard and the monthly total
     * were both short by one model call per video, on the one path outside chat that makes one.
     */
    modelCallMeter?: ModelCallMeter;
  },
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
  // Asked before, recorded after — the rule every other metered path follows (ADR-131).
  await deps.modelCallMeter?.check(input.projectId, input.request.prompt);
  const script = await writeVideoScript({ model: deps.scriptModel }, input.request);
  if (script.provider && script.usage) {
    await deps.modelCallMeter?.record(
      input.projectId,
      {
        provider: script.provider,
        model: script.model ?? "unknown",
        inputTokens: script.usage.inputTokens,
        outputTokens: script.usage.outputTokens,
      },
      {
        userId: input.createdByUserId,
        // One storyboard per video project: a retry of the create cannot charge twice.
        idempotencyKey: `llm:video.storyboard:${input.videoProjectId}`,
      }
    );
  }
  const storedScript = {
    title: script.title,
    scriptSource: script.scriptSource,
    model: script.model,
    fallbackReason: script.fallbackReason,
    scenesWritten: script.scenesWritten,
    scenes: script.scenes.map((scene) => ({
      sceneIndex: scene.sceneIndex,
      shotDescription: scene.shotDescription,
      // `undefined` rather than null for a silent scene: `VideoScriptScene.narration` is
      // optional, and an explicit null would serialise a field that means "absent".
      narration: scene.narration ?? undefined,
      durationSeconds: scene.durationSeconds,
    })),
  };

  const project = await deps.projectRepo.create({
    id: input.videoProjectId,
    projectId: input.projectId,
    createdByUserId: input.createdByUserId,
    prompt: input.request.prompt,
    /**
     * Persisted so the API and the UI can show what was written, and so the distinction between
     * an authored and a mechanical storyboard survives past this function. `scenesWritten` is
     * how much of it the model really wrote (ADR-137): a reply describing two shots for a
     * five-scene video was padded by cycling those two while the project still recorded
     * `scriptSource: "model"` with no qualification.
     */
    script: storedScript,
    targetDurationSeconds: input.request.targetDurationSeconds,
    sceneClipSeconds: input.request.sceneClipSeconds,
    sceneCount: script.scenes.length,
    // Straight into `generating_scenes`: the script stage has already completed by the time this
    // line runs (it is awaited above), so no stage remains that `planning` would be waiting for,
    // and a row parked there forever would be a status that lies about what is happening.
    status: "generating_scenes",
  });
  /**
   * The scenes and the parent row go in together — docs/26_DECISIONS.md ADR-157.
   *
   * This used to be a `create` followed by a `createMany`: two writes with no transaction, so a
   * process that died between them left a video project claiming N scenes with none of them
   * written, which nothing could then repair. `applyScript` was built for exactly this — its
   * docstring says so, and it does the delete-and-replace inside one transaction with the tenant
   * check in the `WHERE` — and it had no caller anywhere: the interface advertised a guarantee no
   * code path provided.
   */
  await deps.projectRepo.applyScript(
    input.projectId,
    input.videoProjectId,
    storedScript,
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

  /**
   * A finished project has nothing to regenerate — unless its RENDER never happened.
   *
   * `processVideoRender` marks the project `succeeded` when it skipped for want of ffmpeg
   * (every scene really did generate, and the clips are individually available), so a
   * deployment that installs ffmpeg afterwards had a project that was permanently un-renderable:
   * this early return sent the retry straight back, and the only Retry control in the product
   * was gated on a failed SCENE, which a render failure precludes by construction
   * (docs/26_DECISIONS.md ADR-157).
   */
  const renderIncomplete = project.renderStatus === "failed" || project.renderStatus === "skipped_no_ffmpeg";
  if (project.status === "succeeded" && !renderIncomplete) return;

  /**
   * A retry spends the cancellation request — docs/26_DECISIONS.md ADR-150.
   *
   * `cancelRequestedAt` had exactly two writers: `create` (null) and `requestCancel` (now).
   * Nothing ever cleared it. So a project that was cancelled could never be retried: this
   * function re-enqueues every scene that is not `succeeded` — which includes the `cancelled`
   * ones — and each worker then reads the same stale flag and cancels the scene again. The
   * project's own errorMessage says "Re-run orchestration…" and the screen offers a Retry
   * button, so the product led the user into a loop that could not terminate.
   *
   * Retrying IS the explicit request to resume, so the earlier request to stop is spent here.
   */
  if (project.cancelRequestedAt) {
    await deps.projectRepo.clearCancelRequest(scope.projectId, scope.videoProjectId);
  }

  // A render that terminally failed still holds the slot it claimed. This function is the
  // explicit-retry entry point (`POST /api/v1/videos/:id/retry`), so hand the slot back —
  // otherwise it is a one-shot latch and the completion check below could never enqueue the
  // second render this retry exists to produce. A `pending`/`processing` render is still in
  // flight and keeps its claim.
  // `skipped_no_ffmpeg` releases too (ADR-157). `releaseRenderSlot`'s own docstring has always
  // said it covers "a failed OR SKIPPED render"; only the failed half was implemented, so the
  // slot stayed latched and the completion check below could never enqueue the second render
  // this retry exists to produce.
  if (renderIncomplete) {
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
  /**
   * Budget and ledger for the narration this job synthesises — ADR-150.
   *
   * Absent in tests and in any deployment with no quota configured; present in the composition
   * root, where it gates the synthesis and writes the `kind: "speech"` row that was missing.
   */
  speechMeter?: SpeechMeter;
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

  /**
   * Already finished — ADR-128's guard, which images had and scenes did not (ADR-150).
   *
   * A re-claimed scene job called the billed video provider a second time. `video.generate_scene`
   * gets a fixed 900s window justified by "it sits above the provider's own 10-minute deadline so
   * the provider always gives up first" — true of the Replicate provider, false of the one a
   * local deployment actually gets: `ImageMotionVideoProvider` generates an IMAGE first and then
   * runs ffmpeg, and neither of those is inside 900s in the worst case. The usage row's
   * `video.scene:<id>` key deduplicates the charge record rather than preventing the charge.
   */
  if (scene.status === "succeeded" || scene.status === "cancelled") return;

  await deps.sceneRepo.updateStatus(scope, sceneId, "processing");

  /**
   * Cancellation, while the provider is still running — ADR-157.
   *
   * The flag was read once, above, and ignored from then on. A video prediction runs for
   * minutes and bills for all of them, so "cancel" that only applies before the call starts is
   * the half that matters least. The watch polls the project row, which the API role writes.
   */
  const watch = watchForCancellation(async () => {
    const current = await deps.projectRepo.get(scope.projectId, scope.videoProjectId);
    return Boolean(current?.cancelRequestedAt);
  });

  try {
    const result = await deps.provider.generateVideo(
      { prompt: scene.shotDescription, sceneIndex: scene.sceneIndex, durationSeconds: scene.durationSeconds },
      // The clip belongs to the tenant that asked for the video (ADR-049) — `assets.project_id`
      // is the scope every later read of these bytes, including the render's, filters on.
      (bytes, mimeType, ext) => deps.assetStore.store(scope.projectId, bytes, mimeType, ext, "video"),
      watch.signal
    );

    if (result.status !== "succeeded" || !result.video) {
      deps.logger?.warn({ sceneId, videoProjectId: scope.videoProjectId, error: result.error }, "video scene failed");
      await deps.sceneRepo.updateStatus(scope, sceneId, "failed", {
        // ADR-155 — a provider's message names its endpoint, and `lastError` is served to the
        // tenant on every scene of the project.
        lastError: describeFailureForCaller("video", result.error ?? "Provider returned no video."),
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
          // Asked before, recorded after — the same rule the embedding paths follow (ADR-131).
          // A refusal throws, and is caught by the same handler that catches a synthesiser
          // failure: the scene keeps its clip and renders silently rather than failing.
          await deps.speechMeter?.check(scope.projectId, narration.length);
          const audio = await deps.speech.synthesize({ text: narration });
          audioAssetId = await deps.assetStore.store(
            scope.projectId,
            audio.bytes,
            audio.mimeType,
            audio.ext,
            "video"
          );
          // Keyed on the scene, so a retry of the same scene does not charge twice.
          await deps.speechMeter?.record(scope.projectId, narration.length, {
            requestId,
            idempotencyKey: `video.scene.narration:${sceneId}`,
          });
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
    if (watch.wasCancelled()) {
      // Not a failure: the user asked for it to stop. Recording it as `failed` would put a
      // defect in the project's own history, and the queue would retry it (ADR-157).
      await deps.sceneRepo.updateStatus(scope, sceneId, "cancelled", {
        lastError: "Cancelled while the provider was generating this scene.",
      });
      await checkProjectCompletion(deps, scope, requestId);
      return;
    }
    deps.logger?.warn({ sceneId, videoProjectId: scope.videoProjectId, error: String(err) }, "video scene threw");
    await deps.sceneRepo.updateStatus(scope, sceneId, "failed", {
      lastError: describeFailureForCaller("video", err),
      incrementRetry: true,
    });
    /**
     * Rethrown, so the queue sees a failure — ADR-150.
     *
     * This catch recorded the scene as failed and returned normally, so pg-boss marked the job
     * COMPLETED. `ensureQueueWithDeadLetter("video.generate_scene", { retryLimit: 1 })` therefore
     * never retried anything and the dead-letter queue never received a video scene: a provider
     * outage lost every scene of every project in it, permanently and silently, while the image
     * and audio processors rethrow for exactly this reason. Completion still runs first, so a
     * project whose last scene failed settles into `partially_succeeded` rather than hanging.
     */
    await checkProjectCompletion(deps, scope, requestId);
    throw err;
  }

  watch.stop();
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
