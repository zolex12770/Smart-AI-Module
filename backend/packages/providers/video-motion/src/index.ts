import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ImageProvider,
  VideoGenerationRequest,
  VideoProvider,
  VideoProviderCapabilities,
  VideoResult,
} from "@ai-platform/shared";

/**
 * Real video clips on this machine, from a real generated still — docs/26_DECISIONS.md ADR-121.
 *
 * WHAT THIS IS, PLAINLY. It asks the configured image provider for one frame and animates it with
 * ffmpeg into an H.264 MP4 of the requested length. It is **not a video diffusion model**: nothing
 * moves in the scene, the motion is a slow push or drift across a still. The name says so
 * (`image-motion`), `getCapabilities()` says so, the provider metadata on every clip says so, and
 * the boot log says so. Calling it "AI video generation" without that sentence would be the kind
 * of claim this repository keeps having to retract.
 *
 * WHY IT EXISTS ANYWAY. The alternative on a machine with no GPU and no Replicate token was
 * `MockVideoProvider`: a 160×90 animated GIF of coloured bars, mislabelled as video by every
 * screen that played it. A real MP4, built from a real generated image of the scene's own prompt,
 * is genuinely useful — it is what the long-form pipeline needs to produce something watchable,
 * with real narration and real subtitles over real pictures — and it is honest about its ceiling.
 * A deployment with a video model points `VIDEO_PROVIDER=replicate` at it and this steps aside.
 *
 * The ffmpeg invocation is an argv array with `shell: false`; the only caller-derived value that
 * reaches it is the still's file path, which this provider wrote itself.
 */
export interface ImageMotionVideoOptions {
  /** Produces the still. Any real `ImageProvider` — the local diffusion model, or a hosted one. */
  imageProvider: ImageProvider;
  ffmpegPath: string;
  fps?: number;
  /** Output size. Defaults to 512×512, which is what the local diffusion model produces fastest. */
  width?: number;
  height?: number;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}

const MAX_DURATION_SECONDS = 30;

export class ImageMotionVideoProvider implements VideoProvider {
  readonly name = "image-motion";
  /**
   * Not a mock: the bytes are a real H.264 MP4 of a real generated image. What it is NOT is a
   * video model, which `getCapabilities()` and the clip's metadata state outright.
   */
  readonly isMock = false;
  private readonly options: Required<Omit<ImageMotionVideoOptions, "spawnImpl" | "imageProvider">> & {
    imageProvider: ImageProvider;
    spawnImpl: typeof spawn;
  };

  constructor(options: ImageMotionVideoOptions) {
    if (!ImageMotionVideoProvider.isAvailable(options.ffmpegPath)) {
      throw new Error(`ffmpeg is not usable at "${options.ffmpegPath}"; set FFMPEG_PATH.`);
    }
    this.options = {
      imageProvider: options.imageProvider,
      ffmpegPath: options.ffmpegPath,
      fps: options.fps ?? 24,
      width: options.width ?? 512,
      height: options.height ?? 512,
      timeoutMs: options.timeoutMs ?? 600_000,
      spawnImpl: options.spawnImpl ?? spawn,
    };
  }

  /** ffmpeg on PATH is not enough to assume: the deployment names the binary it has. */
  static isAvailable(ffmpegPath?: string): boolean {
    if (!ffmpegPath) return false;
    // A bare command name is resolved by the OS; an absolute path must exist.
    return !ffmpegPath.includes("/") && !ffmpegPath.includes("\\") ? true : existsSync(ffmpegPath);
  }

  getCapabilities(): VideoProviderCapabilities {
    const imageCaps = this.options.imageProvider.getCapabilities();
    return {
      maxDurationSeconds: MAX_DURATION_SECONDS,
      supportsSeed: true,
      hasFastTier: true,
      // A still from the image provider, and THEN ffmpeg over it: two deadlines, not one
      // (ADR-150). The image provider's own ceiling when it states one (a deployment can raise
      // IMAGE_SD_TIMEOUT_MS well past the old assumed 600 s), else that documented default.
      worstCaseDeadlineMs: this.options.timeoutMs + (imageCaps.worstCaseDeadlineMs ?? 600_000),
      // Every clip starts with a still, so this runs no more at once than the still's provider.
      ...(imageCaps.maxConcurrency !== undefined ? { maxConcurrency: imageCaps.maxConcurrency } : {}),
    };
  }

  /** One sentence a UI or a log can show, so nobody mistakes this for a video model. */
  get technique(): string {
    return `a generated still (${this.options.imageProvider.name}) animated by ffmpeg — motion, not a video model`;
  }

  async generateVideo(
    req: VideoGenerationRequest,
    store: (bytes: Buffer, mimeType: string, ext: string) => Promise<string>
  ): Promise<VideoResult> {
    if (req.durationSeconds > MAX_DURATION_SECONDS) {
      return {
        status: "failed",
        providerName: this.name,
        error: `Requested duration ${req.durationSeconds}s exceeds this provider's ${MAX_DURATION_SECONDS}s per-call ceiling.`,
      };
    }

    const dir = await mkdtemp(join(tmpdir(), "motion-"));
    try {
      // 1. The frame. Captured as bytes rather than stored: only the finished clip becomes an
      //    asset, so a failed render leaves nothing behind to explain.
      let still: Buffer | null = null;
      const image = await this.options.imageProvider.generateImage(
        {
          prompt: req.prompt,
          aspectRatio: this.options.width === this.options.height ? "1:1" : "16:9",
          quality: "fast",
          ...(req.seed !== undefined ? { seed: req.seed } : {}),
        },
        async (bytes) => {
          still = bytes;
          return "in-memory";
        }
      );
      if (image.status !== "succeeded" || !still) {
        return {
          status: "failed",
          providerName: this.name,
          error: `The still could not be generated: ${image.error ?? "no image returned"}`,
        };
      }

      const stillPath = join(dir, "still.png");
      await writeFile(stillPath, still as Buffer);
      const outPath = join(dir, "clip.mp4");
      await this.render(stillPath, outPath, req);

      const bytes = await readFile(outPath);
      // An MP4's first box is `ftyp`; anything else is not a container a player will open.
      if (bytes.byteLength < 1024 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") {
        return { status: "failed", providerName: this.name, error: `ffmpeg produced ${bytes.byteLength} bytes that are not an MP4.` };
      }

      const assetId = await store(bytes, "video/mp4", "mp4");
      return {
        status: "succeeded",
        providerName: this.name,
        video: {
          assetId,
          width: this.options.width,
          height: this.options.height,
          durationSeconds: req.durationSeconds,
          ...(req.seed !== undefined ? { seed: req.seed } : {}),
        },
        // Carried on every clip so a consumer never has to guess what made it.
        providerMeta: { technique: this.technique, stillProvider: this.options.imageProvider.name, fps: this.options.fps },
      };
    } catch (err) {
      return { status: "failed", providerName: this.name, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Ken Burns: a slow push or drift, alternating by scene so a sequence does not pulse. */
  private render(stillPath: string, outPath: string, req: VideoGenerationRequest): Promise<void> {
    const frames = Math.max(1, Math.round(req.durationSeconds * this.options.fps));
    const { width, height, fps } = this.options;
    // Zoom in on even scenes, out on odd ones. `zoompan` needs the frame count and an output size.
    const zoomIn = req.sceneIndex % 2 === 0;
    const zoomExpression = zoomIn ? `min(zoom+0.0008,1.25)` : `if(lte(zoom,1.0),1.25,max(1.001,zoom-0.0008))`;
    const filter = [
      `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase`,
      `crop=${width * 2}:${height * 2}`,
      `zoompan=z='${zoomExpression}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`,
      "format=yuv420p",
    ].join(",");

    return new Promise((resolve, reject) => {
      const args = [
        "-y",
        "-loop", "1",
        "-i", stillPath,
        "-vf", filter,
        "-t", String(req.durationSeconds),
        "-r", String(fps),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        // A player must be able to start without downloading the whole file first.
        "-movflags", "+faststart",
        outPath,
      ];
      const child = this.options.spawnImpl(this.options.ffmpegPath, args, {
        cwd: dirname(outPath),
        env: { PATH: process.env.PATH ?? "", ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}) },
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      });

      let stderr = "";
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`ffmpeg did not finish within ${this.options.timeoutMs}ms.`));
      }, this.options.timeoutMs);

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 8_000) stderr += chunk.toString("utf8");
      });
      child.once("error", (err) => finish(new Error(`ffmpeg could not be started: ${err.message}`)));
      child.once("close", (code) => {
        if (code === 0) finish();
        else finish(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().slice(-400)}`));
      });
    });
  }
}
