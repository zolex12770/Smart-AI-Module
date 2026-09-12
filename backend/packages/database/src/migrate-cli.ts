import { createDb, createPostgresDb } from "./client.js";
import { runMigrations, runPostgresMigrations } from "./migrate.js";

// Same DATABASE_URL-presence branch as apps/api/src/index.ts's composition root (docs/26_DECISIONS.md
// ADR-037) — set it to run this against a real standalone Postgres (e.g. the deployment
// runbook's post-provisioning migration step); leave it unset for the local PGlite default.
if (process.env.DATABASE_URL) {
  await runPostgresMigrations(await createPostgresDb(process.env.DATABASE_URL));
} else {
  await runMigrations(await createDb());
}
console.log("Migrations applied.");
