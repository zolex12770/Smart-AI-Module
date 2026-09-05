import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, runMigrations, type PgliteDb } from "@ai-platform/database";
import { PgRateLimitStore, reapExpiredRateLimits } from "./rate-limit-store.js";

/**
 * docs/26_DECISIONS.md ADR-071.
 *
 * The property under test is the one a per-process store cannot have: two INDEPENDENT store
 * instances — standing in for two API instances behind a load balancer — must enforce ONE
 * limit between them, not one each. Every test below therefore uses two stores over the same
 * database, because a single-store test would pass just as happily against the in-memory store
 * this replaced and would prove nothing.
 */
describe("PgRateLimitStore", () => {
  let db: PgliteDb;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as never;

  const store = (timeWindowMs = 60_000, namespace?: string) =>
    new PgRateLimitStore({ db, logger, timeWindowMs, namespace });

  /** Promise wrapper — the plugin's store contract is callback-based. */
  const incr = (s: PgRateLimitStore, key: string) =>
    new Promise<{ current: number; ttl: number }>((resolve, reject) => {
      s.incr(key, (error, result) => (error ? reject(error) : resolve(result!)));
    });

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await db.$client.close();
  });

  it("shares one counter across two independent instances", async () => {
    const instanceA = store();
    const instanceB = store();

    expect((await incr(instanceA, "1.2.3.4")).current).toBe(1);
    // The whole point: instance B continues A's count rather than starting its own.
    expect((await incr(instanceB, "1.2.3.4")).current).toBe(2);
    expect((await incr(instanceA, "1.2.3.4")).current).toBe(3);
  });

  it("counts distinct keys separately", async () => {
    const s = store();
    await incr(s, "1.2.3.4");
    await incr(s, "1.2.3.4");
    expect((await incr(s, "5.6.7.8")).current).toBe(1);
  });

  it("keeps each route's budget separate, so reads cannot exhaust the signup limit", async () => {
    // Both routes see the same client IP; without namespacing they would share a row.
    const globalStore = store().child({ timeWindow: 60_000, routeInfo: { method: "GET", url: "/api/v1/files" } });
    const signupStore = store().child({
      timeWindow: 600_000,
      routeInfo: { method: "POST", url: "/api/v1/auth/signup" },
    });

    await incr(globalStore as PgRateLimitStore, "1.2.3.4");
    await incr(globalStore as PgRateLimitStore, "1.2.3.4");
    expect((await incr(signupStore as PgRateLimitStore, "1.2.3.4")).current).toBe(1);
  });

  it("gives a child on the same route the same counter in a second process", async () => {
    // Two processes, same build: `child` is called from the plugin's onRoute hook with the same
    // route info, so the namespace — and therefore the row — must match.
    const routeInfo = { method: "POST", url: "/api/v1/auth/signup" };
    const fromA = store().child({ timeWindow: 600_000, routeInfo }) as PgRateLimitStore;
    const fromB = store().child({ timeWindow: 600_000, routeInfo }) as PgRateLimitStore;

    await incr(fromA, "9.9.9.9");
    expect((await incr(fromB, "9.9.9.9")).current).toBe(2);
  });

  it("reports a ttl inside the configured window", async () => {
    const result = await incr(store(60_000), "1.2.3.4");
    expect(result.ttl).toBeGreaterThan(50_000);
    expect(result.ttl).toBeLessThanOrEqual(60_000);
  });

  it("starts a new window once the old one has expired", async () => {
    const s = store(200);
    expect((await incr(s, "1.2.3.4")).current).toBe(1);
    expect((await incr(s, "1.2.3.4")).current).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    // The reset is decided inside the upsert against the stored expiry, not by a background
    // sweep — an expired row must not carry its old count into the new window.
    expect((await incr(s, "1.2.3.4")).current).toBe(1);
  });

  it("parses a duration string window the way the plugin passes it", async () => {
    const child = store().child({ timeWindow: "10 minutes" }) as PgRateLimitStore;
    const result = await incr(child, "1.2.3.4");
    expect(result.ttl).toBeGreaterThan(9 * 60_000);
  });

  it("fails OPEN and logs when the database is unreachable", async () => {
    await db.$client.close();
    const result = await incr(store(), "1.2.3.4");

    // current: 0 is below every configured max, so the request proceeds. A limiter that cannot
    // count must not become an outage — it is a mitigation, not an authorization boundary
    // (contrast the malware scanner's fail-closed rule, ADR-042).
    expect(result.current).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) }),
      expect.stringContaining("rate limit store unavailable")
    );

    // Re-open so afterEach's close does not throw on an already-closed client.
    db = await createDb(":memory:");
  });

  it("fails open when there is no database handle at all, rather than throwing", async () => {
    // Not hypothetical: wiring `db` into the composition root but forgetting it in a second
    // construction path is exactly what happened, and because the throw was SYNCHRONOUS it
    // escaped the promise `.catch` and surfaced as a 500 on every single request — the precise
    // opposite of what a limiter that cannot count should do.
    const broken = new PgRateLimitStore({ db: undefined as never, logger, timeWindowMs: 60_000 });
    const result = await incr(broken, "1.2.3.4");
    expect(result.current).toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });

  it("reaps only counters whose window closed over an hour ago", async () => {
    const s = store(60_000);
    await incr(s, "recent");
    await reapExpiredRateLimits(db);
    // A live window survives the sweep; reaping it would hand an abusive client a fresh budget.
    expect((await incr(s, "recent")).current).toBe(2);
  });
});
