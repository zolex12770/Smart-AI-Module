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

  const invite = (email: string, role: string, headers: Record<string, string> = auth.headers) =>
    app.inject({ method: "POST", url: `/api/v1/projects/${auth.projectId}/members`, headers, payload: { email, role } });

  const myInvitations = async (headers: Record<string, string>) => {
    const res = await app.inject({ method: "GET", url: "/api/v1/invitations", headers });
    expect(res.statusCode).toBe(200);
    return (res.json() as { invitations: Array<{ id: string; projectId: string; role: string }> }).invitations;
  };

  const answer = (headers: Record<string, string>, id: string, verb: "accept" | "decline") =>
    app.inject({ method: "POST", url: `/api/v1/invitations/${id}/${verb}`, headers });

  const myEmail = async () =>
    ((await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: auth.headers })).json() as { user: { email: string } }).user.email;

  /** Invite, then accept as the invitee — the only way into a project now (DL-7). */
  async function join(user: Awaited<ReturnType<typeof secondUser>>, role: string) {
    expect((await invite(user.email, role)).statusCode).toBe(202);
    const [invitation] = await myInvitations(user.headers);
    expect((await answer(user.headers, invitation.id, "accept")).statusCode).toBe(200);
  }

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

    await join(viewer, "viewer");

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
    await join(editor, "editor");
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
    await join(editor, "editor");

    expect((await members(editor.headers)).statusCode).toBe(200);
    const attempt = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${auth.projectId}/members/${auth.userId}`,
      headers: editor.headers,
    });
    expect(attempt.statusCode).toBe(403);
  });

  describe("invitations (audit findings 9 and 10, DL-7)", () => {
    it("answers the same for a registered and an unregistered address, and adds nobody", async () => {
      const registered = await secondUser("registered");
      const a = await invite(registered.email, "editor");
      const b = await invite(`nobody-${Date.now()}@example.test`, "editor");
      expect(a.statusCode).toBe(202);
      expect(b.statusCode).toBe(202);
      const shape = (r: typeof a) => Object.keys(r.json() as object).sort();
      expect(shape(a)).toEqual(shape(b));
      expect((a.json() as { status: string }).status).toBe("invited");
      // Nothing changed for the registered account until it says yes.
      expect((await members(registered.headers)).statusCode).toBe(404);
      expect(((await members(auth.headers)).json() as { members: unknown[] }).members).toHaveLength(1);
    });

    it("lets only the addressee accept, and only once", async () => {
      const invitee = await secondUser("invitee");
      const stranger = await secondUser("stranger");
      await invite(invitee.email, "viewer");
      const [invitation] = await myInvitations(invitee.headers);
      expect(invitation.projectId).toBe(auth.projectId);
      expect(await myInvitations(stranger.headers)).toEqual([]);

      expect((await answer(stranger.headers, invitation.id, "accept")).statusCode).toBe(404);
      expect((await members(stranger.headers)).statusCode).toBe(404);

      expect((await answer(invitee.headers, invitation.id, "accept")).statusCode).toBe(200);
      expect((await members(invitee.headers)).statusCode).toBe(200);
      expect((await answer(invitee.headers, invitation.id, "accept")).statusCode).toBe(404);
    });

    it("declining, or a revoked invitation, grants nothing", async () => {
      const decliner = await secondUser("decliner");
      await invite(decliner.email, "editor");
      const [offer] = await myInvitations(decliner.headers);
      expect((await answer(decliner.headers, offer.id, "decline")).statusCode).toBe(200);
      expect((await members(decliner.headers)).statusCode).toBe(404);

      const revokee = await secondUser("revokee");
      await invite(revokee.email, "editor");
      const listed = await app.inject({ method: "GET", url: `/api/v1/projects/${auth.projectId}/invitations`, headers: auth.headers });
      const open = (listed.json() as { invitations: Array<{ id: string; email: string }> }).invitations;
      const target = open.find((i) => i.email === revokee.email)!;
      const revoked = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${auth.projectId}/invitations/${target.id}`,
        headers: auth.headers,
      });
      expect(revoked.statusCode).toBe(200);
      expect(await myInvitations(revokee.headers)).toEqual([]);
      expect((await answer(revokee.headers, target.id, "accept")).statusCode).toBe(404);
      expect((await members(revokee.headers)).statusCode).toBe(404);
    });

    it("an API key cannot answer an invitation", async () => {
      const key = await app.inject({
        method: "POST",
        url: "/api/v1/api-keys",
        headers: auth.headers,
        payload: { name: "ci" },
      });
      expect(key.statusCode).toBe(201);
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/invitations",
        headers: { authorization: `Bearer ${(key.json() as { key: string }).key}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("refuses to demote the last administrator through the add-member route", async () => {
      // Audit finding 10: removal was guarded, a role change was not.
      const res = await invite((await myEmail()), "viewer");
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toMatch(/last administrator/i);
      const rows = ((await members(auth.headers)).json() as { members: Array<{ userId: string; role: string }> }).members;
      expect(rows.find((m) => m.userId === auth.userId)?.role).toBe("admin");
    });

    it("changes a current member's role directly, and still lets a second admin step down", async () => {
      const second = await secondUser("second-admin");
      await join(second, "editor");
      const promoted = await invite(second.email, "admin");
      expect(promoted.statusCode).toBe(200);
      expect((promoted.json() as { status: string }).status).toBe("updated");
      // Two admins now: the first may become an editor.
      const me = await myEmail();
      expect((await invite(me, "editor")).statusCode).toBe(200);
    });
  });
});
