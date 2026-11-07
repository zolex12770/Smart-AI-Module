import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  AspectRatio,
  ImageGenerationRequest,
  ImageProvider,
  ImageProviderCapabilities,
  ImageResult,
} from "@ai-platform/shared";

export interface LocalEngineImageOptions {
  scriptPath?: string;
  pythonPath?: string;
  size?: number;
  timeoutMs?: number;
}

const RATIO_SHAPE: Record<AspectRatio, { w: number; h: number }> = {
  "1:1": { w: 1, h: 1 },
  "3:2": { w: 1, h: 2 / 3 },
  "2:3": { w: 2 / 3, h: 1 },
  "4:3": { w: 1, h: 3 / 4 },
  "3:4": { w: 3 / 4, h: 1 },
  "16:9": { w: 1, h: 9 / 16 },
  "9:16": { w: 9 / 16, h: 1 },
};

function dimensionsFor(ratio: AspectRatio, size: number): { width: number; height: number } {
  const shape = RATIO_SHAPE[ratio] ?? RATIO_SHAPE["1:1"];
  const round64 = (value: number) => Math.max(64, Math.round(value / 64) * 64);
  return { width: round64(size * shape.w), height: round64(size * shape.h) };
}

export class LocalEngineImageProvider implements ImageProvider {
  readonly name = "local-media-engine";
  readonly isMock = false;
  private readonly scriptPath: string;
  private readonly pythonPath: string;
  private readonly size: number;
  private readonly timeoutMs: number;

  constructor(options: LocalEngineImageOptions = {}) {
    const s1 = resolve("scripts/lib/media_generation_engine.py");
    const s2 = resolve(process.cwd(), "..", "scripts/lib/media_generation_engine.py");
    this.scriptPath = options.scriptPath ?? (existsSync(s1) ? s1 : s2);
    this.pythonPath = options.pythonPath ?? (process.platform === "win32" ? "python" : "python3");
    this.size = options.size ?? 512;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  static isAvailable(scriptPath?: string): boolean {
    const s1 = resolve("scripts/lib/media_generation_engine.py");
    const s2 = resolve(process.cwd(), "..", "scripts/lib/media_generation_engine.py");
    const target = scriptPath ?? (existsSync(s1) ? s1 : s2);
    return existsSync(target);
  }

  getCapabilities(): ImageProviderCapabilities {
    return {
      supportsNegativePrompt: true,
      supportsSeed: true,
      maxImagesPerCall: 1,
      supportedAspectRatios: Object.keys(RATIO_SHAPE) as AspectRatio[],
      hasFastTier: true,
      maxConcurrency: 2,
      worstCaseDeadlineMs: this.timeoutMs,
    };
  }

  async generateImage(
    req: ImageGenerationRequest,
    store: (bytes: Buffer, mimeType: string, ext: string) => Promise<string>,
    signal?: AbortSignal
  ): Promise<ImageResult> {
    if (signal?.aborted) {
      return { status: "failed", providerName: this.name, error: "Cancelled before generation started." };
    }

    const { width, height } = dimensionsFor(req.aspectRatio, this.size);
    const dir = await mkdtemp(join(tmpdir(), "media-gen-"));
    const outPath = join(dir, "out.png");

    const args = [
      this.scriptPath,
      "--image",
      "--prompt", req.prompt,
      "--output", outPath,
      "--width", String(width),
      "--height", String(height),
    ];
    if (req.seed !== undefined) {
      args.push("--seed", String(req.seed));
    }

    try {
      await this.run(args, signal);
      const bytes = await readFile(outPath);
      if (bytes.byteLength < 1024 || bytes.subarray(1, 4).toString("ascii") !== "PNG") {
        return {
          status: "failed",
          providerName: this.name,
          error: `Media engine produced ${bytes.byteLength} bytes that are not a valid PNG.`,
        };
      }

      const assetId = await store(bytes, "image/png", "png");
      return {
        status: "succeeded",
        providerName: this.name,
        images: [{ assetId, width, height, ...(req.seed !== undefined ? { seed: req.seed } : {}) }],
        providerMeta: {
          engine: "procedural-artistic-synthesizer",
          prompt: req.prompt,
          width,
          height,
        },
      };
    } catch (err) {
      return {
        status: "failed",
        providerName: this.name,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private run(args: string[], signal?: AbortSignal): Promise<void> {
    return new Promise((resolveRun, reject) => {
      const child = spawn(this.pythonPath, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolveRun();
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`Media generation engine timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);

      const onAbort = () => {
        child.kill("SIGKILL");
        finish(new Error("Media generation was cancelled."));
      };

      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      child.once("close", () => signal?.removeEventListener("abort", onAbort));

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 4000) stderr += chunk.toString("utf8");
      });

      child.once("error", (err) => finish(new Error(`Media engine could not be executed: ${err.message}`)));
      child.once("close", (code) => {
        if (code === 0) finish();
        else finish(new Error(`Media engine exited with code ${code}: ${stderr.trim()}`));
      });
    });
  }
}
