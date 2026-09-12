import { sql } from "drizzle-orm";
import type { DrizzleDb } from "@ai-platform/database";
import type { Logger } from "@ai-platform/observability";

/**
 * A rate-limit store shared by every API instance — docs/26_DECISIONS.md ADR-071.
 *
 * WHAT WAS WRONG. `@fastify/rate-limit`'s default store is a per-process LRU. That is exactly
 * right for one instance and quietly wrong for more than one: with N instances behind a load
 * balancer each keeps its OWN counter, so the effective limit is N × max. The signup limit
 * that ADR-049 set to 5-per-10-minutes to blunt account-farming becomes 5N, and it degrades in
 * the worst possible direction — the harder an attacker hammers the endpoint, the more
 * instances the autoscaler adds, and the higher the real limit climbs. The product brief calls
 * for horizontal scale, and infrastructure/terraform provisions a Cloud Run service with
 * max_instance_count > 1, so this was a live defect and not a hypothetical one.
 *
 * WHY POSTGRES AND NOT REDIS. Redis is the conventional answer and would be marginally faster.
 * It would also be a second piece of mandatory infrastructure to provision, secure, monitor and
 * fail over — for a workload of one tiny upsert per request against a database this platform
 * already requires and already holds a pool to. The brief's rule is to avoid dependencies until
 * they earn their place; a counter table earns nothing by being in Redis at this scale. The
 * store interface below is the whole coupling surface, so swapping in Redis later is one file.
 *
 * CORRECTNESS. The counter advances in ONE statement — an upsert whose UPDATE branch decides,
 * inside the same statement, whether the stored window has expired (start over at 1) or is
 * still live (increment). Postgres takes a row lock for the duration, so concurrent requests
 * from any number of instances serialize on that row: no read-then-write race, no lost update,
 * and no need for a transaction wrapper. A fixed window is fully described by when it ends,
 * which is why there is no separate window-start column.
 *
 * FAILURE POLICY. If the database is unreachable this FAILS OPEN — the request is allowed and
 * the error is logged. That is a deliberate trade and the opposite of the malware scanner's
 * fail-closed rule (ADR-042), because the two protect different things: a scanner that cannot
 * scan must not certify a file as clean, whereas a limiter that cannot count would otherwise
 * turn a database blip into a total outage for every user. Rate limiting is a mitigation, not
 * an authorization boundary; nothing in the security model rests on it.
 */

/** The store shape `@fastify/rate-limit` constructs and calls. */
export interface RateLimitStore {
  incr(key: string, callback: (error: Error | null, result?: { current: number; ttl: number }) => void): void;
  child(routeOptions: { timeWindow?: number | string; keyGenerator?: unknown }): RateLimitStore;
}

/** Milliseconds, from the number or duration-string `@fastify/rate-limit` may hand us. */
function windowMs(timeWindow: number | string | undefined, fallback: number): number {
  if (typeof timeWindow === "number") return timeWindow;
  if (typeof timeWindow !== "string") return fallback;
  const match = /^\s*(\d+)\s*(ms|s|m|h|d|milliseconds?|seconds?|minutes?|hours?|days?)?\s*$/i.exec(timeWindow);
  if (!match) return fallback;
  const value = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  if (unit.startsWith("d")) return value * 86_400_000;
  if (unit.startsWith("h")) return value * 3_600_000;
  if (unit.startsWith("mi") || unit === "m") return value * 60_000;
  if (unit.startsWith("s")) return value * 1_000;
  return value;
}

export interface PgRateLimitStoreDeps {
  db: DrizzleDb;
  logger: Logger;
  /** Window for the store as constructed; `child()` overrides it per route. */
  timeWindowMs: number;
  /**
   * Distinguishes one route's counters from another's inside the single table. Every `child()`
   * gets a fresh namespace, because @fastify/rate-limit generates the same key (the client IP)
   * for every route and unnamespaced rows would make the global limit and the signup limit
   * share one counter — reads would consume the signup budget.
   */
  namespace?: string;
}

export class PgRateLimitStore implements RateLimitStore {
  private readonly db: DrizzleDb;
  private readonly logger: Logger;
  private readonly timeWindowMs: number;
  private readonly namespace: string;
  private childSeq = 0;

  constructor(deps: PgRateLimitStoreDeps) {
    this.db = deps.db;
    this.logger = deps.logger;
    this.timeWindowMs = deps.timeWindowMs;
    this.namespace = deps.namespace ?? "global";
  }

  incr(key: string, callback: (error: Error | null, result?: { current: number; ttl: number }) => void): void {
    const storeKey = `${this.namespace}:${key}`;
    const windowSeconds = Math.max(1, Math.round(this.timeWindowMs / 1000));

    // One statement. The CASE arms are evaluated against the row as it was locked, so an
    // expired window resets to 1 and a live one increments — atomically, for all instances.
    const statement = sql`
      insert into rate_limit_counters (key, count, expires_at)
      values (${storeKey}, 1, now() + make_interval(secs => ${windowSeconds}))
      on conflict (key) do update set
        count = case when rate_limit_counters.expires_at <= now() then 1 else rate_limit_counters.count + 1 end,
        expires_at = case
          when rate_limit_counters.expires_at <= now() then now() + make_interval(secs => ${windowSeconds})
          else rate_limit_counters.expires_at
        end
      returning count, extract(epoch from (expires_at - now())) * 1000 as ttl_ms
    `;

    // The whole call is wrapped, not just the promise: a misconfigured store (no handle at
    // all) throws synchronously, and an uncaught throw inside a Fastify preHandler is a 500 on
    // EVERY request — the precise opposite of the fail-open policy above.
    let pending: Promise<unknown>;
    try {
      pending = this.db.execute(statement);
    } catch (error: unknown) {
      this.failOpen(error, callback);
      return;
    }

    void pending
      .then((result) => {
        const rows = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? (result as unknown as Array<Record<string, unknown>>);
        const row = Array.isArray(rows) ? rows[0] : undefined;
        if (!row) {
          // No row back from a `returning` clause should be impossible; treat it the way a
          // database error is treated rather than inventing a count.
          callback(null, { current: 0, ttl: this.timeWindowMs });
          return;
        }
        callback(null, {
          current: Number(row.count),
          ttl: Math.max(0, Math.round(Number(row.ttl_ms))),
        });
      })
      .catch((error: unknown) => this.failOpen(error, callback));
  }

  /** Allows the request and says so in the log. See the failure-policy note above. */
  private failOpen(
    error: unknown,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void
  ): void {
    this.logger.error(
      { error: error instanceof Error ? error.message : String(error), namespace: this.namespace },
      "rate limit store unavailable — allowing the request"
    );
    callback(null, { current: 0, ttl: this.timeWindowMs });
  }

  child(routeOptions: { timeWindow?: number | string; routeInfo?: { method?: unknown; url?: unknown } }): RateLimitStore {
    // The namespace must be stable for a given route across instances and across restarts, or
    // two instances would count the same route in different rows and the shared limit would
    // silently become per-instance again — the exact bug this class exists to fix. The plugin
    // passes the route's method and path (it calls `child` once per route from its `onRoute`
    // hook), which is both stable and legible in the table; the registration-order counter is
    // only a fallback for the decorator path, which this app does not use.
    const seq = this.childSeq++;
    const { method, url } = routeOptions.routeInfo ?? {};
    const route =
      typeof method === "string" && typeof url === "string" ? `${method}:${url}` : `seq${seq}`;
    return new PgRateLimitStore({
      db: this.db,
      logger: this.logger,
      timeWindowMs: windowMs(routeOptions.timeWindow, this.timeWindowMs),
      namespace: route,
    });
  }
}

/**
 * Deletes counters whose window has closed.
 *
 * Expired rows are already harmless — `incr` treats one as a fresh window — so this is pure
 * housekeeping, not correctness. Without it the table grows by one row per distinct client IP
 * per route forever, which is a slow leak rather than a bug, so it runs on a timer and its
 * failure is logged rather than propagated.
 */
export async function reapExpiredRateLimits(db: DrizzleDb): Promise<void> {
  await db.execute(sql`delete from rate_limit_counters where expires_at <= now() - interval '1 hour'`);
}
