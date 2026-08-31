import { defineConfig } from "drizzle-kit";

/**
 * Real PostgreSQL via PGlite (docs/26_DECISIONS.md ADR-025) — dialect is genuinely
 * "postgresql", not a SQLite compatibility mode. `url` here only matters for drizzle-kit
 * commands that need a live connection (e.g. `push`); `generate` (what we use) only
 * needs the schema file.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres",
  },
});
