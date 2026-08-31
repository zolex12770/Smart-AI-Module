import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";

await runMigrations(await createDb());
console.log("Migrations applied.");
