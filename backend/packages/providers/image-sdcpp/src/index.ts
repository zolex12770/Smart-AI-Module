import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AspectRatio,
  ImageGenerationRequest,
  ImageProvider,
  ImageProviderCapabilities,
  ImageResult,
} from "@ai-platform/shared";

/**
 * Real image generation on the machine itself, through stable-diffusion.cpp — ADR-120.
 *
 * WHY THIS EXISTS. Without image credentials the platform returned `MockImageProvider`'s labelled
 * placeholder SVG, so "generate an image" produced a picture of the words "MOCK IMAGE" on every
 * local deployment. That was honest, and it was not a feature. The other real adapter speaks the
 * OpenAI images wire format, which needs a hosted account or a separate server.
 *
 * stable-diffusion.cpp is one binary plus one GGUF weights file, runs on CPU, and needs no server:
 * SD-Turbo produces a real 512×512 PNG in about 45 seconds on four cores of this machine's i3.
 * That is slow for a person watching a spinner and perfectly fine behind the job queue the image
 * pipeline already runs on (ADR-009's "mock-provider parity" — the mock always went through the
 * same queue precisely so a real, slow provider would need no new orchestration).
 *
 * The discipline is `PiperSpeechProvider`'s, for the same reasons:
 *
 *  - **The prompt is an argument, never a shell string.** `shell: false`, an argv array, and no
 *    interpolation anywhere — a model-authored prompt full of quotes and semicolons is data.
 *  - **A minimal environment.** A child spawned to render someone's prompt has no business seeing
 *    the API's provider keys or database URL.
 *  - **A deadline and a kill.** Generation is minutes of CPU; a hung or pathological run is killed
 *    rather than left holding a worker.
 */
export interface SdCppImageOptions {
  /** Absolute path to `sd-cli` (or `sd`), the stable-diffusion.cpp command-line binary. */
  binaryPath: string;
  /** Absolute path to the model weights (`.gguf` or `.safetensors`). */
  modelPath: string;
  /**
   * Sampling steps. SD-Turbo is a distilled one-step model, and its quality does not improve with
   * more; a non-turbo model needs 20 or so and takes proportionally longer.
   */
  steps?: number;
  /** Classifier-free guidance. Turbo models want 1.0 (no guidance); others 7.0. */
  cfgScale?: number;
  /** Longest edge, in pixels. 512 is SD-Turbo's native size and what the timings above assume. */
  size?: number;
  /** Worker threads for the sampler. Defaults to the binary's own choice. */
  threads?: number;
  /** Hard ceiling on one generation. */
  timeoutMs?: number;
  /** Seam for tests, defaulting to `node:child_process`'s `spawn` (see PiperSpeechProvider). */
  spawnImpl?: typeof spawn;
}

/** Aspect ratios expressed as multipliers of the configured longest edge, rounded to /64. */
const RATIO_SHAPE: Record<AspectRatio, { w: number; h: number }> = {
  "1:1": { w: 1, h: 1 },
  "3:2": { w: 1, h: 2 / 3 },
  "2:3": { w: 2 / 3, h: 1 },
  "4:3": { w: 1, h: 3 / 4 },
  "3:4": { w: 3 / 4, h: 1 },
  "16:9": { w: 1, h: 9 / 16 },
  "9:16": { w: 9 / 16, h: 1 },
};

/** Diffusion models require dimensions that are multiples of 64; anything else fails or warps. */
function dimensionsFor(ratio: AspectRatio, size: number): { width: number; height: number } {
  const shape = RATIO_SHAPE[ratio] ?? RATIO_SHAPE["1:1"];
  const round64 = (value: number) => Math.max(64, Math.round(value / 64) * 64);
  return { width: round64(size * shape.w), height: round64(size * shape.h) };
}

export class SdCppImageProvider implements ImageProvider {
  readonly name = "stable-diffusion.cpp";
  /** A real diffusion model producing a real PNG — nothing here is a stand-in. */
  readonly isMock = false;
  private readonly options: Required<Omit<SdCppImageOptions, "threads" | "spawnImpl">> &
    Pick<SdCppImageOptions, "threads"> & { spawnImpl: typeof spawn };

  constructor(options: SdCppImageOptions) {
    if (!SdCppImageProvider.isAvailable(options.binaryPath, options.modelPath)) {
      throw new Error(
        `stable-diffusion.cpp is not usable: set IMAGE_SD_CLI_PATH to the binary and IMAGE_SD_MODEL_PATH to the weights (looked for "${options.binaryPath}" and "${options.modelPath}").`
      );
    }
    this.options = {
      binaryPath: options.binaryPath,
      modelPath: options.modelPath,
      steps: options.steps ?? 1,
      cfgScale: options.cfgScale ?? 1,
      size: options.size ?? 512,
      threads: options.threads,
      timeoutMs: options.timeoutMs ?? 600_000,
      spawnImpl: options.spawnImpl ?? spawn,
    };
  }

  static isAvailable(binaryPath?: string, modelPath?: string): boolean {
    if (!binaryPath || !modelPath) return false;
    return existsSync(binaryPath) && existsSync(modelPath);
  }

  getCapabilities(): ImageProviderCapabilities {
    return {
      supportsNegativePrompt: true,
      supportsSeed: true,
      // One image per call: each is minutes of CPU, and a caller asking for four would simply
      // wait four times as long with no way to see progress.
      maxImagesPerCall: 1,
      supportedAspectRatios: Object.keys(RATIO_SHAPE) as AspectRatio[],
      // "fast" is the only tier a local CPU has; saying otherwise would promise latency it cannot
      // meet. The request's `quality` is honoured through the step count below.
      hasFastTier: true,
      // One run at a time (see `generateImage`), and the queue workers are sized from this.
      maxConcurrency: 1,
      worstCaseDeadlineMs: this.options.timeoutMs,
    };
  }

  /** The end of the queue of runs; each new one starts only after this settles. */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Runs one generation at a time — found by the autonomous-completion pass. A two-scene video
   * started both scenes' stills at once: two SDXL processes (~4 GB each) beside the chat model
   * on a 15 GB, 4-core machine. Neither went faster, and the kernel's OOM killer took the chat
   * runtime and then one of the two. The image and video queues share this instance, so the
   * serialisation lives here, where both meet; each run's own deadline starts when it starts.
   */
  async generateImage(
    req: ImageGenerationRequest,
    store: (bytes: Buffer, mimeType: string, ext: string) => Promise<string>
  ): Promise<ImageResult> {
    const run = this.tail.then(
      () => this.generateOne(req, store),
      () => this.generateOne(req, store)
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async generateOne(
    req: ImageGenerationRequest,
    store: (bytes: Buffer, mimeType: string, ext: string) => Promise<string>
  ): Promise<ImageResult> {
    const { width, height } = dimensionsFor(req.aspectRatio, this.options.size);
    // A distilled turbo model ignores extra steps; a standard one needs them. `quality` scales
    // what the deployment configured rather than inventing a number of its own.
    const steps = req.quality === "high" ? this.options.steps * 4 : req.quality === "standard" ? this.options.steps * 2 : this.options.steps;
    const dir = await mkdtemp(join(tmpdir(), "sdcpp-"));
    const outPath = join(dir, "image.png");

    const args = [
      "-m", this.options.modelPath,
      "-p", req.prompt,
      "-o", outPath,
      "-W", String(width),
      "-H", String(height),
      "--steps", String(Math.max(1, Math.round(steps))),
      "--cfg-scale", String(this.options.cfgScale),
    ];
    if (req.negativePrompt) args.push("-n", req.negativePrompt);
    if (req.seed !== undefined) args.push("-s", String(req.seed));
    if (this.options.threads !== undefined) args.push("-t", String(this.options.threads));

    try {
      await this.run(args);
      const bytes = await readFile(outPath);
      // A PNG, not merely a file: the first eight bytes are the signature every decoder checks.
      if (bytes.byteLength < 1024 || bytes.subarray(1, 4).toString("ascii") !== "PNG") {
        return {
          status: "failed",
          providerName: this.name,
          error: `stable-diffusion.cpp produced ${bytes.byteLength} bytes that are not a PNG.`,
        };
      }
      const assetId = await store(bytes, "image/png", "png");
      return {
        status: "succeeded",
        providerName: this.name,
        images: [{ assetId, width, height, ...(req.seed !== undefined ? { seed: req.seed } : {}) }],
        providerMeta: { steps: Math.max(1, Math.round(steps)), cfgScale: this.options.cfgScale, model: this.options.modelPath.split(/[\\/]/).pop() },
      };
    } catch (err) {
      // A failure is reported, never substituted with a placeholder (ADR-050).
      return { status: "failed", providerName: this.name, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private run(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.options.spawnImpl(this.options.binaryPath, args, {
        cwd: dirname(this.options.binaryPath),
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.platform === "win32"
            ? { SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "" }
            : { LD_LIBRARY_PATH: [dirname(this.options.binaryPath), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }),
        },
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
        finish(new Error(`stable-diffusion.cpp did not finish within ${this.options.timeoutMs}ms.`));
      }, this.options.timeoutMs);

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 8_000) stderr += chunk.toString("utf8");
      });
      child.once("error", (err) => finish(new Error(`stable-diffusion.cpp could not be started: ${err.message}`)));
      child.once("close", (code) => {
        if (code === 0) finish();
        else finish(new Error(`stable-diffusion.cpp exited with code ${code}: ${stderr.trim().slice(-400)}`));
      });
    });
  }
}
