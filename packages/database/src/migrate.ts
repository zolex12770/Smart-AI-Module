import { migrate } from "drizzle-orm/pglite/migrator";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import type { PgliteDb, PostgresDb } from "./client.js";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** Applies pending migrations against the local embedded PGlite database. Safe to call on
 * every boot — a no-op if already current. */
export async function runMigrations(db: PgliteDb): Promise<void> {
  await migrate(db, { migrationsFolder });
}

/** Applies the same migrations against a real standalone Postgres (docs/26_DECISIONS.md
 * ADR-037) — e.g. Cloud SQL, as a deployment runbook step. drizzle-orm's migrator is
 * driver-specific (unlike the query builder), so this needs its own entry point rather than
 * reusing runMigrations, even though both read the same migrations folder. */
export async function runPostgresMigrations(db: PostgresDb): Promise<void> {
  await migrateNodePg(db, { migrationsFolder });
}
