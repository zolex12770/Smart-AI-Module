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
    const detected: DetectedRuntime = {
      baseUrl: `${host}/v1`,
      chatModel,
      embeddingModel: names.find((n) => EMBEDDING_NAME.test(n)),
      runtime: "ollama",
    };
    logger.info(
      {
        runtime: detected.runtime,
        base_url: detected.baseUrl,
        chat_model: detected.chatModel,
        embedding_model: detected.embeddingModel ?? null,
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
