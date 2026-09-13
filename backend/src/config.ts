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
 * Single point of env loading — see docs/17_BACKEND_ARCHITECTURE.md. Fails fast on boot
 * with a clear error rather than letting a missing/malformed variable surface later as a
 * confusing runtime failure.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
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
  LLM_API_KEY: optionalString,
  LLM_CONTEXT_WINDOW: z.coerce.number().int().positive().optional(),

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

  // --- Narration for long-form video (ADR-079) -------------------------------------------
  // `openai` speaks `/v1/audio/speech` — OpenAI itself, or a self-hosted server that copies the
  // shape (Kokoro-FastAPI, openedai-speech, LocalAI). `sapi` is the operating system's own
  // offline synthesiser and needs no server at all, but exists only on Windows. Unset means the
  // pipeline renders WITHOUT narration and says so (`audioStatus: skipped_no_narration`) rather
  // than muxing silence and calling it a voice-over.
  SPEECH_PROVIDER: z.enum(["openai", "sapi", "none"]).default("none"),
  SPEECH_BASE_URL: optionalString,
  SPEECH_MODEL: optionalString,
  SPEECH_API_KEY: optionalString,
  SPEECH_VOICE: optionalString,
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
  // Bootstrap the first administrator on an empty database. Ignored once any user exists.
  BOOTSTRAP_ADMIN_EMAIL: optionalString,
  BOOTSTRAP_ADMIN_PASSWORD: optionalString,

  // --- Agent limits (ADR-057) -----------------------------------------------------------
  AGENT_MAX_ITERATIONS: z.coerce.number().int().positive().max(50).default(12),
  AGENT_MAX_TOKENS_PER_RUN: z.coerce.number().int().positive().default(200_000),
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
  DAILY_TOKEN_LIMIT: z.coerce.number().int().positive().optional(),
  MONTHLY_TOKEN_LIMIT: z.coerce.number().int().positive().optional(),
  DAILY_IMAGE_LIMIT: z.coerce.number().int().positive().optional(),
  MONTHLY_VIDEO_SECONDS_LIMIT: z.coerce.number().int().positive().optional(),
})
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
