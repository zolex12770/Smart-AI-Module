import { createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema/index.js";

export type DrizzleDb = LibSQLDatabase<typeof schema>;

/**
 * SQLite via libSQL (docs/26_DECISIONS.md ADR-006) — chosen over better-sqlite3 because
 * it ships prebuilt native bindings for Windows/Node 24 with no local C++ toolchain
 * required, which better-sqlite3 currently lacks on this platform (see PROJECT_STATUS.md).
 */
export function createDb(fileOrUrl = process.env.DATABASE_FILE ?? "./data/dev.sqlite"): DrizzleDb {
  const url = fileOrUrl === ":memory:" ? ":memory:" : toFileUrl(fileOrUrl);
  if (fileOrUrl !== ":memory:") {
    mkdirSync(dirname(fileOrUrl), { recursive: true });
  }
  const client = createClient({ url });
  return drizzle(client, { schema });
}

function toFileUrl(path: string): string {
  return path.startsWith("file:") ? path : `file:${resolve(path)}`;
}
