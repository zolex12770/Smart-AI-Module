import { z } from "zod";

/**
 * Single point of env loading — see docs/17_BACKEND_ARCHITECTURE.md. Fails fast on boot
 * with a clear error rather than letting a missing/malformed variable surface later as a
 * confusing runtime failure.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  // Real PostgreSQL via PGlite (docs/26_DECISIONS.md ADR-025) — a directory, not a
  // single file, since Postgres persists multiple files there.
  DATABASE_DIR: z.string().default("./data/pgdata"),
  // When set, connects to a real standalone Postgres (e.g. Cloud SQL) instead of the local
  // embedded PGlite default — docs/26_DECISIONS.md ADR-037. Optional: local dev and every
  // existing deployment keep working identically with this unset.
  DATABASE_URL: z.string().optional(),
  SANDBOX_ROOT: z.string().default("./data/sandbox"),
  ASSETS_ROOT: z.string().default("./data/assets"),
  // docs/26_DECISIONS.md ADR-030: the long-form video render stage shells out to a system
  // ffmpeg binary rather than bundling one via npm. Defaults to resolving "ffmpeg" on PATH;
  // override for an environment where it's installed somewhere non-standard.
  FFMPEG_PATH: z.string().default("ffmpeg"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_ORG_ID: z.string().optional(),
  OPENAI_PROJECT_ID: z.string().optional(),
  // docs/28_API_PROVIDER_MATRIX.md: the SDK convention accepts GEMINI_API_KEY as an
  // alias for GOOGLE_API_KEY — support either name so either doc's instructions work.
  GOOGLE_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
