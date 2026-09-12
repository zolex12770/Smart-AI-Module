import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { buildTestApp, closeTestApp } from "../test-app.js";
import type { AppContext } from "../context.js";

/**
 * Deny by default — docs/26_DECISIONS.md ADR-097.
 *
 * `server.ts` states that "a route absent from this list requires authentication; there is no
 * ambient authority anywhere else in the API", and the auth plugin's own docstring said the same.
 * Neither was true: `publicPaths` was accepted by the plugin and never read. The property rested
 * entirely on every route remembering its own guard — and an audit of all 53 routes found that
 * they all did, which is precisely why nothing had ever noticed.
 *
 * The test that matters is therefore not "an existing route refuses an anonymous caller" — every
 * route already did that by itself. It is "a route that FORGETS its guard is still refused", so
 * one registered here with no guard at all, which is the future mistake the list exists to catch.
 */
describe("authentication is refused by default, not per route", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;

  beforeEach(async () => {
    ({ app, db, ctx } = await buildTestApp());
    // A route with NO guard in its handler, registered after the auth plugin exactly as the
    // real routes are. Before ADR-097 this answered 200 to an anonymous caller.
    app.get("/api/v1/__unguarded_probe", async () => ({ leaked: "sensitive" }));
    await app.ready();
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  it("refuses an anonymous request to a route whose handler names no permission", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/__unguarded_probe" });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("sensitive");
  });

  it("still serves every genuinely public path without a credential", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);

    const signup = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signup",
      payload: { email: "deny-default@example.com", password: "a-sufficiently-long-password", displayName: "D" },
    });
    expect(signup.statusCode).toBe(201);
  });

  it("a query string cannot smuggle a protected path past the check", async () => {
    // The comparison is against the route PATTERN, not the raw URL, so appending the name of a
    // public path as a query value changes nothing.
    const res = await app.inject({ method: "GET", url: "/api/v1/__unguarded_probe?next=/api/health" });
    expect(res.statusCode).toBe(401);
  });

  it("an unknown path is still a 404, not a 401 — the refusal must not leak the route table", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/definitely-not-a-route" });
    expect(res.statusCode).toBe(404);
  });
});
