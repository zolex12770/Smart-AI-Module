import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Narration synthesis for the long-form video pipeline — docs/26_DECISIONS.md ADR-079.
 *
 * `video_scenes` has carried a `narration` column and an `audio_asset_id` foreign key since
 * ADR-030, and nothing ever wrote to either: the pipeline planned scenes, generated clips and
 * concatenated them silently. docs/07 Part 2 §2.2 calls for an audio stage, and the product
 * brief names it explicitly. This is that stage.
 *
 * WHY AN ABSTRACTION RATHER THAN ONE IMPLEMENTATION. The two realistic ways to get speech are
 * not alike: a hosted or self-hosted HTTP service speaking OpenAI's `/v1/audio/speech` shape
 * (which covers OpenAI itself, and local servers like Kokoro-FastAPI, openedai-speech and
 * LocalAI), and the operating system's own offline synthesiser. A deployment will have one or
 * the other, and a platform whose promise is "no mandatory hosted AI" cannot make the hosted
 * one the only option.
 *
 * WHAT IS NOT HERE. There is no fallback that emits silence and calls it narration. A pipeline
 * with no speech provider renders without audio and SAYS so (`audioStatus: "skipped_no_speech"`),
 * exactly the way it already reports `skipped_no_ffmpeg`. Substituting silence would be a fake
 * success, and an operator would have no way to tell a working narration stage from a broken one.
 */

export interface SpeechRequest {
  text: string;
  /** Provider-specific voice id. Omitted means the provider's default. */
  voice?: string;
  /** 1.0 is natural. Providers that cannot vary rate ignore it rather than failing. */
  speed?: number;
  signal?: AbortSignal;
}

export interface SpeechResult {
  bytes: Buffer;
  mimeType: string;
  /** File extension WITHOUT the dot, for the asset store's key. */
  ext: string;
}

export interface SpeechProvider {
  readonly name: string;
  /** Always false here. A provider that cannot really speak must not exist (see above). */
  readonly isMock: boolean;
  listVoices(): Promise<string[]>;
  synthesize(request: SpeechRequest): Promise<SpeechResult>;
}

export class SpeechUnavailableError extends Error {
  readonly code = "SPEECH_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "SpeechUnavailableError";
  }
}

/**
 * Any server speaking OpenAI's `/v1/audio/speech` — ADR-079.
 *
 * The same reasoning as ADR-056's chat adapter and ADR-065's image adapter: one widely-copied
 * wire format buys compatibility with a hosted account AND with several self-hostable servers,
 * for one adapter.
 */
export interface OpenAiSpeechOptions {
  /** Base URL including `/v1`, e.g. `http://127.0.0.1:8880/v1`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  defaultVoice?: string;
  /** Hard ceiling on one synthesis call. A hung TTS server must not hang a render job. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OpenAiSpeechProvider implements SpeechProvider {
  readonly name = "openai-speech";
  readonly isMock = false;
  private readonly options: Required<Omit<OpenAiSpeechOptions, "apiKey" | "fetchImpl">> &
    Pick<OpenAiSpeechOptions, "apiKey" | "fetchImpl">;

  constructor(options: OpenAiSpeechOptions) {
    if (!options.baseUrl) throw new SpeechUnavailableError("OpenAiSpeechProvider requires a baseUrl.");
    if (!options.model) throw new SpeechUnavailableError("OpenAiSpeechProvider requires a model.");
    this.options = {
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
      model: options.model,
      defaultVoice: options.defaultVoice ?? "alloy",
      timeoutMs: options.timeoutMs ?? 120_000,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
    };
  }

  /**
   * The endpoint has no discovery call, so this reports what the caller configured rather than
   * inventing a catalogue. Returning a hardcoded list of OpenAI's voice names would be wrong
   * against every self-hosted server, which have their own.
   */
  async listVoices(): Promise<string[]> {
    return [this.options.defaultVoice];
  }

  async synthesize(request: SpeechRequest): Promise<SpeechResult> {
    const doFetch = this.options.fetchImpl ?? fetch;
    // Two ways to stop: the caller's cancellation and our own deadline. Both must abort the
    // in-flight request, so they are combined rather than raced — a race would return early
    // and leave the socket open.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await doFetch(`${this.options.baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.options.model,
          input: request.text,
          voice: request.voice ?? this.options.defaultVoice,
          // WAV rather than mp3: the render stage measures each clip's real duration to build
          // subtitle timings, and an uncompressed container gives an exact answer without a
          // decoder round-trip. ffmpeg re-encodes to AAC at mux time anyway.
          response_format: "wav",
          ...(request.speed !== undefined ? { speed: request.speed } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // The server's own message, not a generic one: "voice not found" and "model not loaded"
        // need different operator actions, and both arrive as a 400.
        const detail = await response.text().catch(() => "");
        throw new SpeechUnavailableError(
          `Speech synthesis failed (${response.status} ${response.statusText})${detail ? `: ${detail.slice(0, 300)}` : ""}`
        );
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        // A zero-byte 200 is the exact shape of a silent fake success, and ffmpeg would later
        // fail on it with something unrecognisable. Fail here, where the cause is obvious.
        throw new SpeechUnavailableError("Speech synthesis returned an empty response body.");
      }
      return { bytes, mimeType: "audio/wav", ext: "wav" };
    } catch (error) {
      if (error instanceof SpeechUnavailableError) throw error;
      if (controller.signal.aborted && !request.signal?.aborted) {
        throw new SpeechUnavailableError(`Speech synthesis exceeded ${this.options.timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * The operating system's own offline synthesiser, via Windows SAPI — ADR-079.
 *
 * Present because "no mandatory hosted AI" has to mean something for audio too. On a Windows
 * host this needs no server, no model download and no network: `System.Speech.Synthesis` is
 * part of .NET and ships with the OS, with real installed voices.
 *
 * It is deliberately platform-guarded rather than silently degrading. On Linux the honest
 * answer is that this provider does not exist, and the composition root should configure the
 * HTTP one (or none, and the pipeline skips narration and says so).
 */
export interface SapiSpeechOptions {
  /** Voice name as SAPI reports it, e.g. "Microsoft Zira Desktop". */
  voice?: string;
  timeoutMs?: number;
  /** Override for tests; defaults to resolving `powershell` on PATH. */
  powershellPath?: string;
}

export class SapiSpeechProvider implements SpeechProvider {
  readonly name = "windows-sapi";
  readonly isMock = false;
  private readonly voice?: string;
  private readonly timeoutMs: number;
  private readonly powershellPath: string;

  constructor(options: SapiSpeechOptions = {}) {
    if (process.platform !== "win32") {
      throw new SpeechUnavailableError("SapiSpeechProvider requires Windows; configure an HTTP speech provider instead.");
    }
    this.voice = options.voice;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.powershellPath = options.powershellPath ?? "powershell";
  }

  static isAvailable(): boolean {
    return process.platform === "win32";
  }

  async listVoices(): Promise<string[]> {
    const script = [
      "Add-Type -AssemblyName System.Speech;",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
      "$s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name };",
      "$s.Dispose()",
    ].join(" ");
    const { stdout } = await execFileAsync(this.powershellPath, ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: this.timeoutMs,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async synthesize(request: SpeechRequest): Promise<SpeechResult> {
    const dir = await mkdtemp(join(tmpdir(), "sapi-"));
    const outPath = join(dir, "narration.wav");
    try {
      /**
       * The text goes in as a base64 argument, NEVER interpolated into the script.
       *
       * This text is narration a MODEL wrote from a user's prompt, so it is untrusted on two
       * counts. Interpolating it into a PowerShell command is command injection with extra
       * steps — a quote and a semicolon would be enough. Base64 has no metacharacters, so the
       * script is fixed and the data is data.
       */
      const encoded = Buffer.from(request.text, "utf8").toString("base64");
      const rate = request.speed === undefined ? 0 : clampSapiRate(request.speed);
      const script = [
        "Add-Type -AssemblyName System.Speech;",
        "$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:SAPI_TEXT_B64));",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
        this.voice ? "$s.SelectVoice($env:SAPI_VOICE);" : "",
        `$s.Rate = ${rate};`,
        "$s.SetOutputToWaveFile($env:SAPI_OUT);",
        "$s.Speak($text);",
        "$s.Dispose()",
      ]
        .filter(Boolean)
        .join(" ");

      await execFileAsync(this.powershellPath, ["-NoProfile", "-NonInteractive", "-Command", script], {
        timeout: this.timeoutMs,
        env: {
          // A minimal environment, for the same reason the terminal tool uses one (ADR-077):
          // this spawns a child to process model-authored text, and that child has no business
          // seeing the API process's secrets.
          PATH: process.env.PATH ?? "",
          SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "",
          SAPI_TEXT_B64: encoded,
          SAPI_OUT: outPath,
          ...(this.voice ? { SAPI_VOICE: this.voice } : {}),
        },
      });

      const bytes = await readFile(outPath);
      if (bytes.byteLength === 0) {
        throw new SpeechUnavailableError("SAPI produced an empty wave file.");
      }
      return { bytes, mimeType: "audio/wav", ext: "wav" };
    } catch (error) {
      if (error instanceof SpeechUnavailableError) throw error;
      throw new SpeechUnavailableError(
        `Windows SAPI synthesis failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * SAPI's rate is an integer in [-10, 10] where 0 is normal, not a multiplier. Mapping keeps the
 * `speed` field meaning the same thing across providers instead of silently meaning two things.
 */
function clampSapiRate(speed: number): number {
  const mapped = Math.round((speed - 1) * 10);
  return Math.max(-10, Math.min(10, mapped));
}
