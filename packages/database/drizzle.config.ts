import { defineConfig } from "drizzle-kit";

/**
 * SQLite for the Phase 1 milestone only — docs/26_DECISIONS.md ADR-006.
 * Swaps to a Postgres config (separate dialect, separate migrations dir) in Phase 6
 * per docs/14_DATABASE_ARCHITECTURE.md, without changing the repository interfaces
 * application code depends on.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_FILE ?? "./data/dev.sqlite",
  },
});
