import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImageProvider, VideoGenerationRequest } from "@ai-platform/shared";
import { SdCppImageProvider } from "@ai-platform/image-sdcpp";
import { ImageMotionVideoProvider } from "./index.js";

/**
 * Motion from a real still — docs/26_DECISIONS.md ADR-121.
 *
 * The real half generates a frame with the local diffusion model, animates it, and asks ffprobe
 * what the file is: an MP4 that says "video" in a database row proves nothing. The mechanics half
 * asserts the ffmpeg invocation and every failure path without needing a model on the machine.
 */
const FFMPEG = process.env.FFMPEG_TEST_PATH ?? process.env.FFMPEG_PATH;
const SD_CLI = process.env.IMAGE_SD_CLI_PATH;
const SD_MODEL = process.env.IMAGE_SD_MODEL_PATH;
const canRenderForReal = Boolean(FFMPEG) && SdCppImageProvider.isAvailable(SD_CLI, SD_MODEL);

if (!canRenderForReal) {
  // eslint-disable-next-line no-console
  console.warn("\n  SKIPPING the real motion clip: needs FFMPEG_TEST_PATH plus IMAGE_SD_CLI_PATH/IMAGE_SD_MODEL_PATH.\n");
}

const request = (over: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest => ({
  prompt: "a quiet harbour at sunrise",
  sceneIndex: 0,
  durationSeconds: 2,
  ...over,
});

const ffprobeFor = (ffmpeg: string) => ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith(".exe") ? "ffprobe.exe" : "ffprobe"));

describe.skipIf(!canRenderForReal)("ImageMotionVideoProvider end to end", () => {
  it("produces a playable H.264 MP4 of the requested length from a generated still", async () => {
    const provider = new ImageMotionVideoProvider({
      imageProvider: new SdCppImageProvider({
        binaryPath: SD_CLI as string,
        modelPath: SD_MODEL as string,
        size: 256,
        threads: Number(process.env.IMAGE_SD_THREADS ?? 4),
      }),
      ffmpegPath: FFMPEG as string,
      width: 256,
      height: 256,
      fps: 12,
    });

    let stored: Buffer | null = null;
    const result = await provider.generateVideo(request({ durationSeconds: 2 }), async (bytes, mimeType, ext) => {
      stored = bytes;
      expect(mimeType).toBe("video/mp4");
      expect(ext).toBe("mp4");
      return "asset-clip";
    });

    expect(result.status).toBe("succeeded");
    expect(result.video?.assetId).toBe("asset-clip");
    expect(result.providerName).toBe("image-motion");
    // The metadata says what made it, so nobody downstream mistakes this for a video model.
    expect(String(result.providerMeta?.technique)).toMatch(/not a video model/);

    const dir = mkdtempSync(join(tmpdir(), "motion-probe-"));
    try {
      const path = join(dir, "clip.mp4");
      writeFileSync(path, stored as unknown as Buffer);
      // ffprobe is the arbiter: a real container with a real H.264 stream and a real duration.
      const probe = execFileSync(
        ffprobeFor(FFMPEG as string),
        ["-v", "error", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "json", path],
        { encoding: "utf8", timeout: 60_000 }
      );
      const parsed = JSON.parse(probe) as { streams: { codec_name: string; width: number; height: number }[]; format: { duration: string } };
      expect(parsed.streams[0].codec_name).toBe("h264");
      expect(parsed.streams[0].width).toBe(256);
      expect(parsed.streams[0].height).toBe(256);
      expect(Number(parsed.format.duration)).toBeGreaterThan(1.5);
      expect(Number(parsed.format.duration)).toBeLessThan(3.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 900_000);
});

describe("ImageMotionVideoProvider mechanics", () => {
  let dir: string;
  let ffmpegPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "motion-seam-"));
    ffmpegPath = join(dir, "ffmpeg.exe");
    writeFileSync(ffmpegPath, "stand-in");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const stillProvider = (over: Partial<ImageProvider> = {}): ImageProvider => ({
    name: "stable-diffusion.cpp",
    isMock: false,
    getCapabilities: () => ({
      supportsNegativePrompt: true,
      supportsSeed: true,
      maxImagesPerCall: 1,
      supportedAspectRatios: ["1:1"],
      hasFastTier: true,
    }),
    generateImage: async (_req, store) => {
      await store(Buffer.alloc(2048, 3), "image/png", "png");
      return { status: "succeeded", providerName: "stable-diffusion.cpp", images: [{ assetId: "x", width: 512, height: 512 }] };
    },
    ...over,
  });

  const fakeFfmpeg = (behaviour: { mp4?: boolean; exit?: number; stderr?: string; hang?: boolean }) => {
    const seen: { args: string[]; env: Record<string, string> }[] = [];
    const impl = ((_file: string, args: string[], options: { env?: Record<string, string> }) => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: (s?: string) => void };
      child.stderr = new EventEmitter();
      child.kill = () => undefined;
      seen.push({ args, env: options.env ?? {} });
      setImmediate(() => {
        if (behaviour.hang) return;
        if (behaviour.stderr) child.stderr.emit("data", Buffer.from(behaviour.stderr));
        if (behaviour.mp4 !== false) {
          const out = args[args.length - 1];
          // `ftyp` at offset 4 is what makes a file an MP4 to any player.
          const box = Buffer.alloc(4096, 9);
          box.write("ftyp", 4, "ascii");
          writeFileSync(out, box);
        }
        child.emit("close", behaviour.exit ?? 0);
      });
      return child as unknown as ChildProcess;
    }) as unknown as NonNullable<ConstructorParameters<typeof ImageMotionVideoProvider>[0]["spawnImpl"]>;
    return { impl, seen };
  };

  it("asks ffmpeg for the requested duration, frame rate and codec", async () => {
    const { impl, seen } = fakeFfmpeg({});
    const provider = new ImageMotionVideoProvider({ imageProvider: stillProvider(), ffmpegPath, spawnImpl: impl, fps: 24 });
    const result = await provider.generateVideo(request({ durationSeconds: 5 }), async () => "asset");

    expect(result.status).toBe("succeeded");
    const args = seen[0].args;
    expect(args[args.indexOf("-t") + 1]).toBe("5");
    expect(args[args.indexOf("-r") + 1]).toBe("24");
    expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
    // The still is looped, and the motion filter runs over it.
    expect(args).toContain("-loop");
    expect(args[args.indexOf("-vf") + 1]).toMatch(/zoompan/);
  });

  it("moves in opposite directions on consecutive scenes, so a sequence does not pulse", async () => {
    const even = fakeFfmpeg({});
    await new ImageMotionVideoProvider({ imageProvider: stillProvider(), ffmpegPath, spawnImpl: even.impl }).generateVideo(
      request({ sceneIndex: 0 }),
      async () => "a"
    );
    const odd = fakeFfmpeg({});
    await new ImageMotionVideoProvider({ imageProvider: stillProvider(), ffmpegPath, spawnImpl: odd.impl }).generateVideo(
      request({ sceneIndex: 1 }),
      async () => "a"
    );
    const filterOf = (s: typeof even) => s.seen[0].args[s.seen[0].args.indexOf("-vf") + 1];
    expect(filterOf(even)).not.toBe(filterOf(odd));
  });

  it("fails, rather than rendering something, when the still cannot be generated", async () => {
    const { impl, seen } = fakeFfmpeg({});
    const failing = stillProvider({
      generateImage: async () => ({ status: "failed" as const, providerName: "stable-diffusion.cpp", error: "model missing" }),
    });
    const result = await new ImageMotionVideoProvider({ imageProvider: failing, ffmpegPath, spawnImpl: impl }).generateVideo(
      request(),
      async () => "asset"
    );
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/still could not be generated.*model missing/);
    // ffmpeg was never run: there was nothing to animate.
    expect(seen).toHaveLength(0);
  });

  it("refuses output that is not an MP4", async () => {
    const { impl } = fakeFfmpeg({ mp4: false });
    const result = await new ImageMotionVideoProvider({ imageProvider: stillProvider(), ffmpegPath, spawnImpl: impl }).generateVideo(
      request(),
      async () => "asset"
    );
    expect(result.status).toBe("failed");
  });

  it("reports ffmpeg's own reason when it fails", async () => {
    const { impl } = fakeFfmpeg({ exit: 1, stderr: "Unknown encoder 'libx264'", mp4: false });
    const result = await new ImageMotionVideoProvider({ imageProvider: stillProvider(), ffmpegPath, spawnImpl: impl }).generateVideo(
      request(),
      async () => "asset"
    );
    expect(result.error).toMatch(/Unknown encoder/);
  });

  it("kills a render that outlives its deadline", async () => {
    const { impl } = fakeFfmpeg({ hang: true });
    const result = await new ImageMotionVideoProvider({
      imageProvider: stillProvider(),
      ffmpegPath,
      spawnImpl: impl,
      timeoutMs: 300,
    }).generateVideo(request(), async () => "asset");
    expect(result.error).toMatch(/did not finish within 300ms/);
  });

  it("refuses a clip longer than its per-call ceiling", async () => {
    const { impl } = fakeFfmpeg({});
    const provider = new ImageMotionVideoProvider({ imageProvider: stillProvider(), ffmpegPath, spawnImpl: impl });
    const result = await provider.generateVideo(request({ durationSeconds: 120 }), async () => "asset");
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/ceiling/);
  });

  it("says plainly what it is, and is not a mock", () => {
    const provider = new ImageMotionVideoProvider({ imageProvider: stillProvider(), ffmpegPath, spawnImpl: fakeFfmpeg({}).impl });
    expect(provider.isMock).toBe(false);
    expect(provider.name).toBe("image-motion");
    expect(provider.technique).toMatch(/not a video model/);
  });
});
