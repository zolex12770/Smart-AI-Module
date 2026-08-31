import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";

await runMigrations(createDb());
console.log("Migrations applied.");
