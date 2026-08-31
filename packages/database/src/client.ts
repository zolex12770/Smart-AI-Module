import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema/index.js";

export type DrizzleDb = PgliteDatabase<typeof schema>;

/**
 * Real PostgreSQL via PGlite (docs/26_DECISIONS.md ADR-025) — an actual WASM-compiled
 * Postgres engine, not SQLite and not a mock. `dataDir` persists to a local directory the
 * same way the Phase 1-5 SQLite file did; `:memory:` (used by tests) keeps it in-memory.
 */
export async function createDb(dataDir = process.env.DATABASE_DIR ?? "./data/pgdata"): Promise<DrizzleDb> {
  const pglite = await PGlite.create({
    dataDir: dataDir === ":memory:" ? undefined : dataDir,
    extensions: { vector },
  });
  await pglite.exec("CREATE EXTENSION IF NOT EXISTS vector;");
  return drizzle(pglite, { schema });
}
