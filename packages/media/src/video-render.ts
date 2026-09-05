import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetRepository, VideoProjectRepository, VideoSceneRepository } from "@ai-platform/database";
import type { AssetStore } from "./asset-store.js";
import type { VideoProjectScope } from "./video-orchestration.js";

const RENDER_WIDTH = 640;
const RENDER_HEIGHT = 360;
const RENDER_FPS = 24;

export interface VideoRenderDeps {
  projectRepo: VideoProjectRepository;
  sceneRepo: VideoSceneRepository;
  assetRepo: AssetRepository;
  assetStore: AssetStore;
  /** Defaults to `"ffmpeg"` (resolved via PATH). Overridable so tests/deployments can pin a path. */
  ffmpegPath?: string;
}

/**
 * Stage 8 of docs/07 §2.2 ("Rendering"), scoped by the ffmpeg decision recorded in
 * docs/26_DECISIONS.md ADR-030: this shells out to a real system `ffmpeg` binary (safe
 * `spawn` — argument arrays, `shell: false`, same pattern as
 * packages/tools/src/native/terminal.ts) rather than bundling one via npm, because both
 * npm options carried real trade-offs (ffmpeg-static's install-time network fetch of a
 * compiled binary; @ffmpeg-installer/ffmpeg's five-year-stale, likely-CVE-bearing bundled
 * build). If ffmpeg isn't on PATH, the project is still marked `succeeded` — every scene
 * generated correctly — but `renderStatus` honestly records that final MP4 packaging was
 * skipped, rather than fabricating a video file. **The ffmpeg-present branch of this
 * function has not been exercised end-to-end in this environment** (no ffmpeg install
 * available here) — see docs/27_RISKS_AND_LIMITATIONS.md. The commands themselves follow
 * docs/07 §2.2 stage 8's documented approach (normalize each clip with `scale`+`pad`+`fps`
 * before concatenating, concat demuxer for hard cuts) rather than being invented from
 * scratch, but that is not a substitute for having actually run it.
 *
 * `scope` carries the tenant project alongside the video project (ADR-049): the parent row,
 * its scenes, each scene's asset and the final MP4's own `assets` row are all read and
 * written under it, so a `video.render` payload naming another tenant's video resolves to
 * nothing instead of rendering it.
 */
export async function processVideoRender(deps: VideoRenderDeps, scope: VideoProjectScope): Promise<void> {
  const ffmpegPath = deps.ffmpegPath ?? "ffmpeg";
  const project = await deps.projectRepo.get(scope.projectId, scope.videoProjectId);
  if (!project) {
    throw new Error(
      `video.render job referenced unknown project "${scope.videoProjectId}" in project "${scope.projectId}".`
    );
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
    return;
  }

  const allScenes = await deps.sceneRepo.listByVideoProject(scope);
  const succeededScenes = allScenes.filter((s) => s.status === "succeeded" && s.assetId).sort((a, b) => a.sceneIndex - b.sceneIndex);

  const workDir = await mkdtemp(join(tmpdir(), "video-render-"));
  try {
    if (succeededScenes.length === 0) {
      throw new Error("No successfully generated scenes to assemble.");
    }

    const normalizedPaths: string[] = [];
    for (const scene of succeededScenes) {
      const asset = await deps.assetRepo.get(scope.projectId, scene.assetId as string);
      if (!asset) throw new Error(`Scene ${scene.sceneIndex} references missing asset "${scene.assetId}".`);
      // ffmpeg needs a real local file, and an asset's bytes may live in Cloud Storage
      // (ADR-040) — materialize every clip into the render's own temp dir through the
      // store, never by reading `asset.storagePath` directly. For the local store this is
      // one extra copy of a small clip; for GCS it is the download that has to happen anyway.
      const inPath = join(workDir, `clip_${String(scene.sceneIndex).padStart(4, "0")}.${extensionForMimeType(asset.mimeType)}`);
      await writeFile(inPath, await deps.assetStore.read(asset));
      const outPath = join(workDir, `scene_${String(scene.sceneIndex).padStart(4, "0")}.mp4`);
      await runFfmpeg(ffmpegPath, [
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
      normalizedPaths.push(outPath);
    }

    const concatListPath = join(workDir, "concat.txt");
    const concatList = normalizedPaths
      .map((p) => `file '${p.split("\\").join("/").replace(/'/g, "'\\''")}'`)
      .join("\n");
    await writeFile(concatListPath, concatList, "utf8");

    const finalPath = join(workDir, "final.mp4");
    await runFfmpeg(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", finalPath]);

    const finalBytes = await readFile(finalPath);
    // Owned by the same tenant as the clips it was assembled from — nothing else could serve it.
    const assetId = await deps.assetStore.store(scope.projectId, finalBytes, "video/mp4", "mp4", "video");

    await deps.projectRepo.updateRender(scope.projectId, scope.videoProjectId, {
      renderStatus: "succeeded",
      renderAssetId: assetId,
    });
    await deps.projectRepo.updateStatus(
      scope.projectId,
      scope.videoProjectId,
      succeededScenes.length === allScenes.length ? "succeeded" : "partially_succeeded"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.projectRepo.updateRender(scope.projectId, scope.videoProjectId, {
      renderStatus: "failed",
      renderError: message,
    });
    await deps.projectRepo.updateStatus(scope.projectId, scope.videoProjectId, "failed", {
      errorMessage: `Rendering failed: ${message}`,
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

export function isFfmpegAvailable(ffmpegPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ["-version"], { shell: false });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { shell: false });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}
