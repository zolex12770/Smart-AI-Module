import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * The files the loader will consider, in order, as absolute paths.
 *
 * Exported so the path ARITHMETIC is testable. It was not before, and config.test.ts said so
 * outright ("exercised by the live boot check ... since it depends on this module's real
 * on-disk location") -- so when the restructure moved this module up one directory, the
 * literal `../../../.env` silently began resolving to the PARENT of the repository and no test
 * noticed. The arithmetic now has a test that fails if a candidate ever leaves the repo.
 *
 * `../../.env` is the repo root; `../.env` is `backend/.env`. Both resolve identically from
 * `src/` and from `dist/`, which sit at the same depth.
 */
export function dotEnvCandidatePaths(): string[] {
  return [new URL("../.env", import.meta.url), new URL("../../.env", import.meta.url)].map((url) =>
    fileURLToPath(url)
  );
}

/**
 * Loads `.env` files into process.env using Node's own loader (`process.loadEnvFile`, no
 * dependency) — docs/26_DECISIONS.md ADR-043. Two locations, resolved relative to THIS
 * module rather than the working directory (which differs between `tsx watch` under
 * `npm run dev -w`, `node backend/dist/index.js` in the container, and the test runner):
 *
 *   backend/.env   — app-specific
 *   <repo root>/.env — the location `.env.example` documents
 *
 * Both paths resolve identically from `src/` and from `dist/`. Real environment variables
 * always win over file values (Node's loader never overwrites an existing key — verified in
 * config.test.ts, not assumed), so a container's injected secrets can't be shadowed by a
 * stray file. Never runs under NODE_ENV=test: a developer's `.env` with DATABASE_URL set
 * must not be able to point the test suite at a real database.
 */
export function loadDotEnvFiles(nodeEnv = process.env.NODE_ENV): string[] {
  if (nodeEnv === "test") return [];
  const loaded: string[] = [];
  for (const path of dotEnvCandidatePaths()) {
    if (!existsSync(path)) continue;
    process.loadEnvFile(path);
    loaded.push(path);
  }
  return loaded;
}

/**
 * An optional variable where the EMPTY STRING means "not set" — docs/26_DECISIONS.md ADR-045.
 *
 * This matters because of how `.env` files are actually used: `.env.example` ships a key's
 * name with no value (`GOOGLE_API_KEY=`), the reader copies the file, fills in the one line
 * they care about, and leaves the rest. Those untouched lines arrive as empty strings, not
 * as absent variables — and an empty string is a *present* value to `??`, to
 * `z.string().optional()`, and to anything else that only checks for null/undefined. A real
 * key set under an alias name was therefore silently shadowed by the blank line above it.
 * Trimming is part of the same fix: a key pasted with a trailing space is a real, common
 * mistake that would otherwise reach the provider verbatim and fail authentication.
 */
const optionalString = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : typeof v === "string" ? v.trim() : v),
  z.string().optional()
);

/**
 * An optional positive integer where an EMPTY value means unset, as it does for `optionalString`.
 * A compose file or manifest that passes `LIMIT: ${LIMIT:-}` hands the process an empty string,
 * which `z.coerce.number()` reads as 0 and `.positive()` then rejects — so a deployment that
 * merely declared a limit it did not set refused to boot.
 */
const optionalPositiveInt = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.coerce.number().int().positive().optional()
);

/**
 * Single point of env loading — see docs/17_BACKEND_ARCHITECTURE.md. Fails fast on boot
 * with a clear error rather than letting a missing/malformed variable surface later as a
 * confusing runtime failure.
 */
/**
 * The field map, kept separate from the refinement wrapped around it — ADR-155.
 *
 * `envSchema` is a `ZodEffects` because of the `superRefine` below, and a `ZodEffects` has no
 * `.shape`. `SECRET_CONFIG_KEYS` is derived from the keys, so the keys need a name.
 */
const envFields = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * The interface to listen on — docs/26_DECISIONS.md ADR-113. Unset: 127.0.0.1 outside production
   * and 0.0.0.0 in production. It used to be 0.0.0.0 always, so a developer's `npm run dev` served
   * the whole LAN: anyone on the network could sign up, own a project, approve their own tool calls
   * and run model-authored commands under development's default process-level isolation. A
   * container still needs 0.0.0.0 to receive its platform's traffic, and production gets exactly that.
   */
  HOST: optionalString,
  PORT: z.coerce.number().int().positive().default(8787),
  /**
   * A metrics-only listener (`GET /metrics`, Prometheus text) on this port, for any role — see
   * metrics-server.ts. Needed wherever the worker runs as its own process: its counters are in its
   * own memory and it has no other listener. METRICS_TOKEN, when set, requires a bearer token.
   */
  METRICS_PORT: optionalPositiveInt,
  METRICS_TOKEN: optionalString,
  // docs/26_DECISIONS.md ADR-039 — which responsibilities this process takes on (see role.ts).
  // Defaults to "all" so local dev (where PGlite permits only one process per data dir,
  // ADR-025) keeps working unchanged; Cloud Run sets "api" on the service and "worker" on
  // the worker pool (infrastructure/terraform/main.tf).
  ROLE: z.enum(["all", "api", "worker"]).default("all"),
  // Real PostgreSQL via PGlite (docs/26_DECISIONS.md ADR-025) — a directory, not a
  // single file, since Postgres persists multiple files there.
  DATABASE_DIR: z.string().default("./data/pgdata"),
  // When set, connects to a real standalone Postgres (e.g. Cloud SQL) instead of the local
  // embedded PGlite default — docs/26_DECISIONS.md ADR-037. Optional: local dev and every
  // existing deployment keep working identically with this unset.
  DATABASE_URL: optionalString,
  SANDBOX_ROOT: z.string().default("./data/sandbox"),
  ASSETS_ROOT: z.string().default("./data/assets"),
  // docs/26_DECISIONS.md ADR-040 — when set, generated assets go to this Google Cloud
  // Storage bucket (authenticated via Application Default Credentials) instead of
  // ASSETS_ROOT on local disk. Optional: unset keeps the local-disk default for dev.
  ASSETS_BUCKET: optionalString,
  // Only for pointing the real GCS client at a local emulator (fake-gcs-server) during
  // development/verification — never set in production (see CloudStorageAssetStore for why
  // this is an explicit option rather than the library's STORAGE_EMULATOR_HOST env var).
  GCS_API_ENDPOINT: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : typeof v === "string" ? v.trim() : v),
    z.string().url().optional()
  ),
  // docs/13 §12 / docs/26_DECISIONS.md ADR-042 — malware scanning of uploads via clamd's TCP
  // protocol. CLAMD_HOST set ⇒ scanning is ENABLED: uploads are held in `scanning` and only
  // ingested after a clean verdict from the worker-role process (which is what actually
  // connects to clamd — on Cloud Run, a sidecar on the worker pool at 127.0.0.1). Unset ⇒
  // uploads are accepted unscanned with a durable `skipped_no_scanner` mark and a loud boot
  // warning (fail-OPEN, the right default for the single-operator dev loop) unless
  // UPLOAD_SCAN_REQUIRED=true, which makes the upload route refuse with a 503 instead
  // (fail-CLOSED, what a real deployment should set).
  CLAMD_HOST: optionalString,
  CLAMD_PORT: z.coerce.number().int().positive().default(3310),
  // Not z.coerce.boolean(): that treats the string "false" as true.
  UPLOAD_SCAN_REQUIRED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // docs/26_DECISIONS.md ADR-030: the long-form video render stage shells out to a system
  // ffmpeg binary rather than bundling one via npm. Defaults to resolving "ffmpeg" on PATH;
  // override for an environment where it's installed somewhere non-standard.
  FFMPEG_PATH: z.string().default("ffmpeg"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // --- Self-hosted / provider-neutral model runtime (ADR-056) --------------------------
  // Any OpenAI-compatible `/v1` endpoint: Ollama, vLLM, llama.cpp, LM Studio, or a gateway.
  // This is what lets the platform run with no third-party AI provider at all.
  LLM_BASE_URL: optionalString,
  LLM_MODEL: optionalString,
  /**
   * Load the self-hosted chat model in the background at boot (default on). Without it the first
   * user after a restart waits for a multi-gigabyte load — measured at over five minutes from a
   * cold disk, long enough for Ollama's own load deadline to fail the request.
   */
  LLM_WARMUP: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  /**
   * How long the boot warm-up waits for the local model to load (DL-22). Only the warm-up uses
   * it; ordinary calls keep the adapter's 300-second silence deadline. A cold load of a 7B model
   * took over five minutes here, and Ollama cancels a load whose request gives up.
   */
  LLM_LOAD_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).default(1_200_000),
  /**
   * The most output tokens one chat turn may ask for, and the cap applied when it asks for none.
   *
   * A caller's `maxOutputTokens` is spent on the operator's key, and the pre-flight quota check
   * has to count output, not just the prompt — without a ceiling one request could reserve
   * 200,000 tokens of the most expensive model (audit finding, docs/DECISION_LOG.md). A request
   * above it is refused with 400, not silently clamped.
   */
  CHAT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(200_000).default(4096),
  LLM_API_KEY: optionalString,
  LLM_CONTEXT_WINDOW: optionalPositiveInt,

  /**
   * Rolling conversation summarization — FR-030, ADR-103.
   *
   * Tunable because the right threshold depends on the deployed model's context window, which
   * this platform does not choose: a 128k model can afford a far larger live history than an 8k
   * one, and hardcoding either would be wrong for the other. The default is deliberately well
   * under the smallest window targeted here — the summary, the live turns, the answer and any
   * tool schemas all have to fit alongside it.
   */
  CHAT_SUMMARY_MAX_PROMPT_TOKENS: z.coerce.number().int().min(200).max(500_000).default(6_000),
  /** Most recent messages always kept verbatim, whatever the summary says. */
  CHAT_LIVE_WINDOW_MESSAGES: z.coerce.number().int().min(2).max(200).default(10),

  /**
   * Hosts `web.fetch` may reach — FR-011, ADR-104. Comma-separated; empty means any PUBLIC
   * address (private, loopback, link-local and cloud-metadata ranges are refused either way,
   * and that refusal is not configurable).
   *
   * A deployment that wants the capability only for its own documentation sites sets this; one
   * that wants general web reading leaves it unset. It is an allowlist rather than a blocklist
   * because the useful direction of a network restriction is naming what IS permitted.
   */
  WEB_FETCH_ALLOWLIST: optionalString,
  LLM_SUPPORTS_TOOLS: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  /**
   * Whether the deterministic MOCK providers — a canned chat model, a labelled placeholder
   * image, an animated GIF standing in for video — may be registered at all.
   *
   * Off by default, in every environment. It used to be implied by "not production": a
   * development server with nothing configured answered chat from a stub and "generated"
   * placeholder images, so a first run looked like a working product and was not one. With
   * this off, an unconfigured capability reports itself unavailable instead. Test harnesses
   * and the E2E server, which need deterministic providers to exercise the UI, set it
   * explicitly. Refused in production below.
   */
  ALLOW_MOCK_PROVIDERS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // Embeddings from the same runtime — real semantic retrieval with no hosted provider.
  EMBEDDING_BASE_URL: optionalString,
  EMBEDDING_MODEL: optionalString,
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().max(1536).optional(),
  EMBEDDING_API_KEY: optionalString,

  // --- Real image generation (ADR-065) --------------------------------------------------
  // Any server speaking OpenAI-compatible `/v1/images/generations`: LocalAI over Stable
  // Diffusion, a ComfyUI/Automatic1111 bridge, or a hosted account. Unset means the platform
  // has no image capability and says so with a real error rather than inventing a picture.
  IMAGE_BASE_URL: optionalString,
  IMAGE_MODEL: optionalString,
  IMAGE_API_KEY: optionalString,
  IMAGE_SUPPORTS_NEGATIVE_PROMPT: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  IMAGE_SUPPORTS_SEED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  /**
   * Longest edge for the OpenAI-compatible image adapter, in pixels — ADR-129.
   *
   * The adapter's size table is written for hosted models (1024 and up) and was a constant, so a
   * deployment pointing IMAGE_BASE_URL at a LOCAL server — which its own documentation suggests —
   * asked a CPU for a 1024-square image and could only wait. Unset keeps the hosted defaults.
   */
  IMAGE_BASE_SIZE: z.coerce.number().int().min(64).max(4096).optional(),
  // stable-diffusion.cpp: one binary plus one weights file, on the CPU, with no server (ADR-120).
  // This is what makes image generation REAL on a machine with no image credentials.
  IMAGE_SD_CLI_PATH: optionalString,
  IMAGE_SD_MODEL_PATH: optionalString,
  // SD-Turbo is distilled to one step at guidance 1.0; a standard model wants ~20 and 7.0.
  IMAGE_SD_STEPS: z.coerce.number().int().min(1).max(150).default(1),
  IMAGE_SD_CFG_SCALE: z.coerce.number().min(0).max(30).default(1),
  IMAGE_SD_SIZE: z.coerce.number().int().min(64).max(2048).default(512),
  IMAGE_SD_THREADS: z.coerce.number().int().min(1).max(64).optional(),
  IMAGE_SD_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(600_000),

  // --- Narration for long-form video (ADR-079) -------------------------------------------
  // `openai` speaks `/v1/audio/speech` — OpenAI itself, or a self-hosted server that copies the
  // shape (Kokoro-FastAPI, openedai-speech, LocalAI). `sapi` is the operating system's own
  // offline synthesiser and needs no server at all, but exists only on Windows. Unset means the
  // pipeline renders WITHOUT narration and says so (`audioStatus: skipped_no_narration`) rather
  // than muxing silence and calling it a voice-over.
  SPEECH_PROVIDER: z.enum(["openai", "sapi", "piper", "none"]).default("none"),
  SPEECH_BASE_URL: optionalString,
  SPEECH_MODEL: optionalString,
  SPEECH_API_KEY: optionalString,
  SPEECH_VOICE: optionalString,
  // `piper` is an offline neural synthesiser: one static binary plus an ONNX voice, published for
  // Linux, macOS and Windows (ADR-114). It is the only offline path that exists on a server —
  // `sapi` is Windows-only — so it is what makes narration and the audio feature deployable.
  PIPER_PATH: optionalString,
  PIPER_VOICE: optionalString,
  // --- Real video generation (ADR-085) --------------------------------------------------
  // Video is named, not URL-shaped like the two above, because there is no cross-vendor wire
  // format for it (ADR-065): an adapter is written against one vendor's asynchronous contract,
  // so the deployment has to say WHICH one. `replicate` is the only implementation today;
  // an unrecognised name fails the boot rather than being ignored into a silent no-capability
  // state, which is the whole point of parsing configuration here.
  VIDEO_PROVIDER: z.enum(["replicate"]).optional(),
  VIDEO_API_TOKEN: optionalString,
  // Replicate pins a model VERSION hash, not a model name — the same name republished is a
  // different model with different inputs, so reproducibility depends on the exact version.
  VIDEO_MODEL_VERSION: optionalString,

  // --- MCP (ADR-067) ---------------------------------------------------------------------
  // A JSON array of server configs. Each entry is EITHER a local stdio server or a remote
  // http one, told apart by which endpoint it names — an entry with both is rejected:
  //   [{"id":"fs","command":"node","args":["/path/to/server.js","/workspace"]},
  //    {"id":"docs","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer …"}}]
  // Unset falls back to the bundled reference filesystem server, so local development needs
  // no configuration. A malformed entry is skipped with a warning, never fatal.
  //
  // `headers` is where a remote's credential goes, so it is never logged and never returned by
  // `/api/v1/mcp`; an entry that would send headers over plaintext http to a non-loopback host
  // is skipped rather than put on the wire in clear.
  //
  // Whatever a remote advertises, its tools are registered DISABLED and an operator must
  // enable each one explicitly — a remote MCP server supplies tool definitions, which is
  // untrusted third-party input, and auto-enabling would let it grant itself a callable tool
  // inside this platform by editing its own manifest.
  MCP_SERVERS: optionalString,

  // --- Security (ADR-049 / ADR-055) -----------------------------------------------------
  // Session cookies are Secure in production; this allows plain HTTP for local development.
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  /**
   * How the session cookie is scoped across sites — docs/26_DECISIONS.md ADR-070.
   *
   * This platform deploys the web app and the API as SEPARATE services on different
   * hostnames, which makes every browser call to the API a cross-SITE request. `Lax` cookies
   * are not sent on those, so a `Lax` session cookie means the deployed app can never
   * authenticate at all. `None` is required there, and `None` requires `Secure`.
   *
   * Left unset, it is derived: `none` when cookies are Secure (production over HTTPS), `lax`
   * otherwise (local development over plain HTTP, where the two run on the same host and
   * `None` would be rejected for not being Secure).
   */
  COOKIE_SAMESITE: z.enum(["lax", "none", "strict"]).optional(),
  /**
   * Attempts per 10 minutes, per IP, for signup and login — docs/26_DECISIONS.md ADR-070.
   *
   * Configurable rather than hard-coded because the right value is deployment-specific: 5 is
   * a sensible default for a public instance, and is far too low for an end-to-end suite that
   * legitimately creates several accounts from one address in one run. Tuning it is an
   * operator decision; removing the limit is not, so there is no "off".
   */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000).default(5),
  /**
   * How many reverse proxies in front of this process may be trusted to have appended to
   * X-Forwarded-For — docs/26_DECISIONS.md ADR-112. 0, the default, uses the connection's own
   * address, which is right when nothing sits in front; Cloud Run's front end is 1. A number
   * higher than the real hop count lets a caller choose its own address again.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().max(365).default(30),
  // `docker` gives real container isolation for agent-run commands; `process` is the
  // development fallback and is refused in production unless explicitly acknowledged.
  SANDBOX_RUNTIME: z.enum(["docker", "process"]).default("process"),
  SANDBOX_IMAGE: z.string().default("node:22-alpine"),
  SANDBOX_ALLOW_PROCESS_IN_PRODUCTION: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  SANDBOX_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SANDBOX_MEMORY_MB: z.coerce.number().int().positive().default(512),
  /**
   * Whether a finished chat turn is mined for durable facts — docs/26_DECISIONS.md ADR-141.
   *
   * On by default, because "the platform remembers what you tell it across conversations" is a
   * documented capability and the extraction machinery shipped unreachable, which made that claim
   * false. It is a switch because it is a SECOND model call per turn: an operator paying per
   * token may reasonably decide the recall is not worth doubling the calls, and that decision
   * should not require a code change.
   */
  MEMORY_EXTRACTION_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  // Bootstrap the first administrator on an empty database. Ignored once any user exists.
  BOOTSTRAP_ADMIN_EMAIL: optionalString,
  BOOTSTRAP_ADMIN_PASSWORD: optionalString,

  // --- Agent limits (ADR-057) -----------------------------------------------------------
  AGENT_MAX_ITERATIONS: z.coerce.number().int().positive().max(50).default(12),
  AGENT_MAX_TOKENS_PER_RUN: z.coerce.number().int().positive().default(200_000),
  /**
   * The per-node wall-clock ceiling for an agent run, overriding the planner constant — ADR-162.
   *
   * A reasoning node is planned with 10 minutes, and the `fix_failing_test` acceptance run has
   * now died at that ceiling twice on a 7B model running on four CPU cores. The limit is right
   * for a hosted model and wrong for that one, and until now there was no way to say so. Unset
   * keeps whatever the planner wrote for each node type.
   */
  AGENT_NODE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).optional(),
  ANTHROPIC_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
  OPENAI_ORG_ID: optionalString,
  OPENAI_PROJECT_ID: optionalString,
  // docs/28_API_PROVIDER_MATRIX.md: the SDK convention accepts GEMINI_API_KEY as an
  // alias for GOOGLE_API_KEY — support either name so either doc's instructions work.
  GOOGLE_API_KEY: optionalString,
  GEMINI_API_KEY: optionalString,
  // FR-063 (docs/22_COST_AND_QUOTA_STRATEGY.md) — single-operator scope (ADR-008), so these
  // are global, not per-user, limits. All optional: unset means "no limit configured," the
  // same opt-in default docs/22's own design calls for.
  DAILY_TOKEN_LIMIT: optionalPositiveInt,
  MONTHLY_TOKEN_LIMIT: optionalPositiveInt,
  DAILY_IMAGE_LIMIT: optionalPositiveInt,
  DAILY_SPEECH_CHARACTER_LIMIT: optionalPositiveInt,
  MONTHLY_SPEECH_CHARACTER_LIMIT: optionalPositiveInt,
  MONTHLY_VIDEO_SECONDS_LIMIT: optionalPositiveInt,
  /**
   * Embedding spend, budgeted apart from chat — docs/26_DECISIONS.md ADR-131, wired by ADR-150.
   *
   * `QuotaLimits` has carried these two fields since ADR-131 and no environment variable could
   * supply them, so the composition root constructed the manager without them and
   * `checkEmbeddingTokens` returned `allowed: true` in every real deployment. The meter was
   * built, called from all four embedding paths, tested — and could not refuse anything.
   */
  /**
   * The retrieval relevance threshold — docs/26_DECISIONS.md ADR-158.
   *
   * `retrieve.ts` justifies making it a knob rather than a constant: "the right value is a
   * property of the embedding model, so it is a knob, not a constant: a learned model needs its
   * own calibration". `RetrieveDeps.maxDistance` existed, and `grep` for it across `backend/src`,
   * `shared/src` and `.env.example` returned nothing — no environment variable, no composition
   * root wiring, no caller. So an operator who swapped the embedding model could not calibrate
   * anything, and the documented knob was a parameter only tests passed.
   *
   * Cosine distance, so 0 is identical and 2 is opposite; the default is 0.6.
   */
  RAG_MAX_COSINE_DISTANCE: z.coerce.number().min(0).max(2).optional(),
  DAILY_EMBEDDING_TOKEN_LIMIT: optionalPositiveInt,
  MONTHLY_EMBEDDING_TOKEN_LIMIT: optionalPositiveInt,
  /**
   * How long the storyboard stage may spend in the model — ADR-161.
   *
   * It was a hard-coded 25 seconds, chosen so `POST /api/v1/videos` (which runs this stage
   * inline, before its 202) stays responsive. The fifth audit measured the reference local
   * runtime — qwen2.5:7b on this machine — at 21.2 seconds for a two-scene brief. That is
   * inside the ceiling by under four seconds, and when it is not, the whole authored half of
   * the feature turns off: no model-written shots, no narration, therefore no audio track and
   * no subtitles, while the render still succeeds and the project still reports `succeeded`.
   * Two consecutive real runs fell back that way.
   *
   * The stage has since moved off the request into the `video.plan` job (the autonomous-
   * completion pass measured the 25 s ceiling failing on every request with a local model), so
   * the responsiveness argument is gone: the default is DEFAULT_VIDEO_SCRIPT_TIMEOUT_MS (180 s),
   * and this remains the operator's knob for a runtime slower or faster than that.
   */
  VIDEO_SCRIPT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).optional(),
});

export const envSchema = envFields
  /**
   * A half-configured video provider is refused on boot — ADR-085.
   *
   * The image variables can afford to fall back quietly (an incomplete IMAGE_* set simply
   * leaves the mock in place, and development is the case that produces one). VIDEO_PROVIDER
   * cannot: naming a provider is an explicit statement that this deployment generates real
   * video, and the credentials are what make that true. Falling back from it would leave an
   * operator who typed the variable looking at a 501 with nothing anywhere saying why, and in
   * production — where the mock is forbidden (ADR-013) — the capability would simply vanish.
   */
  .superRefine((config, ctx) => {
    // ADR-013: a mock never serves production traffic, whatever else is configured.
    if (config.NODE_ENV === "production" && config.ALLOW_MOCK_PROVIDERS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ALLOW_MOCK_PROVIDERS"],
        message: "ALLOW_MOCK_PROVIDERS=true is refused under NODE_ENV=production: mock providers never serve real users (ADR-013).",
      });
    }
    if (!config.VIDEO_PROVIDER) return;
    for (const key of ["VIDEO_API_TOKEN", "VIDEO_MODEL_VERSION"] as const) {
      if (!config[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `VIDEO_PROVIDER=${config.VIDEO_PROVIDER} requires ${key}. Unset VIDEO_PROVIDER to leave video generation unavailable instead.`,
        });
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Every configuration key whose VALUE is a credential — docs/26_DECISIONS.md ADR-155.
 *
 * Derived from the schema rather than listed, because the hand-maintained redaction list in the
 * observability package had already drifted seven fields behind this file: `LLM_API_KEY`,
 * `VIDEO_API_TOKEN`, `IMAGE_API_KEY`, `SPEECH_API_KEY`, `EMBEDDING_API_KEY`,
 * `BOOTSTRAP_ADMIN_PASSWORD` and `DATABASE_URL` were all live and none of them was redacted.
 * A key added to the schema later is covered by construction.
 *
 * `DATABASE_URL` is included by name: it is not shaped like the others and it carries the
 * database password.
 */
export const SECRET_CONFIG_KEYS: string[] = Object.keys(envFields.shape).filter(
  (key) => /_(API_KEY|TOKEN|PASSWORD|SECRET)$/.test(key) || key === "DATABASE_URL"
);

/** The interface to listen on (ADR-113): an explicit HOST, otherwise loopback outside production. */
export function resolveListenHost(config: Pick<AppConfig, "HOST" | "NODE_ENV">): string {
  return config.HOST ?? (config.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
}

export function loadConfig(): AppConfig {
  const envFiles = loadDotEnvFiles();
  if (envFiles.length > 0) {
    // Plain console: the structured logger is constructed AFTER config (it needs LOG_LEVEL).
    // Paths only — never the values, some of which are secrets.
    console.log(`Loaded environment from: ${envFiles.join(", ")}`);
  }
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
