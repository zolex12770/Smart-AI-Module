import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetRepository, VideoProjectRepository, VideoSceneRepository } from "@ai-platform/database";
import type { AssetStore } from "./asset-store.js";
import { describeFailureForCaller } from "./failure-message.js";
import type { VideoProjectScope } from "./video-orchestration.js";
import {
  buildSubtitleCues,
  ffprobePathFor,
  measureAudioDurationSeconds,
  renderSrt,
  renderVtt,
  type SubtitleSceneInput,
} from "./subtitles.js";

const RENDER_WIDTH = 640;
const RENDER_HEIGHT = 360;
const RENDER_FPS = 24;

/**
 * How much shorter than its slot a clip may measure before the render bothers to extend it.
 *
 * Slightly under one frame at `RENDER_FPS`. Durations here come from ffprobe and from
 * frame-quantised encoders, so they land a few milliseconds apart even when nothing is wrong;
 * re-encoding a whole shot to add half a frame would cost quality and time to fix a difference
 * no viewer can perceive.
 */
const SLOT_TOLERANCE_SECONDS = 1 / RENDER_FPS - 0.001;

/**
 * The intermediate narration format. Every per-scene segment is written with exactly these
 * parameters so the concat demuxer is joining streams it can actually join — a segment that
 * disagreed on sample rate or channel count would either be refused or silently resampled into a
 * different length, which is the one thing this stage cannot tolerate. 44.1kHz mono is lossless
 * for every speech synthesiser's output this pipeline accepts and is re-encoded to AAC at the mux
 * anyway; the PCM here only has to be unambiguous.
 */
const NARRATION_SAMPLE_RATE = 44_100;
const NARRATION_PCM_ARGS = ["-ar", String(NARRATION_SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le"];

/**
 * One scene's place on the composed timeline.
 *
 * Held as a single record rather than as parallel arrays because the three consumers — the video
 * concat, the narration concat and the subtitle cues — must all read the SAME numbers. When these
 * lived in separate lists keyed by loop order, they drifted apart, which is the defect ADR-081's
 * composition stage was supposed to have closed.
 */
interface SceneSlot {
  sceneIndex: number;
  /** The spoken line, or null when the shot is silent. Only text produces a caption. */
  narration: string | null;
  /** The normalised clip, before any extension to fill the slot. */
  clipPath: string;
  /** Measured length of `clipPath`; the scene's planned length only if ffprobe declined to answer. */
  clipSeconds: number;
  /** The materialised narration WAV, or null when this scene has no narration asset. */
  narrationPath: string | null;
  /** Measured length of `narrationPath`, null when there is none or it could not be probed. */
  narrationSeconds: number | null;
  /** `max(clipSeconds, narrationSeconds)` — the length picture, audio and captions all use. */
  slotSeconds: number;
}

export interface VideoRenderDeps {
  projectRepo: VideoProjectRepository;
  sceneRepo: VideoSceneRepository;
  assetRepo: AssetRepository;
  assetStore: AssetStore;
  /** Defaults to `"ffmpeg"` (resolved via PATH). Overridable so tests/deployments can pin a path. */
  ffmpegPath?: string;
  /**
   * Wall-clock ceiling for any ONE ffmpeg invocation (ADR-128). Must stay comfortably under the
   * queue's `expireInSeconds`, or pg-boss re-claims the render before ffmpeg has been killed and
   * two of them write the same project.
   */
  ffmpegTimeoutMs?: number;
  /**
   * Wall-clock ceiling for the WHOLE render (ADR-150), shared by every ffmpeg step. Must stay
   * under the queue's `expireInSeconds`, or pg-boss re-claims the render before the worker has
   * given up and two of them compose the same project.
   */
  renderBudgetMs?: number;
}

/**
 * 15 minutes for a single ffmpeg step. Long enough for a long-form concat and mux on a slow CPU
 * (a six-second two-scene render measures under a minute on this machine), short enough to sit
 * well below `video.render`'s claim window.
 */
export const DEFAULT_FFMPEG_TIMEOUT_MS = 900_000;

/**
 * The ceiling for a WHOLE render — docs/26_DECISIONS.md ADR-150.
 *
 * `DEFAULT_FFMPEG_TIMEOUT_MS` bounds one invocation, and the queue's claim window was sized
 * against it as though a render were one invocation. It is not: `processVideoRender` normalises
 * every scene, pads every scene, builds an audio segment per scene, and then concats, muxes and
 * subtitles — 2N+4 to 3N+4 ffmpeg calls, each independently allowed the full 900s. With
 * `targetDurationSeconds` up to 1800 and `sceneClipSeconds` as low as 2, N reaches 900. The
 * worst case ran into days against a twenty-minute window, so pg-boss re-claimed the render and
 * a second worker composed the same project — two ffmpegs writing one output, both eventually
 * calling it succeeded.
 *
 * One hour, shared by every step, with the queue window sized above it so the worker always
 * gives up first. A render that cannot finish inside it fails, loudly, which is the honest
 * outcome; being composed twice was not.
 */
export const DEFAULT_RENDER_BUDGET_MS = 3_600_000;

/** Thrown by the step guard when the project's cancellation request is seen (ADR-157). */
class RenderCancelled extends Error {
  constructor() {
    super("The render was cancelled.");
    this.name = "RenderCancelled";
  }
}

/**
 * What the composed render produced besides the video — ADR-081.
 *
 * Returned rather than only persisted so the caller (and its tests) can assert on it directly,
 * and so a partially-composed render is legible: narration present but subtitles absent is a
 * real state, and it is not the same as either being skipped.
 */
export interface VideoRenderOutcome {
  renderStatus: "succeeded" | "skipped_no_ffmpeg" | "failed";
  assetId: string | null;
  /** Whether a narration track was muxed in, and why not when it was not. */
  audioStatus: "included" | "skipped_no_narration";
  /** Asset id of the sidecar `.srt`, when subtitles were produced. */
  subtitleAssetId: string | null;
  subtitleVttAssetId: string | null;
  /**
   * Asset id of the WebM (VP9 + Opus) rendition, or null when none was produced (DL-19). The MP4
   * alone does not play in a browser built without H.264/AAC, which open-source Chromium is.
   */
  webmAssetId: string | null;
  /** Why the WebM rendition is missing, when it is; null when it was produced. */
  webmError: string | null;
}

/**
 * Stage 8 of docs/07 §2.2 ("Rendering"), scoped by the ffmpeg decision recorded in
 * docs/26_DECISIONS.md ADR-030: this shells out to a real system `ffmpeg` binary (safe
 * `spawn` — argument arrays, `shell: false`, same pattern as
 * backend/packages/tools/src/native/terminal.ts) rather than bundling one via npm, because both
 * npm options carried real trade-offs (ffmpeg-static's install-time network fetch of a
 * compiled binary; @ffmpeg-installer/ffmpeg's five-year-stale, likely-CVE-bearing bundled
 * build). If ffmpeg isn't on PATH, the project is still marked `succeeded` — every scene
 * generated correctly — but `renderStatus` honestly records that final MP4 packaging was
 * skipped, rather than fabricating a video file. The ffmpeg-present branch is exercised
 * against a real binary by video-render/video-longform/video-timeline
 * `.integration.test.ts`, which skip loudly when no capable ffmpeg is configured — the
 * docstring here used to say the branch had never been run, and that stopped being true
 * with ADR-069.
 *
 * `scope` carries the tenant project alongside the video project (ADR-049): the parent row,
 * its scenes, each scene's asset and the final MP4's own `assets` row are all read and
 * written under it, so a `video.render` payload naming another tenant's video resolves to
 * nothing instead of rendering it.
 */
export async function processVideoRender(
  deps: VideoRenderDeps,
  scope: VideoProjectScope
): Promise<VideoRenderOutcome> {
  const ffmpegPath = deps.ffmpegPath ?? "ffmpeg";
  /**
   * One deadline for the whole render, not one per call — ADR-150.
   *
   * Every step draws from the same budget, so the elapsed work is bounded by it however many
   * steps a long-form render turns out to need. A single step is still capped separately, so one
   * wedged ffmpeg cannot silently eat the hour that the remaining scenes needed.
   */
  const budgetMs = deps.renderBudgetMs ?? DEFAULT_RENDER_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const perCallMs = deps.ffmpegTimeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;
  /**
   * Cancellation is observed BETWEEN steps — docs/26_DECISIONS.md ADR-157.
   *
   * `requestCancel` accepts `assembling` (it is one of `IN_FLIGHT_STATUSES`), the screen offers
   * Cancel while a project is in it, and the render never read the flag: it fetched the project
   * only to 404 on a missing row. So pressing Cancel during assembly recorded a request that
   * nothing acted on, and the render ran to completion — through eight ffmpeg invocations, on a
   * project the user had already abandoned.
   *
   * Between steps rather than inside one: an ffmpeg invocation is already bounded by its own
   * deadline, and killing one mid-write would leave a partial file for the next step to read.
   */
  let cancelled = false;
  const stopIfCancelled = async (): Promise<boolean> => {
    if (cancelled) return true;
    const current = await deps.projectRepo.get(scope.projectId, scope.videoProjectId);
    cancelled = Boolean(current?.cancelRequestedAt);
    return cancelled;
  };

  const ffmpeg = async (args: string[]) => {
    if (await stopIfCancelled()) throw new RenderCancelled();
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `The render exceeded its total budget of ${Math.round(budgetMs / 1000)}s and was stopped before ` +
          `the queue could hand it to a second worker.`
      );
    }
    return runFfmpeg(ffmpegPath, args, Math.min(remaining, perCallMs));
  };
  const project = await deps.projectRepo.get(scope.projectId, scope.videoProjectId);
  if (!project) {
    throw new Error(
      `video.render job referenced unknown project "${scope.videoProjectId}" in project "${scope.projectId}".`
    );
  }

  /**
   * Already rendered — ADR-128's guard, which the render did not have (ADR-150).
   *
   * `grep -n "renderStatus ===" video-render.ts` returned nothing. A re-claim re-composed a
   * project that was already finished: the same ffmpeg work again, a second final asset stored
   * against the tenant, and the row rewritten to point at whichever finished last.
   */
  if (project.renderStatus === "succeeded") {
    return {
      renderStatus: "succeeded",
      assetId: project.renderAssetId,
      audioStatus: "included",
      subtitleAssetId: project.subtitleAssetId,
      subtitleVttAssetId: project.subtitleVttAssetId,
      webmAssetId: project.renderWebmAssetId,
      webmError: null,
    };
  }

  /**
   * Cancellation is read before anything else — ADR-157.
   *
   * Ahead of the ffmpeg probe on purpose: a cancelled project must not be recorded as
   * `skipped_no_ffmpeg` and `succeeded`, which is a different claim entirely and the one an
   * operator would have to un-pick later.
   */
  if (project.cancelRequestedAt) {
    await deps.projectRepo.updateRender(scope.projectId, scope.videoProjectId, {
      renderStatus: "failed",
      renderError: "Rendering was cancelled before it started.",
    });
    await deps.projectRepo.updateStatus(scope.projectId, scope.videoProjectId, "cancelled", {
      errorMessage: "Cancelled before rendering started.",
    });
    return {
      renderStatus: "failed",
      assetId: null,
      audioStatus: "skipped_no_narration",
      subtitleAssetId: null,
      subtitleVttAssetId: null,
      webmAssetId: null,
      webmError: null,
    };
  }

  await deps.projectRepo.updateRender(scope.projectId, scope.videoProjectId, { renderStatus: "processing" });

  if (!(await isFfmpegAvailable(ffmpegPath))) {
    await deps.projectRepo.updateRender(scope.projectId, scope.videoProjectId, {
      renderStatus: "skipped_no_ffmpeg",
      renderError:
        "ffmpeg was not found on PATH in this environment. Every scene generated successfully and " +
        "its clip is available individually via its own asset id; final MP4 packaging was skipped.",
    });
    await deps.projectRepo.updateStatus(scope.projectId, scope.videoProjectId, "succeeded");
    return {
      renderStatus: "skipped_no_ffmpeg",
      assetId: null,
      audioStatus: "skipped_no_narration",
      subtitleAssetId: null,
      subtitleVttAssetId: null,
      webmAssetId: null,
      webmError: null,
    };
  }

  const allScenes = await deps.sceneRepo.listByVideoProject(scope);
  const succeededScenes = allScenes.filter((s) => s.status === "succeeded" && s.assetId).sort((a, b) => a.sceneIndex - b.sceneIndex);

  const workDir = await mkdtemp(join(tmpdir(), "video-render-"));
  try {
    if (succeededScenes.length === 0) {
      throw new Error("No successfully generated scenes to assemble.");
    }

    /**
     * ONE TIMELINE FOR PICTURE, NARRATION AND CAPTIONS — ADR-081.
     *
     * This used to be three timelines that all disagreed. The clips were concatenated at their
     * own lengths; the narration WAVs were concatenated back to back with no reference to scene
     * boundaries at all; and `buildSubtitleCues` laid its cues out on a third, `max(clip, audio)`
     * grid. With a 4s clip under 2.5s of narration, scene 2's line started at 2.5s — over the
     * tail of scene 1's shot — and every later scene inherited the accumulated error, while the
     * captions matched neither stream. Nothing failed; the video was simply out of sync, worse
     * with every scene, which is exactly the kind of defect an "it rendered" assertion misses.
     *
     * The fix is to decide one grid up front and make all three obey it: each scene gets a slot
     * of `max(clipSeconds, narrationSeconds)`, its clip is extended to fill the slot by holding
     * the last frame, and its narration is padded with silence to the same length (a silent
     * scene gets pure silence, so it still occupies its slot and the scene after it is not
     * pulled forward). `buildSubtitleCues` then computes the same `max()` from the same measured
     * numbers, so the cue grid is the composed grid rather than a parallel guess — this is the
     * clip extension its docstring already promised and that did not previously exist.
     */
    const ffprobePath = ffprobePathFor(ffmpegPath);
    const slots: SceneSlot[] = [];

    for (const scene of succeededScenes) {
      const asset = await deps.assetRepo.get(scope.projectId, scene.assetId as string);
      if (!asset) throw new Error(`Scene ${scene.sceneIndex} references missing asset "${scene.assetId}".`);
      // ffmpeg needs a real local file, and an asset's bytes may live in Cloud Storage
      // (ADR-040) — materialize every clip into the render's own temp dir through the
      // store, never by reading `asset.storagePath` directly. For the local store this is
      // one extra copy of a small clip; for GCS it is the download that has to happen anyway.
      const stem = String(scene.sceneIndex).padStart(4, "0");
      const inPath = join(workDir, `clip_${stem}.${extensionForMimeType(asset.mimeType)}`);
      await writeFile(inPath, await deps.assetStore.read(asset));
      const outPath = join(workDir, `scene_${stem}.mp4`);
      await ffmpeg([
        "-y",
        "-i",
        inPath,
        "-vf",
        `scale=${RENDER_WIDTH}:${RENDER_HEIGHT}:force_original_aspect_ratio=decrease,pad=${RENDER_WIDTH}:${RENDER_HEIGHT}:(ow-iw)/2:(oh-ih)/2,fps=${RENDER_FPS}`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        outPath,
      ]);

      // Measured off the normalised clip, not taken from `scene.durationSeconds`: what a provider
      // returns is routinely not the length that was requested (the mock quantises to whole
      // frames at 6fps, so a 2s request is a 2.04s GIF), and the frame-rate conversion above can
      // move it again. A slot built from the planned number would be a slot the file does not
      // fill. The planned length is the fallback only when ffprobe declines to answer.
      const clipSeconds = (await measureAudioDurationSeconds(ffprobePath, outPath)) ?? scene.durationSeconds;

      let narrationPath: string | null = null;
      let narrationSeconds: number | null = null;
      if (scene.audioAssetId) {
        const audioAsset = await deps.assetRepo.get(scope.projectId, scene.audioAssetId);
        if (audioAsset) {
          narrationPath = join(workDir, `narration_${stem}.wav`);
          await writeFile(narrationPath, await deps.assetStore.read(audioAsset));
          // Measured, never estimated: a words-per-minute guess drifts and the error accumulates
          // across scenes until the captions describe a different part of the video (ADR-081).
          narrationSeconds = await measureAudioDurationSeconds(ffprobePath, narrationPath);
        }
      }

      slots.push({
        sceneIndex: scene.sceneIndex,
        narration: scene.narration ?? null,
        clipPath: outPath,
        clipSeconds,
        narrationPath,
        narrationSeconds,
        slotSeconds: Math.max(clipSeconds, narrationSeconds ?? 0),
      });
    }

    // Hold the last frame of any shot whose narration outruns it. `tpad` clones that frame for
    // the shortfall rather than cutting to the next scene mid-sentence; `-t` then trims the
    // frame-quantisation overshoot so the slot length is the one the captions were laid out on.
    // A clip already at (or within a frame of) its slot is passed through untouched — a second
    // encode of an unchanged picture costs quality for nothing.
    const timedPaths: string[] = [];
    for (const slot of slots) {
      const shortfall = slot.slotSeconds - slot.clipSeconds;
      if (shortfall <= SLOT_TOLERANCE_SECONDS) {
        timedPaths.push(slot.clipPath);
        continue;
      }
      const paddedPath = join(workDir, `slot_${String(slot.sceneIndex).padStart(4, "0")}.mp4`);
      await ffmpeg([
        "-y",
        "-i",
        slot.clipPath,
        "-vf",
        `tpad=stop_mode=clone:stop_duration=${shortfall.toFixed(3)},fps=${RENDER_FPS}`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-t",
        slot.slotSeconds.toFixed(3),
        paddedPath,
      ]);
      timedPaths.push(paddedPath);
    }

    const concatListPath = join(workDir, "concat.txt");
    await writeFile(concatListPath, timedPaths.map(concatEntry).join("\n"), "utf8");

    const silentPath = join(workDir, "silent.mp4");
    await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", silentPath]);

    const subtitleInputs: SubtitleSceneInput[] = slots.map((slot) => ({
      sceneIndex: slot.sceneIndex,
      narration: slot.narration,
      // The same two measurements the slot above was built from, so `buildSubtitleCues` derives
      // the identical grid. Feeding it the planned duration here is what made the cues a third,
      // disagreeing timeline.
      durationSeconds: slot.clipSeconds,
      audioDurationSeconds: slot.narrationSeconds,
    }));

    let finalPath = silentPath;
    let audioStatus: VideoRenderOutcome["audioStatus"] = "skipped_no_narration";

    /**
     * Narration — docs/07 Part 2 §2.2 stages 5-7, ADR-079/081.
     *
     * Conditional on the scenes actually HAVING narration, which they only do when a script
     * stage ran (ADR-080) and a speech provider was configured (ADR-079). A deployment with
     * neither still renders exactly the video it rendered before, and the outcome says
     * `skipped_no_narration` rather than implying a silent track was intended.
     */
    const narrated = slots.filter((slot) => slot.narrationPath !== null && (slot.narration ?? "").trim() !== "");

    if (narrated.length > 0) {
      // One audio segment per scene, each exactly its slot long, so the narration track is the
      // sum of the same slots the picture is. `-shortest` is still deliberately NOT used at the
      // mux: the two streams are equal by construction here, and if a rounding difference ever
      // made them differ, truncating the picture to the audio would be the wrong repair.
      const segmentPaths: string[] = [];
      for (const slot of slots) {
        const segmentPath = join(workDir, `audio_${String(slot.sceneIndex).padStart(4, "0")}.wav`);
        const duration = slot.slotSeconds.toFixed(3);
        if (slot.narrationPath) {
          // `apad` supplies unlimited trailing silence and `-t` cuts it at the slot, which also
          // trims a narration that measured a hair longer than the slot it was given.
          await ffmpeg([
            "-y",
            "-i",
            slot.narrationPath,
            "-af",
            "apad",
            "-t",
            duration,
            ...NARRATION_PCM_ARGS,
            segmentPath,
          ]);
        } else {
          // A scene nobody speaks over still occupies its slot. Dropping it from the audio track
          // is precisely the bug this rewrite exists to fix: every later line would start early.
          await ffmpeg([
            "-y",
            "-f",
            "lavfi",
            "-i",
            `anullsrc=channel_layout=mono:sample_rate=${NARRATION_SAMPLE_RATE}`,
            "-t",
            duration,
            ...NARRATION_PCM_ARGS,
            segmentPath,
          ]);
        }
        segmentPaths.push(segmentPath);
      }

      const audioListPath = join(workDir, "audio-concat.txt");
      await writeFile(audioListPath, segmentPaths.map(concatEntry).join("\n"), "utf8");
      const narrationPath = join(workDir, "narration.wav");
      // Re-encoded rather than stream-copied: every segment was just written with identical PCM
      // parameters, and letting the WAV muxer rewrite the header keeps the declared length of the
      // concatenated file honest.
      await ffmpeg([
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        audioListPath,
        ...NARRATION_PCM_ARGS,
        narrationPath,
      ]);

      const withAudioPath = join(workDir, "with-audio.mp4");
      await ffmpeg([
        "-y",
        "-i",
        silentPath,
        "-i",
        narrationPath,
        // Copy the video rather than re-encoding it: it was already normalised to H.264 above,
        // and a second encode would cost quality and time for nothing.
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        withAudioPath,
      ]);
      finalPath = withAudioPath;
      audioStatus = "included";
    }

    const cues = buildSubtitleCues(subtitleInputs);
    let subtitleAssetId: string | null = null;
    let subtitleVttAssetId: string | null = null;

    if (cues.length > 0) {
      const srt = renderSrt(cues);
      const srtPath = join(workDir, "subtitles.srt");
      await writeFile(srtPath, srt, "utf8");

      // Muxed as a real `mov_text` track AND stored as sidecars: a downloaded MP4 carries its
      // captions with it, while a browser `<track>` needs a separate WebVTT file it can fetch.
      const withSubsPath = join(workDir, "with-subs.mp4");
      try {
        await ffmpeg([
          "-y",
          "-i",
          finalPath,
          "-i",
          srtPath,
          "-c",
          "copy",
          "-c:s",
          "mov_text",
          "-map",
          "0",
          "-map",
          "1",
          withSubsPath,
        ]);
        finalPath = withSubsPath;
      } catch (subtitleError) {
        // A build without the mov_text encoder must not lose the whole render. The sidecars
        // below still ship, so the captions exist either way — they just are not embedded.
        const detail = subtitleError instanceof Error ? subtitleError.message : String(subtitleError);
        void detail;
      }

      subtitleAssetId = await deps.assetStore.store(
        scope.projectId,
        Buffer.from(srt, "utf8"),
        "application/x-subrip",
        "srt",
        "video"
      );
      subtitleVttAssetId = await deps.assetStore.store(
        scope.projectId,
        Buffer.from(renderVtt(cues), "utf8"),
        "text/vtt",
        "vtt",
        "video"
      );
    }

    const finalBytes = await readFile(finalPath);
    // Owned by the same tenant as the clips it was assembled from — nothing else could serve it.
    const assetId = await deps.assetStore.store(scope.projectId, finalBytes, "video/mp4", "mp4", "video");

    /**
     * The WebM rendition — DL-19.
     *
     * Measured: the Playwright Chromium answered `canPlayType('video/mp4; codecs="avc1.42E01E"')`
     * with "" and the rendered MP4's `<video>` errored, while VP9 WebM answered "probably". Any
     * browser built without the patent-encumbered codecs is in the same position, so the player
     * offers both and lets the browser choose. It is a second output, not a replacement: when
     * this ffmpeg lacks libvpx-vp9 or libopus the MP4 still ships, and the reason is returned.
     * Cancellation is not swallowed — it reaches the handler below like any other step's.
     */
    let webmAssetId: string | null = null;
    let webmError: string | null = null;
    const webmPath = join(workDir, "final.webm");
    try {
      await ffmpeg([
        "-y",
        "-i",
        finalPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libvpx-vp9",
        "-b:v",
        "0",
        "-crf",
        "38",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        "-row-mt",
        "1",
        "-c:a",
        "libopus",
        "-b:a",
        "96k",
        "-sn",
        webmPath,
      ]);
      webmAssetId = await deps.assetStore.store(scope.projectId, await readFile(webmPath), "video/webm", "webm", "video");
    } catch (webmFailure) {
      if (webmFailure instanceof RenderCancelled) throw webmFailure;
      webmError = describeFailureForCaller("render", webmFailure);
    }

    await deps.projectRepo.updateRender(scope.projectId, scope.videoProjectId, {
      renderStatus: "succeeded",
      renderAssetId: assetId,
      // Captions are stored above and were previously discarded here: the SRT and the WebVTT
      // survived as bytes nothing referenced, and the player had no track to show (ADR-122).
      subtitleAssetId,
      subtitleVttAssetId,
      renderWebmAssetId: webmAssetId,
    });
    await deps.projectRepo.updateStatus(
      scope.projectId,
      scope.videoProjectId,
      succeededScenes.length === allScenes.length ? "succeeded" : "partially_succeeded"
    );

    return {
      renderStatus: "succeeded",
      assetId,
      audioStatus,
      subtitleAssetId,
      subtitleVttAssetId,
      webmAssetId,
      webmError,
    };
  } catch (err) {
    if (err instanceof RenderCancelled) {
      // Settled as what it is. `failed` would report a defect where the user made a choice,
      // and `succeeded` would claim a video that was never assembled (ADR-157).
      await deps.projectRepo.updateRender(scope.projectId, scope.videoProjectId, {
        renderStatus: "failed",
        renderError: "Rendering was cancelled before it finished.",
      });
      await deps.projectRepo.updateStatus(scope.projectId, scope.videoProjectId, "cancelled", {
        errorMessage: "Cancelled during rendering.",
      });
      return {
        renderStatus: "failed",
        assetId: null,
        audioStatus: "skipped_no_narration",
        subtitleAssetId: null,
        subtitleVttAssetId: null,
        webmAssetId: null,
        webmError: null,
      };
    }
    /**
     * The stored reason is bounded — docs/26_DECISIONS.md ADR-155.
     *
     * `runFfmpeg` builds its message out of the binary's own stderr, which names the absolute
     * paths of the working directory and every input on the host, and a spawn failure names the
     * ffmpeg binary's path. Both columns are served to the tenant by `GET /api/v1/videos/:id`.
     * The raw text is rethrown, so `runJob`'s error log still has all of it.
     */
    const safe = describeFailureForCaller("render", err);
    await deps.projectRepo.updateRender(scope.projectId, scope.videoProjectId, {
      renderStatus: "failed",
      renderError: safe,
    });
    await deps.projectRepo.updateStatus(scope.projectId, scope.videoProjectId, "failed", {
      errorMessage: safe,
    });
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * The temp-file extension ffmpeg's input is written with, derived from the asset's declared
 * `mimeType`.
 *
 * It used to be parsed out of `asset.storagePath`, which broke the AssetStore contract this
 * file's own comment states two lines above the call site: only the store that wrote that
 * field may interpret it (ADR-040). The bug was not theoretical — a `CloudStorageAssetStore`
 * row is a `gs://bucket/video/<id>.gif` URI whose "extension" is an artifact of the object
 * key, and a store that keyed objects without one would have yielded a suffix taken from the
 * bucket name. `mimeType` is the asset's own description of its bytes, recorded by whichever
 * provider produced them, and is identical under both stores.
 *
 * Unknown types fall back to `.bin` rather than to a guess: ffmpeg demuxes by probing content,
 * not by suffix, so an honest "unknown" costs nothing and a wrong extension only misleads
 * whoever reads a crash dump.
 */
export function extensionForMimeType(mimeType: string): string {
  const EXTENSIONS: Record<string, string> = {
    "image/gif": "gif", // the mock provider's real, playable clips (ADR-030)
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  // Parameters are legal in a media type (`video/mp4; codecs=avc1`) and are not part of it.
  const essence = mimeType.split(";")[0].trim().toLowerCase();
  return EXTENSIONS[essence] ?? "bin";
}

/**
 * One line of a concat-demuxer list file.
 *
 * Backslashes are turned into forward slashes because the demuxer's parser treats `\` as an
 * escape character, so a Windows temp path would be read with its separators eaten; single quotes
 * are escaped the way that parser expects. Shared by the video and audio lists so the two cannot
 * quote paths differently — which is the kind of divergence that shows up only on one platform.
 */
function concatEntry(filePath: string): string {
  return `file '${filePath.split("\\").join("/").replace(/'/g, "'\\''")}'`;
}

export function isFfmpegAvailable(ffmpegPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ["-version"], { shell: false });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Every ffmpeg invocation is bounded — docs/26_DECISIONS.md ADR-128.
 *
 * There was no deadline of any kind here. ffmpeg does not always exit: a malformed input, an
 * unsatisfiable filter graph or a stalled read can leave it running with no progress and no
 * error, and this promise would simply never settle. The worker thread that awaited it was then
 * lost for the lifetime of the process, while pg-boss decided after `expireInSeconds` that the
 * worker had died and handed the SAME render to another one — so the practical outcome of a hang
 * was two ffmpeg processes writing the same project, not one stuck job.
 *
 * SIGTERM first so ffmpeg can close the file it is writing, then SIGKILL: a process that ignores
 * the polite signal is exactly the process this exists for.
 */
const FFMPEG_KILL_GRACE_MS = 5_000;

/**
 * The deadline behaviour, reachable from a test (ADR-128).
 *
 * Exported as a named seam rather than exercised through `processVideoRender`, because proving
 * "a process that never exits is killed" needs a process that never exits — and driving one
 * through the whole render would mean building a project, scenes and assets to reach the first
 * ffmpeg call. The seam is the function itself, not a stand-in for it.
 */
export const runFfmpegForTest = (ffmpegPath: string, args: string[], timeoutMs: number): Promise<void> =>
  runFfmpeg(ffmpegPath, args, timeoutMs);

function runFfmpeg(ffmpegPath: string, args: string[], timeoutMs = DEFAULT_FFMPEG_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { shell: false });
    let stderr = "";
    let timedOut = false;

    const escalate = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), FFMPEG_KILL_GRACE_MS).unref();
    }, timeoutMs);

    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      clearTimeout(escalate);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(escalate);
      if (timedOut) {
        reject(new Error(`ffmpeg exceeded its ${Math.round(timeoutMs / 1000)}s deadline and was killed.`));
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}
