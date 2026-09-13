import { MockImageProvider } from "@ai-platform/image-mock";
import { OpenAICompatibleImageProvider } from "@ai-platform/image-openai";
import { AnthropicProvider } from "@ai-platform/llm-anthropic";
import { GoogleProvider } from "@ai-platform/llm-google";
import { LocalOpenAICompatibleProvider } from "@ai-platform/llm-local";
import { MockLLMProvider } from "@ai-platform/llm-mock";
import { OpenAIProvider } from "@ai-platform/llm-openai";
import type { ModelRegistry } from "@ai-platform/model-router";
import type { Logger } from "@ai-platform/observability";
import type { ImageProvider, VideoProvider } from "@ai-platform/shared";
import { MockVideoProvider } from "@ai-platform/video-mock";
import { ReplicateVideoProvider } from "@ai-platform/video-replicate";
import type { AppConfig } from "./config.js";

/**
 * Provider selection, in a module with NO side effects — docs/26_DECISIONS.md ADR-108.
 *
 * These three factories lived in `index.ts`, whose last statement is `main().catch(...)`. The
 * test that proves no mock is reachable in production imported them from there, so loading the
 * test ran `main()`: it opened a PGlite database at `DATABASE_DIR` (by default the developer's
 * own `./data/pgdata`), registered job workers, spawned the MCP stdio subprocess and called
 * `app.listen` — all as a side effect of an import. Whether that got far enough to do harm was
 * timing-dependent, which is exactly the kind of property a test must not rest on.
 *
 * An entrypoint guard (`import.meta.url === argv[1]`) was rejected: `start:e2e` boots the API
 * with `node -e "import('./dist/index.js')"`, where `argv[1]` is undefined, so the guard would
 * quietly stop the E2E server from starting. Moving the functions removes the side effect at its
 * source and leaves every way of launching `index.js` working.
 */

/**
 * The image provider for this deployment, or null when there is none — ADR-101.
 *
 * Extracted from `main()` so the "no fake implementation in production" rule is something a
 * TEST asserts rather than something a grep guesses at. The CI gate for it used to be
 * `grep -rn "new Mock" backend/src | grep -v NODE_ENV`, which was wrong in both directions: the
 * LLM guard sits on the line ABOVE its construction, so the gate fired on correct code and the
 * security job could never pass; and a trailing `// NODE_ENV` comment would have defeated it.
 * A behavioural check cannot be fooled by where a line break falls.
 */
export function selectImageProvider(config: AppConfig): ImageProvider | null {
  const realImageProvider =
    config.IMAGE_BASE_URL && config.IMAGE_MODEL
      ? new OpenAICompatibleImageProvider({
          baseUrl: config.IMAGE_BASE_URL,
          model: config.IMAGE_MODEL,
          apiKey: config.IMAGE_API_KEY,
          supportsNegativePrompt: config.IMAGE_SUPPORTS_NEGATIVE_PROMPT,
          supportsSeed: config.IMAGE_SUPPORTS_SEED,
        })
      : null;
  return realImageProvider ?? (config.NODE_ENV !== "production" ? new MockImageProvider() : null);
}

/** The video provider for this deployment, or null when there is none — ADR-101, as above. */
export function selectVideoProvider(config: AppConfig): VideoProvider | null {
  const realVideoProvider =
    config.VIDEO_PROVIDER === "replicate" && config.VIDEO_API_TOKEN && config.VIDEO_MODEL_VERSION
      ? new ReplicateVideoProvider({
          apiToken: config.VIDEO_API_TOKEN,
          modelVersion: config.VIDEO_MODEL_VERSION,
        })
      : null;
  return realVideoProvider ?? (config.NODE_ENV !== "production" ? new MockVideoProvider() : null);
}

export function registerLlmProviders(config: AppConfig, registry: ModelRegistry, logger: Logger): void {
  // 1. Self-hosted runtime — Ollama, vLLM, llama.cpp's server, LM Studio, or any
  //    OpenAI-compatible gateway. No third-party account involved.
  if (config.LLM_BASE_URL && config.LLM_MODEL) {
    registry.register(
      new LocalOpenAICompatibleProvider({
        baseUrl: config.LLM_BASE_URL,
        model: config.LLM_MODEL,
        apiKey: config.LLM_API_KEY,
        contextWindow: config.LLM_CONTEXT_WINDOW,
        supportsTools: config.LLM_SUPPORTS_TOOLS,
      }),
      { asDefault: true }
    );
  }

  // 2-4. Hosted adapters, each registering only when its key is present (ADR-010). Each has
  // been fixture-tested and confirmed to reach its live endpoint correctly, not
  // full-success-tested (ADR-023/024).
  if (config.ANTHROPIC_API_KEY) {
    registry.register(new AnthropicProvider({ apiKey: config.ANTHROPIC_API_KEY }));
  }
  if (config.OPENAI_API_KEY) {
    registry.register(
      new OpenAIProvider({
        apiKey: config.OPENAI_API_KEY,
        organizationId: config.OPENAI_ORG_ID,
        projectId: config.OPENAI_PROJECT_ID,
      })
    );
  }
  // `||`, not `??` — docs/26_DECISIONS.md ADR-045. The schema already maps an empty value to
  // undefined, but this is the line where a blank `GOOGLE_API_KEY=` silently shadowed a real
  // key set under the documented alias, so it states the intent locally too.
  const googleApiKey = config.GOOGLE_API_KEY || config.GEMINI_API_KEY;
  if (googleApiKey) {
    registry.register(new GoogleProvider({ apiKey: googleApiKey }));
  }

  // 5. The mock. ADR-013 says it must never serve production traffic; ADR-045 turned that
  // from a constructor throw (which killed every production boot, even with a valid key) into
  // "never constructed in production". Outside production it stays the zero-configuration
  // default so the platform runs with no credentials at all — but only as the default when
  // nothing real is registered, so a configured runtime is never shadowed by it.
  if (config.NODE_ENV !== "production") {
    registry.register(new MockLLMProvider(), { asDefault: registry.list().length === 0 });
  } else {
    logger.info("mock LLM provider NOT registered — NODE_ENV=production (ADR-013)");
  }
}
