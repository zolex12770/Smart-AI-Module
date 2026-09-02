import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzleNodePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

/**
 * Every repository is typed against this general dialect-agnostic base (docs/26_DECISIONS.md
 * ADR-037) rather than a driver-specific type — `PgliteDatabase` (local dev/tests) and
 * `NodePgDatabase` (a real standalone Postgres, e.g. Cloud SQL) are both `PgDatabase<...>`
 * subtypes with an identical query-builder surface; no repository ever touches a
 * driver-specific method, so none needed to change to support a second backend.
 */
export type DrizzleDb = PgDatabase<PgQueryResultHKT, typeof schema>;

// The two driver-specific return types below preserve `$client` (the raw underlying
// connection) via intersection — packages/jobs needs the PGlite one to hand pg-boss's
// `fromPglite` adapter the same connection apps/api already has (ADR-027), and the
// composition root needs either one to shut the connection down gracefully on exit.
export type PgliteDb = PgliteDatabase<typeof schema> & { $client: PGlite };
export type PostgresDb = NodePgDatabase<typeof schema> & { $client: Pool };

/**
 * Real PostgreSQL via PGlite (docs/26_DECISIONS.md ADR-025) — an actual WASM-compiled
 * Postgres engine, not SQLite and not a mock. `dataDir` persists to a local directory the
 * same way the Phase 1-5 SQLite file did; `:memory:` (used by tests) keeps it in-memory.
 */
export async function createDb(dataDir = process.env.DATABASE_DIR ?? "./data/pgdata"): Promise<PgliteDb> {
  const pglite = await PGlite.create({
    dataDir: dataDir === ":memory:" ? undefined : dataDir,
    extensions: { vector },
  });
  await pglite.exec("CREATE EXTENSION IF NOT EXISTS vector;");
  return drizzle(pglite, { schema });
}

/**
 * Real standalone Postgres (docs/26_DECISIONS.md ADR-037) — e.g. Cloud SQL once Phase 14's
 * infrastructure is actually provisioned and deployed to. `pg` (node-postgres) was already
 * present transitively (via `drizzle-orm` and `pg-boss`) before this — the de facto standard
 * Postgres driver for Node, not a new supply-chain surface. `pgvector` must already be an
 * allow-listed extension on the target instance (true for Cloud SQL); `CREATE EXTENSION IF
 * NOT EXISTS` is idempotent the same way createDb's PGlite path is.
 */
export async function createPostgresDb(connectionString: string): Promise<PostgresDb> {
  const pool = new Pool({ connectionString });
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector;");
  return drizzleNodePg(pool, { schema });
}
