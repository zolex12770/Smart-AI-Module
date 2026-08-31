import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import type { DrizzleDb } from "./client.js";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** Applies pending migrations. Safe to call on every boot — a no-op if already current. */
export async function runMigrations(db: DrizzleDb): Promise<void> {
  await migrate(db, { migrationsFolder });
}
