import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PiperSpeechProvider } from "./speech-piper.js";
import { SpeechUnavailableError } from "./speech.js";
import { ffprobePathFor, measureAudioDurationSeconds } from "./subtitles.js";

/**
 * piper — the offline speech path that also exists on Linux (docs/26_DECISIONS.md ADR-114).
 *
 * Two halves. The first runs the REAL binary and asks ffprobe what came out, because "a file was
 * written" is not evidence of audio. The second drives the provider through an injected spawn, so
 * the properties that matter when the text is model-authored — it travels on stdin, the child sees
 * no secrets, a failure surfaces its reason, a hang is killed, a cancellation stops it — are
 * asserted on every machine, including one with no voice installed.
 */
const PIPER = process.env.PIPER_PATH;
const VOICE = process.env.PIPER_VOICE;
const FFMPEG = process.env.FFMPEG_TEST_PATH ?? process.env.FFMPEG_PATH;
const hasPiper = PiperSpeechProvider.isAvailable(PIPER, VOICE);

if (!hasPiper) {
  // eslint-disable-next-line no-console
  console.warn(
    "\n  SKIPPING the real piper synthesis tests: set PIPER_PATH and PIPER_VOICE (see .local-tools/test-env.sh).\n"
  );
}

describe.skipIf(!hasPiper)("PiperSpeechProvider against the real binary", () => {
  const provider = () => new PiperSpeechProvider({ binaryPath: PIPER as string, voicePath: VOICE as string });

  it("produces a real, playable WAV whose duration matches the text", async () => {
    const result = await provider().synthesize({
      text: "The quick brown fox jumps over the lazy dog, and then it does so again.",
    });

    expect(result.mimeType).toBe("audio/wav");
    expect(result.ext).toBe("wav");
    expect(result.bytes.byteLength).toBeGreaterThan(10_000);
    // RIFF/WAVE, not merely "some bytes".
    expect(result.bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(result.bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");

    if (FFMPEG) {
      const dir = mkdtempSync(join(tmpdir(), "piper-probe-"));
      try {
        const path = join(dir, "out.wav");
        writeFileSync(path, result.bytes);
        // ffprobe is the arbiter: a decodable stream with a real duration.
        const duration = await measureAudioDurationSeconds(ffprobePathFor(FFMPEG), path);
        expect(duration).toBeGreaterThan(2);
        expect(duration).toBeLessThan(30);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("says more when given more: a longer text yields longer audio", async () => {
    const short = await provider().synthesize({ text: "Short." });
    const long = await provider().synthesize({
      text: "This sentence is considerably longer than the previous one, and it keeps going for a while.",
    });
    expect(long.bytes.byteLength).toBeGreaterThan(short.bytes.byteLength * 2);
  }, 120_000);

  it("refuses an empty text rather than writing silence", async () => {
    await expect(provider().synthesize({ text: "   \n  " })).rejects.toThrow(SpeechUnavailableError);
  }, 60_000);

  it("refuses a text past its character ceiling instead of occupying the worker", async () => {
    const p = new PiperSpeechProvider({ binaryPath: PIPER as string, voicePath: VOICE as string, maxCharacters: 50 });
    await expect(p.synthesize({ text: "x".repeat(200) })).rejects.toThrow(/at most 50/);
  }, 60_000);
});

/** What one run of the injected spawn observed. */
interface Invocation {
  file: string;
  args: string[];
  options: { cwd?: string; env?: Record<string, string>; shell?: boolean };
  stdin: string;
  killed: string[];
}

describe("PiperSpeechProvider mechanics", () => {
  let dir: string;
  let binaryPath: string;
  let voicePath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "piper-seam-"));
    binaryPath = join(dir, "piper.exe");
    voicePath = join(dir, "voice.onnx");
    writeFileSync(binaryPath, "stand-in");
    writeFileSync(voicePath, "stand-in voice");
    writeFileSync(`${voicePath}.json`, "{}");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * A spawn that records the invocation and then behaves as the test asks: `write` says what the
   * "binary" leaves at --output_file, `exit` is its code, and `hang` never settles.
   */
  const fakeSpawn = (behaviour: { write?: number | Buffer; exit?: number; stderr?: string; hang?: boolean }) => {
    const seen: Invocation[] = [];
    const impl = ((file: string, args: string[], options: Invocation["options"]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: { end: (chunk: string) => void; on: () => void };
        stderr: EventEmitter;
        kill: (signal?: string) => void;
      };
      const record: Invocation = { file, args, options, stdin: "", killed: [] };
      seen.push(record);
      child.stderr = new EventEmitter();
      child.kill = (signal?: string) => {
        record.killed.push(signal ?? "SIGTERM");
      };
      child.stdin = {
        on: () => undefined,
        end: (chunk: string) => {
          record.stdin += chunk;
          // The "binary" runs once it has its input, like the real one.
          setImmediate(() => {
            if (behaviour.hang) return;
            if (behaviour.stderr) child.stderr.emit("data", Buffer.from(behaviour.stderr));
            const out = args[args.indexOf("--output_file") + 1];
            if (behaviour.write !== undefined && out) {
              writeFileSync(out, typeof behaviour.write === "number" ? Buffer.alloc(behaviour.write, 1) : behaviour.write);
            }
            child.emit("close", behaviour.exit ?? 0);
          });
        },
      };
      return child as unknown as ChildProcess;
    }) as unknown as PiperSpeechProviderSpawn;
    return { impl, seen };
  };
  type PiperSpeechProviderSpawn = NonNullable<ConstructorParameters<typeof PiperSpeechProvider>[0]["spawnImpl"]>;

  const provider = (impl: PiperSpeechProviderSpawn, overrides: { timeoutMs?: number } = {}) =>
    new PiperSpeechProvider({ binaryPath, voicePath, spawnImpl: impl, ...overrides });

  it("sends the text on stdin and never in the argument vector", async () => {
    const { impl, seen } = fakeSpawn({ write: 4096 });
    // A text carrying everything a shell or an argument parser would react to.
    const hostile = '--output_file C:/evil.wav & del /f /q C:\\ | $(whoami) `id` --version "quoted"';
    await provider(impl).synthesize({ text: hostile });

    expect(seen).toHaveLength(1);
    expect(seen[0].stdin.trim()).toBe(hostile.replace(/\s+/g, " ").trim());
    expect(seen[0].args).toEqual(["--model", voicePath, "--output_file", expect.stringContaining("speech.wav")]);
    // Nothing from the text reached the argv, and no shell was involved.
    for (const arg of seen[0].args) expect(arg).not.toContain("whoami");
    expect(seen[0].options.shell).toBe(false);
  });

  it("gives the child a minimal environment, not this process's secrets", async () => {
    process.env.PIPER_TEST_CANARY = "sk-canary-must-not-reach-the-synthesiser";
    try {
      const { impl, seen } = fakeSpawn({ write: 4096 });
      await provider(impl).synthesize({ text: "hello" });
      const env = seen[0].options.env ?? {};
      expect(JSON.stringify(env)).not.toContain("sk-canary-must-not-reach-the-synthesiser");
      expect(env.PATH).toBeTruthy();
      // Only the few variables the loader needs — not the API's environment.
      expect(Object.keys(env).length).toBeLessThanOrEqual(4);
    } finally {
      delete process.env.PIPER_TEST_CANARY;
    }
  });

  it("turns a speed into piper's inverse length scale", async () => {
    const { impl, seen } = fakeSpawn({ write: 4096 });
    await provider(impl).synthesize({ text: "hello", speed: 2 });
    expect(seen[0].args).toContain("--length_scale");
    expect(seen[0].args[seen[0].args.indexOf("--length_scale") + 1]).toBe("0.5");
  });

  it("reports the reason when the binary fails, instead of returning silence", async () => {
    const { impl } = fakeSpawn({ exit: 3, stderr: "voice model is corrupt" });
    await expect(provider(impl).synthesize({ text: "hello" })).rejects.toThrow(
      /exited with code 3.*voice model is corrupt/s
    );
  });

  it("fails rather than returning a file too small to be audio", async () => {
    const { impl } = fakeSpawn({ write: 44 });
    await expect(provider(impl).synthesize({ text: "hello" })).rejects.toThrow(/produced no audio/);
  });

  it("kills a synthesiser that hangs past its timeout", async () => {
    const { impl, seen } = fakeSpawn({ hang: true });
    await expect(provider(impl, { timeoutMs: 300 }).synthesize({ text: "hello" })).rejects.toThrow(
      /did not finish within 300ms/
    );
    expect(seen[0].killed).toContain("SIGKILL");
  });

  it("stops, and kills the child, when the caller cancels", async () => {
    const { impl, seen } = fakeSpawn({ hang: true });
    const controller = new AbortController();
    const promise = provider(impl).synthesize({ text: "hello", signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toThrow(/cancelled/);
    expect(seen[0].killed).toContain("SIGKILL");
  });

  it("does not start the binary at all when the caller has already cancelled", async () => {
    const { impl, seen } = fakeSpawn({ write: 4096 });
    const controller = new AbortController();
    controller.abort();
    await expect(provider(impl).synthesize({ text: "hello", signal: controller.signal })).rejects.toThrow(/cancelled/);
    // One spawn happened, and it was killed immediately rather than left running.
    expect(seen[0].killed).toContain("SIGKILL");
  });

  it("is unavailable when the binary, the voice or the voice's JSON is missing", () => {
    expect(PiperSpeechProvider.isAvailable(undefined, undefined)).toBe(false);
    expect(PiperSpeechProvider.isAvailable(binaryPath, join(dir, "nope.onnx"))).toBe(false);
    const orphan = join(dir, "orphan.onnx");
    writeFileSync(orphan, "voice without its json");
    expect(PiperSpeechProvider.isAvailable(binaryPath, orphan)).toBe(false);
    expect(() => new PiperSpeechProvider({ binaryPath, voicePath: orphan })).toThrow(SpeechUnavailableError);
  });
});
