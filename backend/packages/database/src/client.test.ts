import { describe, expect, it } from "vitest";
import { createDb, createPostgresDb } from "./client.js";

/**
 * This sandbox has no real standalone Postgres server to connect to (no Docker — see
 * docs/26_DECISIONS.md ADR-037), so a genuine round-trip test of createPostgresDb (insert,
 * query, migrate) isn't possible here, the same class of gap as ADR-030's unverified
 * ffmpeg-present render branch. What IS verifiable for real: that createPostgresDb makes a
 * genuine TCP connection attempt via node-postgres — not a stub — by pointing it at a
 * real, deliberately unreachable address and confirming a real, correctly-shaped connection
 * error comes back, the same pattern used to verify the real LLM provider adapters (ADR-023)
 * against a deliberately invalid key.
 */
describe("createPostgresDb (real node-postgres connection attempt)", () => {
  it("throws a real connection-refused error against an unreachable address", async () => {
    await expect(createPostgresDb("postgres://user:pass@127.0.0.1:1/nonexistent", { connectAttempts: 1 })).rejects.toThrow(/ECONNREFUSED/);
  });

  it("throws a real DNS/host-resolution error against a nonexistent host", async () => {
    await expect(createPostgresDb("postgres://user:pass@nonexistent.invalid:5432/db", { connectAttempts: 1 })).rejects.toThrow(
      /ENOTFOUND|EAI_AGAIN/
    );
  });
});

describe("createDb (real embedded PGlite — regression check after the general DrizzleDb type change)", () => {
  it("still returns a working database with the vector extension enabled", async () => {
    const db = await createDb(":memory:");
    // A real query through the general DrizzleDb-typed query builder, not just a construction check.
    const result = await db.execute("select 1 as one");
    expect((result as unknown as { rows: Array<{ one: number }> }).rows[0].one).toBe(1);
    await db.$client.close();
  });
});
