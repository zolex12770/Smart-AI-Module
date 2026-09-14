import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImageGenerationRequest } from "@ai-platform/shared";
import { SdCppImageProvider } from "./index.js";

/**
 * Real local image generation — docs/26_DECISIONS.md ADR-120.
 *
 * Two halves, like the piper provider. The first drives the REAL binary and checks the PNG that
 * came out, because "a file exists" is not a picture. The second injects a spawn so the argument
 * vector, the environment and the failure paths are asserted everywhere, including on a machine
 * with no model downloaded.
 */
const CLI = process.env.IMAGE_SD_CLI_PATH;
const MODEL = process.env.IMAGE_SD_MODEL_PATH;
const hasSd = SdCppImageProvider.isAvailable(CLI, MODEL);

if (!hasSd) {
  // eslint-disable-next-line no-console
  console.warn("\n  SKIPPING real stable-diffusion.cpp generation: set IMAGE_SD_CLI_PATH and IMAGE_SD_MODEL_PATH.\n");
}

const request = (over: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest => ({
  prompt: "a lighthouse at dawn, painterly",
  aspectRatio: "1:1",
  quality: "fast",
  ...over,
});

/** Width and height straight out of the PNG's IHDR chunk — the file's own answer. */
function pngDimensions(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe.skipIf(!hasSd)("SdCppImageProvider against the real model", () => {
  it("produces a real PNG of the requested size, and stores it", async () => {
    const provider = new SdCppImageProvider({
      binaryPath: CLI as string,
      modelPath: MODEL as string,
      size: 256,
      threads: Number(process.env.IMAGE_SD_THREADS ?? 4),
    });

    let stored: Buffer | null = null;
    const result = await provider.generateImage(request(), async (bytes, mimeType, ext) => {
      stored = bytes;
      expect(mimeType).toBe("image/png");
      expect(ext).toBe("png");
      return "asset-1";
    });

    expect(result.status).toBe("succeeded");
    expect(result.providerName).toBe("stable-diffusion.cpp");
    expect(result.images?.[0].assetId).toBe("asset-1");
    expect(stored).not.toBeNull();
    // A real decodable image at the size that was asked for — not a placeholder, not a stub.
    const dimensions = pngDimensions(stored as unknown as Buffer);
    expect(dimensions).toEqual({ width: 256, height: 256 });
    expect((stored as unknown as Buffer).byteLength).toBeGreaterThan(10_000);
  }, 900_000);
});

describe("SdCppImageProvider mechanics", () => {
  let dir: string;
  let binaryPath: string;
  let modelPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sdcpp-seam-"));
    binaryPath = join(dir, "sd-cli.exe");
    modelPath = join(dir, "model.gguf");
    writeFileSync(binaryPath, "stand-in");
    writeFileSync(modelPath, "stand-in weights");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A spawn that records the invocation and writes whatever the test says the binary produced. */
  const fakeSpawn = (behaviour: { png?: boolean; bytes?: number; exit?: number; stderr?: string; hang?: boolean }) => {
    const seen: { file: string; args: string[]; env: Record<string, string> }[] = [];
    const impl = ((file: string, args: string[], options: { env?: Record<string, string> }) => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: (s?: string) => void };
      child.stderr = new EventEmitter();
      child.kill = () => undefined;
      seen.push({ file, args, env: options.env ?? {} });
      setImmediate(() => {
        if (behaviour.hang) return;
        if (behaviour.stderr) child.stderr.emit("data", Buffer.from(behaviour.stderr));
        const out = args[args.indexOf("-o") + 1];
        if (behaviour.png !== false && out) {
          // A minimal but structurally real PNG: signature, IHDR with the size, and filler.
          const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
          const ihdr = Buffer.alloc(25);
          ihdr.write("IHDR", 4, "ascii");
          ihdr.writeUInt32BE(Number(args[args.indexOf("-W") + 1]), 8);
          ihdr.writeUInt32BE(Number(args[args.indexOf("-H") + 1]), 12);
          writeFileSync(out, Buffer.concat([header, ihdr, Buffer.alloc(behaviour.bytes ?? 4096, 7)]));
        }
        child.emit("close", behaviour.exit ?? 0);
      });
      return child as unknown as ChildProcess;
    }) as unknown as NonNullable<ConstructorParameters<typeof SdCppImageProvider>[0]["spawnImpl"]>;
    return { impl, seen };
  };

  const provider = (impl: ReturnType<typeof fakeSpawn>["impl"], over: Record<string, unknown> = {}) =>
    new SdCppImageProvider({ binaryPath, modelPath, spawnImpl: impl, ...over });

  it("passes the prompt as an argument, never through a shell", async () => {
    const { impl, seen } = fakeSpawn({});
    const hostile = 'a cat"; rm -rf / & echo $(whoami) `id`';
    await provider(impl).generateImage(request({ prompt: hostile }), async () => "asset");

    expect(seen[0].args[seen[0].args.indexOf("-p") + 1]).toBe(hostile);
    expect(seen[0].args).toContain("-m");
    expect(seen[0].args).toContain(modelPath);
  });

  it("asks for dimensions the model can actually produce, in the requested ratio", async () => {
    const { impl, seen } = fakeSpawn({});
    await provider(impl, { size: 512 }).generateImage(request({ aspectRatio: "16:9" }), async () => "asset");
    const width = Number(seen[0].args[seen[0].args.indexOf("-W") + 1]);
    const height = Number(seen[0].args[seen[0].args.indexOf("-H") + 1]);
    // Multiples of 64, which diffusion models require, and roughly 16:9.
    expect(width % 64).toBe(0);
    expect(height % 64).toBe(0);
    expect(width / height).toBeGreaterThan(1.5);
    expect(width / height).toBeLessThan(1.9);
  });

  it("spends more steps only when a higher quality was asked for", async () => {
    const fast = fakeSpawn({});
    await provider(fast.impl, { steps: 1 }).generateImage(request({ quality: "fast" }), async () => "a");
    const high = fakeSpawn({});
    await provider(high.impl, { steps: 1 }).generateImage(request({ quality: "high" }), async () => "a");

    const stepsOf = (s: typeof fast) => Number(s.seen[0].args[s.seen[0].args.indexOf("--steps") + 1]);
    expect(stepsOf(fast)).toBe(1);
    expect(stepsOf(high)).toBe(4);
  });

  it("gives the child a minimal environment, not the API's secrets", async () => {
    process.env.SDCPP_TEST_CANARY = "sk-canary-must-not-reach-the-renderer";
    try {
      const { impl, seen } = fakeSpawn({});
      await provider(impl).generateImage(request(), async () => "asset");
      expect(JSON.stringify(seen[0].env)).not.toContain("sk-canary-must-not-reach-the-renderer");
      expect(seen[0].env.PATH).toBeTruthy();
    } finally {
      delete process.env.SDCPP_TEST_CANARY;
    }
  });

  it("reports a failure instead of substituting a placeholder", async () => {
    const { impl } = fakeSpawn({ exit: 1, stderr: "failed to load model", png: false });
    const result = await provider(impl).generateImage(request(), async () => "asset");
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/failed to load model/);
    expect(result.images).toBeUndefined();
  });

  it("refuses output that is not a PNG", async () => {
    const { impl } = fakeSpawn({ png: false });
    // No file written, so the read fails and the result is a failure — never a fabricated image.
    const result = await provider(impl).generateImage(request(), async () => "asset");
    expect(result.status).toBe("failed");
  });

  it("kills a generation that outlives its deadline", async () => {
    const { impl } = fakeSpawn({ hang: true });
    const result = await provider(impl, { timeoutMs: 300 }).generateImage(request(), async () => "asset");
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/did not finish within 300ms/);
  });

  it("is unavailable without both a binary and weights", () => {
    expect(SdCppImageProvider.isAvailable(undefined, undefined)).toBe(false);
    expect(SdCppImageProvider.isAvailable(binaryPath, join(dir, "missing.gguf"))).toBe(false);
    expect(() => new SdCppImageProvider({ binaryPath, modelPath: join(dir, "missing.gguf") })).toThrow(/not usable/);
  });

  it("declares itself a real provider", () => {
    const p = provider(fakeSpawn({}).impl);
    expect(p.isMock).toBe(false);
    expect(p.getCapabilities().maxImagesPerCall).toBe(1);
  });
});
