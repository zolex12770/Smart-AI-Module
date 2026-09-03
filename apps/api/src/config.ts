import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Loads `.env` files into process.env using Node's own loader (`process.loadEnvFile`, no
 * dependency) — docs/26_DECISIONS.md ADR-043. Two locations, resolved relative to THIS
 * module rather than the working directory (which differs between `tsx watch` under
 * `npm run dev -w`, `node apps/api/dist/index.js` in the container, and the test runner):
 *
 *   apps/api/.env   — app-specific
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
  const candidates = [new URL("../.env", import.meta.url), new URL("../../../.env", import.meta.url)];
  const loaded: string[] = [];
  for (const url of candidates) {
    const path = fileURLToPath(url);
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
