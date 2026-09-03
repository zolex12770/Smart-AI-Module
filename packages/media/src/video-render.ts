import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetRepository, VideoProjectRepository, VideoSceneRepository } from "@ai-platform/database";
import type { AssetStore } from "./asset-store.js";

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
 */
export async function processVideoRender(deps: VideoRenderDeps, projectId: string): Promise<void> {
  const ffmpegPath = deps.ffmpegPath ?? "ffmpeg";
  const project = await deps.projectRepo.get(projectId);
  if (!project) throw new Error(`video.render job referenced unknown project "${projectId}".`);

  await deps.projectRepo.updateRender(projectId, { renderStatus: "processing" });

  if (!(await isFfmpegAvailable(ffmpegPath))) {
    await deps.projectRepo.updateRender(projectId, {
      renderStatus: "skipped_no_ffmpeg",
      renderError:
        "ffmpeg was not found on PATH in this environment. Every scene generated successfully and " +
        "its clip is available individually via its own asset id; final MP4 packaging was skipped.",
    });
    await deps.projectRepo.updateStatus(projectId, "succeeded");
    return;
  }

  const allScenes = await deps.sceneRepo.listByProject(projectId);
  const succeededScenes = allScenes.filter((s) => s.status === "succeeded" && s.assetId).sort((a, b) => a.sceneIndex - b.sceneIndex);

  const workDir = await mkdtemp(join(tmpdir(), "video-render-"));
  try {
    if (succeededScenes.length === 0) {
      throw new Error("No successfully generated scenes to assemble.");
    }

    const normalizedPaths: string[] = [];
    for (const scene of succeededScenes) {
      const asset = await deps.assetRepo.get(scene.assetId as string);
      if (!asset) throw new Error(`Scene ${scene.sceneIndex} references missing asset "${scene.assetId}".`);
      // ffmpeg needs a real local file, and an asset's bytes may live in Cloud Storage
      // (ADR-040) — materialize every clip into the render's own temp dir through the
      // store, never by reading `asset.storagePath` directly. For the local store this is
      // one extra copy of a small clip; for GCS it is the download that has to happen anyway.
      const ext = asset.mimeType === "image/gif" ? "gif" : asset.storagePath.split(".").pop() ?? "bin";
      const inPath = join(workDir, `clip_${String(scene.sceneIndex).padStart(4, "0")}.${ext}`);
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
    const assetId = await deps.assetStore.store(finalBytes, "video/mp4", "mp4", "video");

    await deps.projectRepo.updateRender(projectId, { renderStatus: "succeeded", renderAssetId: assetId });
    await deps.projectRepo.updateStatus(
      projectId,
      succeededScenes.length === allScenes.length ? "succeeded" : "partially_succeeded"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.projectRepo.updateRender(projectId, { renderStatus: "failed", renderError: message });
    await deps.projectRepo.updateStatus(projectId, "failed", { errorMessage: `Rendering failed: ${message}` });
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
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
