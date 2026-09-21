import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { generateCsrfToken } from "@ai-platform/security";
import { buildTestApp, closeTestApp, TEST_PASSWORD } from "../../test-app.js";
import type { AppContext } from "../../context.js";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "../../plugins/auth.js";

/**
 * The role table, usable at last — docs/26_DECISIONS.md ADR-154.
 *
 * `PROJECT_ROLE_PERMISSIONS` defines viewer, editor and admin, and `POST .../members` was the
 * only route that could create a non-admin member. Nothing in the product called it, and there
 * was no way to LIST members or REMOVE one at all — so a grant was a one-way door reachable only
 * by hand-writing an HTTP request, every user a deployment created through its own interface
 * administered their own project, and a `viewer` existed only inside tests.
 *
 * These drive the three routes against the real app and assert what each role can then do, which
 * is the part that makes the table a permission system rather than a column.
 */
describe("project members", () => {
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

  /** A second real account, through the real signup path, with its own session headers. */
  async function secondUser(label: string) {
    const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
    const created = await ctx.auth.signup({
      email,
      password: TEST_PASSWORD,
      displayName: label,
      organizationName: `${label} Org`,
    });
    const session = await ctx.auth.login(email, TEST_PASSWORD);
    const csrf = generateCsrfToken();
    return {
      email,
      userId: created.user.id,
      /** Headers scoped to the FIRST project, which is where they are being added as a member. */
      headers: {
        cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${csrf}`,
        [CSRF_HEADER]: csrf,
        "x-project-id": auth.projectId,
      },
    };
  }

  const members = (headers: Record<string, string>) =>
    app.inject({ method: "GET", url: `/api/v1/projects/${auth.projectId}/members`, headers });

  it("lists the creator as the project's admin", async () => {
    const res = await members(auth.headers);
    expect(res.statusCode).toBe(200);
    const { members: rows } = res.json() as { members: Array<{ userId: string; role: string }> };
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: auth.userId, role: "admin" });
  });

  it("adds a viewer who can then read the project but not spend in it", async () => {
    const viewer = await secondUser("viewer");

    // Before the grant, the project is not theirs at all — 404, not 403 (ADR-089).
    expect((await members(viewer.headers)).statusCode).toBe(404);

    const added = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${auth.projectId}/members`,
      headers: auth.headers,
      payload: { email: viewer.email, role: "viewer" },
    });
    expect(added.statusCode).toBe(201);

    // The role is real, in both directions: the viewer can read...
    const listed = await members(viewer.headers);
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { members: unknown[] }).members).toHaveLength(2);

    // ...and cannot spend. `chat:write` is an editor permission; a viewer is refused.
    const chat = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: viewer.headers,
      payload: { messages: [{ role: "user", content: "hello" }] },
    });
    expect(chat.statusCode).toBe(403);
  });

  it("removes a member, and their access goes with the row", async () => {
    const editor = await secondUser("editor");
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${auth.projectId}/members`,
      headers: auth.headers,
      payload: { email: editor.email, role: "editor" },
    });
    expect((await members(editor.headers)).statusCode).toBe(200);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${auth.projectId}/members/${editor.userId}`,
      headers: auth.headers,
    });
    expect(removed.statusCode).toBe(200);

    // The project is not theirs any more, and says so the same way it did before the grant.
    expect((await members(editor.headers)).statusCode).toBe(404);
  });

  it("refuses to remove the last administrator", async () => {
    // A project whose every admin has been removed can never have another one added, because
    // adding one requires `project:admin`. The guard is what stops it locking itself out.
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${auth.projectId}/members/${auth.userId}`,
      headers: auth.headers,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(/last administrator/i);
    expect((await members(auth.headers)).statusCode).toBe(200);
  });

  it("lets an editor read the member list but not change it", async () => {
    const editor = await secondUser("editor2");
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${auth.projectId}/members`,
      headers: auth.headers,
      payload: { email: editor.email, role: "editor" },
    });

    expect((await members(editor.headers)).statusCode).toBe(200);
    const attempt = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${auth.projectId}/members/${auth.userId}`,
      headers: editor.headers,
    });
    expect(attempt.statusCode).toBe(403);
  });
});
