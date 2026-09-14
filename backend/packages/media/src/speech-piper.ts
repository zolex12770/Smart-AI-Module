import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SpeechUnavailableError, type SpeechProvider, type SpeechRequest, type SpeechResult } from "./speech.js";

/**
 * Offline neural text-to-speech through piper — docs/26_DECISIONS.md ADR-114.
 *
 * WHY THIS EXISTS. The only offline speech path was `SapiSpeechProvider`, which is Windows' own
 * synthesiser: its `isAvailable()` is literally `process.platform === "win32"`. Every Linux
 * deployment — which is every deployment this repository targets — therefore had NO speech unless
 * an operator stood up an HTTP TTS server, so narration, and any audio feature built on it, was a
 * development-only capability wearing a production interface.
 *
 * piper is one static binary plus an ONNX voice, published for Linux x86_64/aarch64/armv7, macOS
 * and Windows. The same provider, the same flags and the same voice file work on a laptop and in a
 * container, which is the property SAPI could never have.
 *
 * Two details are load-bearing:
 *
 *  - **The text goes in on stdin, never in the argument vector.** This text is narration a model
 *    wrote from a user's prompt, so it is untrusted twice over. Arguments are where a long or
 *    hostile string meets the operating system's own parsing (ADR-032 was this project's
 *    argument-injection RCE); stdin is a byte stream with no metacharacters. Newlines are folded
 *    to spaces because piper treats each line as a separate utterance and would otherwise leave
 *    only the last one in the output file.
 *  - **The child gets a minimal environment**, like the sandbox (ADR-055) and SAPI: a process
 *    spawned to read model-authored text has no business seeing the API's provider keys or
 *    database URL. On Linux the binary's own directory is added to `LD_LIBRARY_PATH` so the
 *    shipped `libpiper_phonemize` and `libonnxruntime` resolve with no installer.
 */
export interface PiperSpeechOptions {
  /** Absolute path to the piper executable. */
  binaryPath: string;
  /** Absolute path to a voice `.onnx`; piper reads `<voice>.onnx.json` beside it. */
  voicePath: string;
  /** Hard ceiling on one synthesis. A hung synthesiser must not hang a render job. */
  timeoutMs?: number;
  /**
   * Longest text accepted. Synthesis time is linear in characters, so this bounds one call's
   * share of a worker instead of leaving it to whatever a caller sends.
   */
  maxCharacters?: number;
  /**
   * Seam for tests only, defaulting to `node:child_process`'s `spawn`.
   *
   * The alternative was a stand-in executable, and on Windows there is no safe one: `spawn` with
   * `shell: false` — which is exactly the setting that keeps a model-authored string away from a
   * command interpreter — refuses a `.cmd`/`.bat` wrapper with EINVAL. Injecting the spawn lets
   * the argument vector, the stdin bytes and the child's environment be asserted directly, which
   * is what those tests are actually about; the real binary is still exercised end to end.
   */
  spawnImpl?: typeof spawn;
}

export class PiperSpeechProvider implements SpeechProvider {
  readonly name = "piper";
  /** Real synthesis from a real neural voice — nothing here is a stand-in. */
  readonly isMock = false;
  private readonly binaryPath: string;
  private readonly voicePath: string;
  private readonly timeoutMs: number;
  private readonly maxCharacters: number;
  private readonly spawnImpl: typeof spawn;

  constructor(options: PiperSpeechOptions) {
    if (!PiperSpeechProvider.isAvailable(options.binaryPath, options.voicePath)) {
      throw new SpeechUnavailableError(
        `piper is not usable: set PIPER_PATH to the executable and PIPER_VOICE to a .onnx voice file (looked for "${options.binaryPath}" and "${options.voicePath}").`
      );
    }
    this.binaryPath = options.binaryPath;
    this.voicePath = options.voicePath;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxCharacters = options.maxCharacters ?? 20_000;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  /** Both the binary and the voice must exist; a voice without its JSON is not a voice. */
  static isAvailable(binaryPath?: string, voicePath?: string): boolean {
    if (!binaryPath || !voicePath) return false;
    return existsSync(binaryPath) && existsSync(voicePath) && existsSync(`${voicePath}.json`);
  }

  async listVoices(): Promise<string[]> {
    // piper has no discovery call: a voice IS a file, and this provider is configured with one.
    return [basename(this.voicePath)];
  }

  async synthesize(request: SpeechRequest): Promise<SpeechResult> {
    const text = request.text.replace(/\s+/g, " ").trim();
    if (!text) throw new SpeechUnavailableError("Nothing to synthesise: the text is empty.");
    if (text.length > this.maxCharacters) {
      throw new SpeechUnavailableError(
        `The text is ${text.length} characters; this provider accepts at most ${this.maxCharacters}.`
      );
    }

    const dir = await mkdtemp(join(tmpdir(), "piper-"));
    const outPath = join(dir, "speech.wav");
    const binDir = dirname(this.binaryPath);
    const args = ["--model", this.voicePath, "--output_file", outPath];
    // piper's speed control is the inverse of a rate: a longer length scale is slower speech.
    if (request.speed !== undefined && request.speed > 0) {
      args.push("--length_scale", String(Math.min(4, Math.max(0.25, 1 / request.speed))));
    }

    try {
      await this.run(args, text, binDir, request.signal);
      const bytes = await readFile(outPath);
      // 44 bytes is a bare RIFF header. Anything near that is a failure that exited zero, and
      // returning it would put silence where narration should be.
      if (bytes.byteLength <= 1024) {
        throw new SpeechUnavailableError(`piper produced no audio (${bytes.byteLength} bytes).`);
      }
      return { bytes, mimeType: "audio/wav", ext: "wav" };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private run(args: string[], text: string, cwd: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        ...(process.platform === "win32"
          ? {
              SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "",
              TEMP: process.env.TEMP ?? "",
              TMP: process.env.TMP ?? "",
            }
          : { LD_LIBRARY_PATH: [cwd, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }),
      };
      const child = this.spawnImpl(this.binaryPath, args, {
        cwd,
        env,
        // Never through a shell: the text is model-authored and a shell is a parser (ADR-032).
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
      });

      let stderr = "";
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (err) reject(err);
        else resolve();
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new SpeechUnavailableError(`piper did not finish within ${this.timeoutMs}ms.`));
      }, this.timeoutMs);

      const onAbort = () => {
        child.kill("SIGKILL");
        finish(new SpeechUnavailableError("Speech synthesis was cancelled."));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stderr?.on("data", (chunk: Buffer) => {
        // Bounded: a chatty failure must not accumulate megabytes in the worker.
        if (stderr.length < 8_000) stderr += chunk.toString("utf8");
      });
      child.once("error", (err) => finish(new SpeechUnavailableError(`piper could not be started: ${err.message}`)));
      child.once("close", (code) => {
        if (code === 0) finish();
        else finish(new SpeechUnavailableError(`piper exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
      });

      child.stdin?.on("error", () => undefined);
      child.stdin?.end(`${text}\n`, "utf8");
    });
  }
}
