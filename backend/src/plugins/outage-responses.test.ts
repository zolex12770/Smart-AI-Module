import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { buildTestApp, closeTestApp } from "../test-app.js";
import type { AppContext } from "../context.js";
import { isDatabaseUnreachable } from "./error-handler.js";

/**
 * DL-23 — what the failure-injection run found with Postgres stopped on the compose stack.
 *
 * 1. `/api/health` answered 500 to a caller that carried a session cookie: the auth hook looked
 *    the session up in the database before the route ran. Liveness that fails during an outage
 *    the process would survive gets it restarted by the orchestrator.
 * 2. Every authenticated read answered 500 "Something went wrong" — the same answer as a bug —
 *    where the database being unreachable is an outage a client may retry: 503.
 */
describe("responses during a database outage", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;

  // What drizzle throws when the socket cannot be opened, shape taken from the compose run's log.
  const unreachable = () =>
    Object.assign(new Error('Failed query: select "sessions"."id" from "sessions"\nparams: x'), {
      query: 'select "sessions"."id" from "sessions"',
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND postgres"), { code: "ENOTFOUND" }),
    });

  beforeEach(async () => {
    ({ app, db, ctx } = await buildTestApp());
    await app.ready();
    ctx.auth.authenticate = async () => {
      throw unreachable();
    };
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  it("keeps liveness at 200 when the caller presents a session cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health", cookies: { aip_session: "a-real-looking-token" } });
    expect(res.statusCode).toBe(200);
  });

  it("answers 503 DATABASE_UNAVAILABLE, not 500, and names no host", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/memory", cookies: { aip_session: "a-real-looking-token" } });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.json().error.code).toBe("DATABASE_UNAVAILABLE");
    expect(res.body).not.toMatch(/postgres|ENOTFOUND|select/i);
  });
});

describe("isDatabaseUnreachable", () => {
  it("recognises a failed query whose cause is a socket error or a Postgres connection exception", () => {
    expect(isDatabaseUnreachable({ query: "select 1", cause: { code: "ECONNREFUSED" } })).toBe(true);
    expect(isDatabaseUnreachable({ query: "select 1", cause: { cause: { code: "57P01" } } })).toBe(true);
    expect(isDatabaseUnreachable({ query: "select 1", cause: { code: "08006" } })).toBe(true);
  });

  it("does not call a query that failed for another reason an outage", () => {
    expect(isDatabaseUnreachable({ query: "insert …", cause: { code: "23505" } })).toBe(false);
  });

  it("does not call an unreachable MODEL runtime a database outage", () => {
    // The same socket code, but not from a query: the embedding runtime being down.
    const err = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    expect(isDatabaseUnreachable(err)).toBe(false);
  });
});
