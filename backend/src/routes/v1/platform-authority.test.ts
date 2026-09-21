import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { generateCsrfToken } from "@ai-platform/security";
import { buildTestApp, closeTestApp, TEST_PASSWORD } from "../../test-app.js";
import type { AppContext } from "../../context.js";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "../../plugins/auth.js";
import { PLATFORM_ROUTE_PERMISSIONS } from "./platform.js";

/**
 * The authority table describes the whole surface, and is checked against it — ADR-159.
 *
 * `PLATFORM_ROUTE_PERMISSIONS` was exported "so a test can assert the surface is protected", and
 * a repo-wide grep returned the definition and nothing else: no test, no consumer. It omitted
 * five of the module's thirteen routes — including all three `/api/v1/admin/*` ones, which its
 * own docstring singles out as the case that must not be omitted, because "silently omitting the
 * admin routes would make the strongest guard the least visible".
 *
 * So this asserts both directions: every route the module registers appears in the table, and
 * every `system-admin` entry really does refuse an ordinary member — with 404, per ADR-089,
 * because confirming the endpoint exists is itself a disclosure.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The routes this module registers, read from its own source. */
function registeredPlatformRoutes(): string[] {
  const source = readFileSync(join(HERE, "platform.ts"), "utf8");
  return [...source.matchAll(/app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*"([^"]+)"/g)].map(
    (m) => `${m[1].toUpperCase()} ${m[2]}`
  );
}

describe("the platform authority table", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;
  let auth: Awaited<ReturnType<typeof buildTestApp>>["auth"];

  beforeEach(async () => {
    ({ app, db, ctx, auth } = await buildTestApp());
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  it("finds the routes at all", () => {
    // A parser that matched nothing would make the comparison below vacuous.
    expect(registeredPlatformRoutes().length).toBeGreaterThanOrEqual(12);
  });

  it("describes every route the module registers", () => {
    const registered = registeredPlatformRoutes();
    const missing = registered.filter((route) => !(route in PLATFORM_ROUTE_PERMISSIONS));
    expect(missing).toEqual([]);
  });

  it("names no route the module does not register", () => {
    // The other direction: an entry for a route that no longer exists reads as coverage.
    const registered = new Set(registeredPlatformRoutes());
    const phantom = Object.keys(PLATFORM_ROUTE_PERMISSIONS).filter((route) => !registered.has(route));
    expect(phantom).toEqual([]);
  });

  it("refuses an ordinary member on every system-admin route, with 404", async () => {
    const adminRoutes = Object.entries(PLATFORM_ROUTE_PERMISSIONS)
      .filter(([, permission]) => permission === "system-admin")
      .map(([route]) => route);
    // The table is only worth asserting against if it actually contains the strongest entries.
    expect(adminRoutes.length).toBeGreaterThanOrEqual(5);

    const refused: string[] = [];
    for (const route of adminRoutes) {
      const [method, path] = route.split(" ");
      const res = await app.inject({
        method: method as "GET" | "POST",
        url: path.replace(/:[A-Za-z]+/g, "something"),
        headers: auth.headers,
        ...(method === "POST" ? { payload: { enabled: true } } : {}),
      });
      // 404, never 403: ADR-089.
      if (res.statusCode !== 404) refused.push(`${route} -> ${res.statusCode}`);
    }
    expect(refused).toEqual([]);
  });

  it("lets an ordinary member reach the project-scoped ones", async () => {
    // A surface that refused everything would satisfy the assertion above.
    const res = await app.inject({ method: "GET", url: "/api/v1/tools", headers: auth.headers });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a viewer on the routes the table marks project:write", async () => {
    const email = `viewer-${Date.now()}@example.test`;
    await ctx.auth.signup({ email, password: TEST_PASSWORD, displayName: "Viewer", organizationName: "Viewer Org" });
    // Through the real route, with the project admin's own session — the same door an operator
    // uses, so this cannot pass against a service method the product cannot reach (ADR-154).
    const added = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${auth.projectId}/members`,
      headers: auth.headers,
      payload: { email, role: "viewer" },
    });
    expect(added.statusCode).toBe(201);
    const session = await ctx.auth.login(email, TEST_PASSWORD);
    const csrf = generateCsrfToken();
    const viewerHeaders = {
      cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${csrf}`,
      [CSRF_HEADER]: csrf,
      "x-project-id": auth.projectId,
    };

    const writeRoutes = Object.entries(PLATFORM_ROUTE_PERMISSIONS)
      .filter(([, permission]) => permission === "project:write")
      .map(([route]) => route);
    expect(writeRoutes.length).toBeGreaterThanOrEqual(2);

    for (const route of writeRoutes) {
      const [method, path] = route.split(" ");
      const res = await app.inject({
        method: method as "POST",
        url: path.replace(/:queue/g, "image.generate").replace(/:[A-Za-z]+/g, "something"),
        headers: viewerHeaders,
        payload: {},
      });
      expect(res.statusCode, route).toBe(403);
    }
  });
});
