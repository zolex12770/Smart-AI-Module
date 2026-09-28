import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Logger } from "@ai-platform/observability";

/**
 * Finding the model runtime that is already running on this machine — docs/26_DECISIONS.md
 * ADR-118.
 *
 * THE PROBLEM THIS SOLVES. With no `.env`, the platform registered the MOCK language model and the
 * lexical hash embedder — while Ollama sat on 127.0.0.1:11434 with a real chat model and a real
 * embedding model loaded. A new user's first chat was answered by a stub, retrieval ranked by
 * shared vocabulary rather than meaning, and nothing about the screen said so. The setting that
 * would have fixed it (`LLM_BASE_URL`/`LLM_MODEL`) was not in `.env.example` either, so the only
 * way to discover it was to read the source.
 *
 * Detection is deliberately narrow:
 *
 *  - **Explicit configuration always wins.** If `LLM_BASE_URL` and `LLM_MODEL` are set, nothing is
 *    probed. An operator who named a runtime gets that runtime.
 *  - **Never in production.** A production boot must be explicit about what answers its users;
 *    silently adopting whatever happens to listen on a port is how a staging model ends up serving
 *    real traffic. `NODE_ENV=production` skips detection entirely.
 *  - **It is announced, not silent.** The boot log names the runtime, the chat model and the
 *    embedding model it found, and says which variables override them.
 *  - **A failure is not an error.** No runtime, a timeout, or an unparseable answer simply leaves
 *    the platform where it was — on the mock outside production — and logs why.
 */
export interface DetectedRuntime {
  /** OpenAI-compatible base URL, e.g. `http://127.0.0.1:11434/v1`. */
  baseUrl: string;
  chatModel: string;
  embeddingModel?: string;
  /** What answered — for the boot log and `/api/v1/providers`. */
  runtime: "ollama";
  /**
   * The chat model's context window AS THE RUNTIME SERVES IT, in tokens — not the model's
   * trained maximum. qwen2.5:7b is trained to 32768, and Ollama serves it at 4096 unless told
   * otherwise; a prompt past 4096 is truncated silently. See `resolveOllamaContextWindow`.
   */
  contextWindow: number;
  contextWindowSource: "runtime" | "OLLAMA_CONTEXT_LENGTH" | "ollama_default";
}

/** What Ollama serves when neither the server nor the request sets a context length. */
export const OLLAMA_DEFAULT_CONTEXT_LENGTH = 4096;

/**
 * The window the runtime will actually use for `model`.
 *
 * `/api/ps` reports `context_length` for a LOADED model, which is the truth. A model not yet
 * loaded has no answer there; then `OLLAMA_CONTEXT_LENGTH` — the server's own variable, which a
 * compose file sets for both containers — and failing that, Ollama's documented default. The
 * last is the pessimistic choice: guessing low costs an earlier elision of old tool output,
 * guessing high is the silent truncation this exists to prevent.
 */
export async function resolveOllamaContextWindow(
  host: string,
  model: string,
  doFetch: typeof fetch,
  signal?: AbortSignal
): Promise<{ contextWindow: number; source: DetectedRuntime["contextWindowSource"] }> {
  try {
    const response = await doFetch(`${host}/api/ps`, { signal });
    if (response.ok) {
      const body = (await response.json()) as { models?: { name?: string; model?: string; context_length?: number }[] };
      const loaded = (body.models ?? []).find((m) => m.name === model || m.model === model);
      if (loaded && typeof loaded.context_length === "number" && loaded.context_length > 0) {
        return { contextWindow: loaded.context_length, source: "runtime" };
      }
    }
  } catch {
    /* fall through to the configured or default length */
  }
  const configured = Number(process.env.OLLAMA_CONTEXT_LENGTH);
  if (Number.isInteger(configured) && configured > 0) return { contextWindow: configured, source: "OLLAMA_CONTEXT_LENGTH" };
  return { contextWindow: OLLAMA_DEFAULT_CONTEXT_LENGTH, source: "ollama_default" };
}

/** Models Ollama reports; `name` is what the OpenAI-compatible endpoint expects as `model`. */
interface OllamaTag {
  name: string;
  details?: { family?: string };
}

/**
 * An embedding model cannot answer a chat turn, and a chat model cannot be asked for vectors, so
 * the two are chosen separately by name — the one piece of convention Ollama's API does not
 * express in its metadata.
 */
const EMBEDDING_NAME = /embed/i;

/** Preferred chat models in descending order of usefulness for tool-calling agents. */
const CHAT_PREFERENCE = [/qwen2\.5.*(7b|14b|32b)/i, /qwen/i, /llama3/i, /mistral/i, /gemma/i, /phi/i];

export interface DetectOptions {
  /** Where to look. Defaults to `OLLAMA_HOST` if set, else Ollama's own default port. */
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function detectLocalRuntime(
  config: { NODE_ENV: string; LLM_BASE_URL?: string; LLM_MODEL?: string },
  logger: Pick<Logger, "info" | "warn">,
  options: DetectOptions = {}
): Promise<DetectedRuntime | null> {
  if (config.LLM_BASE_URL && config.LLM_MODEL) return null; // explicit configuration wins
  if (config.NODE_ENV === "production") return null; // a production boot names its own model

  const host = options.baseUrl ?? normaliseHost(process.env.OLLAMA_HOST) ?? "http://127.0.0.1:11434";
  const timeoutMs = options.timeoutMs ?? 1500;
  const doFetch = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(`${host}/api/tags`, { signal: controller.signal });
    if (!response.ok) {
      logger.info({ host, status: response.status }, "no local model runtime detected");
      return null;
    }
    const body = (await response.json()) as { models?: OllamaTag[] };
    const names = (body.models ?? []).map((m) => m.name).filter((n) => typeof n === "string" && n.length > 0);
    const chatModel = pickChatModel(names);
    if (!chatModel) {
      logger.warn(
        { host, models: names.length },
        "a local model runtime is running but has no chat model pulled — falling back (try: ollama pull qwen2.5)"
      );
      return null;
    }
    const window = await resolveOllamaContextWindow(host, chatModel, doFetch, controller.signal);
    const detected: DetectedRuntime = {
      baseUrl: `${host}/v1`,
      chatModel,
      embeddingModel: names.find((n) => EMBEDDING_NAME.test(n)),
      runtime: "ollama",
      contextWindow: window.contextWindow,
      contextWindowSource: window.source,
    };
    logger.info(
      {
        runtime: detected.runtime,
        base_url: detected.baseUrl,
        chat_model: detected.chatModel,
        embedding_model: detected.embeddingModel ?? null,
        context_window: detected.contextWindow,
        context_window_source: detected.contextWindowSource,
      },
      "local model runtime detected — using it instead of the mock (override with LLM_BASE_URL/LLM_MODEL, EMBEDDING_BASE_URL/EMBEDDING_MODEL)"
    );
    return detected;
  } catch (err) {
    // Unreachable, slow or unparseable: not an error, just nothing to adopt.
    logger.info(
      { host, reason: err instanceof Error ? err.message : String(err) },
      "no local model runtime detected — using the configured providers"
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The best chat model among those pulled, or undefined when only embedding models exist. */
export function pickChatModel(names: string[]): string | undefined {
  const chatCandidates = names.filter((n) => !EMBEDDING_NAME.test(n));
  if (chatCandidates.length === 0) return undefined;
  for (const preference of CHAT_PREFERENCE) {
    const match = chatCandidates.find((n) => preference.test(n));
    if (match) return match;
  }
  return chatCandidates[0];
}

/** `OLLAMA_HOST` may be `127.0.0.1:11434` or a full URL; both mean the same thing. */
function normaliseHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return /^https?:\/\//i.test(trimmed) ? trimmed.replace(/\/$/, "") : `http://${trimmed.replace(/\/$/, "")}`;
}

/**
 * Does this ffmpeg actually run? — docs/26_DECISIONS.md ADR-129.
 *
 * `isAvailable` answered "a bare command name is resolved by the OS" with `true`, without ever
 * asking the OS. `FFMPEG_PATH` defaults to the bare name `ffmpeg`, so on every machine without
 * ffmpeg installed the platform reported video generation as available, selected a provider that
 * needs it, and settled each render `skipped_no_ffmpeg` — a capability advertised in the API and
 * on the screen that could not produce a frame. An absolute path was checked with `existsSync`; a
 * name on PATH was simply believed.
 *
 * Running `-version` is the only answer that means anything: it resolves the name, proves the
 * binary executes, and costs milliseconds once at boot.
 */
export async function probeFfmpeg(ffmpegPath: string, timeoutMs = 30_000, attempts = 2): Promise<boolean> {
  /**
   * Generous, and retried — found by restarting the compose stack on a cold machine. The probe
   * used a 5 s ceiling; while the model runtime was reading 5 GB from an uncached disk, `ffmpeg
   * -version` took longer than that, the probe answered "not installed", and video generation
   * stayed disabled for the life of the process on a machine that had ffmpeg all along. A binary
   * that is absent fails at once (ENOENT), so a long ceiling costs nothing there; it only waits
   * for one that is present but slow.
   */
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await probeBinary(ffmpegPath, ["-version"], timeoutMs)) return true;
  }
  return false;
}

/**
 * Piper, when it is on PATH and has a voice beside it — ADR-129.
 *
 * The same four rules as the model-runtime probe above: explicit configuration wins, never in
 * production, announced in the boot log, and a failure adopts nothing. A voice is required as
 * well as a binary, because piper without one is a binary that cannot speak, and enabling speech
 * on that basis would replace "no narration" with "every request fails".
 */
export async function detectLocalSpeech(
  config: { NODE_ENV: string; SPEECH_PROVIDER: string; PIPER_PATH?: string; PIPER_VOICE?: string },
  logger: Pick<Logger, "info" | "warn">,
  options: { candidates?: Array<{ binary: string; voice: string }>; probe?: typeof probeBinary } = {}
): Promise<{ binaryPath: string; voicePath: string } | null> {
  if (config.SPEECH_PROVIDER !== "none") return null;
  if (config.NODE_ENV === "production") return null;

  const probe = options.probe ?? probeBinary;
  const candidates = options.candidates ?? defaultPiperCandidates();

  for (const candidate of candidates) {
    if (!existsSync(candidate.voice)) continue;
    if (!(await probe(candidate.binary, ["--help"], 5_000))) continue;
    logger.info(
      { binary: candidate.binary, voice: candidate.voice },
      "local speech synthesiser detected — narration and the audio screen are enabled (override with SPEECH_PROVIDER)"
    );
    return { binaryPath: candidate.binary, voicePath: candidate.voice };
  }
  return null;
}

/** `PIPER_VOICE` alone is enough to opt in when the binary is on PATH under its usual name. */
function defaultPiperCandidates(): Array<{ binary: string; voice: string }> {
  const voice = process.env.PIPER_VOICE;
  return voice ? [{ binary: process.env.PIPER_PATH ?? "piper", voice }] : [];
}

/**
 * Runs a binary and reports whether it exits without the OS refusing to start it.
 *
 * A non-zero exit still counts as present: `--help` returns 1 on several of these tools, and the
 * question here is "does this binary exist and execute", not "did it like its arguments". What
 * must fail is ENOENT, EACCES, and a process that never returns.
 */
export async function probeBinary(command: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      done(false);
    }, timeoutMs);
    try {
      // `shell: false`: these paths come from configuration, and a shell is a parser (ADR-032).
      child = spawn(command, args, { shell: false, stdio: "ignore" });
    } catch {
      done(false);
      return;
    }
    child.on("error", () => done(false));
    child.on("close", () => done(true));
  });
}

/**
 * Asks the default chat model for one token, in the background, so it is loaded before anyone
 * waits on it — see `LLM_WARMUP`. Never throws and never blocks the boot: a failure is logged,
 * and the first real request then simply pays the load as it always did.
 */
export async function warmUpChatModel(
  provider: { name: string; model?: string; streamChat(request: { messages: Array<{ role: "user"; content: string }>; maxOutputTokens?: number }): AsyncIterable<{ type: string }> },
  logger: Pick<Logger, "info" | "warn">,
  now: () => number = Date.now
): Promise<boolean> {
  const started = now();
  try {
    for await (const event of provider.streamChat({ messages: [{ role: "user", content: "Reply with: ok" }], maxOutputTokens: 1 })) {
      if (event.type === "done") {
        logger.info({ provider: provider.name, model: provider.model, ms: now() - started }, "chat model warmed up");
        return true;
      }
      if (event.type === "error") break;
    }
    logger.warn({ provider: provider.name, ms: now() - started }, "chat model warm-up ended without an answer");
  } catch (error) {
    logger.warn({ provider: provider.name, ms: now() - started, error: error instanceof Error ? error.message : String(error) }, "chat model warm-up failed");
  }
  return false;
}
