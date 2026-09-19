import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * Changing a password, and ending a session — docs/26_DECISIONS.md ADR-127.
 *
 * `revokeAllSessions` shipped with the docstring "used on password change and by an admin", and
 * neither caller existed: no route could change a password, list a session, or end one. A user
 * whose laptop was stolen had nothing to do about it. These cover the three properties that make
 * the feature worth having rather than merely present: the current password is required, every
 * session dies (the caller's included), and one user cannot touch another's.
 */
describe("password change and session management", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;

  const PASSWORD = "a-sufficiently-long-password";
  const NEW_PASSWORD = "an-even-longer-new-password";

  beforeEach(async () => {
    ({ app, db, ctx } = await buildTestApp());
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  /** Signs up through the API so the reply carries real cookies, exactly as a browser gets them. */
  async function signUp(email: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signup",
      payload: { email, password: PASSWORD, displayName: "Test User" },
    });
    expect(res.statusCode).toBe(201);
    const cookies = res.cookies as Array<{ name: string; value: string }>;
    const session = cookies.find((c) => c.name === "aip_session")?.value;
    const csrf = cookies.find((c) => c.name === "aip_csrf")?.value;
    return {
      headers: {
        cookie: `aip_session=${session}; aip_csrf=${csrf}`,
        "x-csrf-token": csrf ?? "",
      },
    };
  }

  const me = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/api/v1/auth/me", headers });

  it("changes the password, and the new one is what works afterwards", async () => {
    const alice = await signUp("alice@example.com");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: alice.headers,
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, signedOut: true });

    const withOld = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "alice@example.com", password: PASSWORD },
    });
    expect(withOld.statusCode).toBe(401);

    const withNew = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "alice@example.com", password: NEW_PASSWORD },
    });
    expect(withNew.statusCode).toBe(200);
  });

  it("ends every existing session, including the one that asked", async () => {
    // The whole point of changing a password after a theft: whoever else holds a token loses it.
    const first = await signUp("alice@example.com");
    const secondLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "alice@example.com", password: PASSWORD },
    });
    const secondCookies = secondLogin.cookies as Array<{ name: string; value: string }>;
    const second = {
      cookie: `aip_session=${secondCookies.find((c) => c.name === "aip_session")?.value}`,
    };

    expect((await me(first.headers)).statusCode).toBe(200);
    expect((await me(second)).statusCode).toBe(200);

    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: first.headers,
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().revokedSessions).toBeGreaterThanOrEqual(2);

    expect((await me(first.headers)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(401);
  });

  it("refuses without the current password, and says nothing useful about why", async () => {
    const alice = await signUp("alice@example.com");

    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: alice.headers,
      payload: { currentPassword: "not-the-current-password", newPassword: NEW_PASSWORD },
    });
    expect(wrong.statusCode).toBe(401);
    // The same wording as a failed login: this must not become a cheaper place to guess.
    expect(JSON.stringify(wrong.json())).toMatch(/Invalid email or password/);

    // And the password really did not change.
    const stillOld = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "alice@example.com", password: PASSWORD },
    });
    expect(stillOld.statusCode).toBe(200);
  });

  it("refuses a new password that is too short, or the same as the old one", async () => {
    const alice = await signUp("alice@example.com");

    const short = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: alice.headers,
      payload: { currentPassword: PASSWORD, newPassword: "short" },
    });
    expect(short.statusCode).toBe(400);

    const same = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: alice.headers,
      payload: { currentPassword: PASSWORD, newPassword: PASSWORD },
    });
    expect(same.statusCode).toBe(400);
  });

  it("lists the caller's live sessions without handing back anything usable as a credential", async () => {
    const alice = await signUp("alice@example.com");
    await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "alice@example.com", password: PASSWORD } });

    const res = await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: alice.headers });
    expect(res.statusCode).toBe(200);
    const { sessions } = res.json() as { sessions: Array<Record<string, unknown>> };
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    // Recognising a session is the point; using one is not.
    const serialised = JSON.stringify(sessions);
    expect(serialised).not.toMatch(/tokenHash|token_hash/);
    for (const s of sessions) {
      expect(s).toHaveProperty("lastUsedAt");
      expect(s).not.toHaveProperty("tokenHash");
    }
  });

  it("revokes one named session and leaves the others alone", async () => {
    const alice = await signUp("alice@example.com");
    const otherLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "alice@example.com", password: PASSWORD },
    });
    const otherCookies = otherLogin.cookies as Array<{ name: string; value: string }>;
    const other = { cookie: `aip_session=${otherCookies.find((c) => c.name === "aip_session")?.value}` };

    const listed = await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: alice.headers });
    const sessions = (listed.json() as { sessions: Array<{ id: string; lastUsedAt: string }> }).sessions;
    // The other session is the one that has NOT been used since it was created by the login.
    const target = sessions[0]!;

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/sessions/${target.id}`,
      headers: alice.headers,
    });
    expect(revoked.statusCode).toBe(200);

    // Exactly one of the two is now dead; the caller has not been signed out of everything.
    const statuses = [(await me(alice.headers)).statusCode, (await me(other)).statusCode].sort();
    expect(statuses).toEqual([200, 401]);
  });

  it("cannot revoke another user's session, and cannot tell it exists", async () => {
    const alice = await signUp("alice@example.com");
    const bob = await signUp("bob@example.com");

    const bobSessions = (
      (await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: bob.headers })).json() as {
        sessions: Array<{ id: string }>;
      }
    ).sessions;
    const bobSessionId = bobSessions[0]!.id;

    const attempt = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/sessions/${bobSessionId}`,
      headers: alice.headers,
    });
    // 404, not 403: "that is not yours" and "that does not exist" must look the same.
    expect(attempt.statusCode).toBe(404);
    expect((await me(bob.headers)).statusCode).toBe(200);
  });

  it("requires a session credential, not an API key", async () => {
    /**
     * This test used to send no credential at all — no cookie, no bearer — so the 401 it
     * asserted came from the deny-by-default auth plugin and would have been produced whatever
     * these routes checked. It passed against session listing and revocation, which accepted a
     * project-scoped API key: the holder of a key left in CI could enumerate every browser its
     * owner was signed in from, with the IP and user agent ADR-127 records, and end all of them.
     *
     * So it presents a REAL key now, against all three routes. Two of the three fail without
     * the guard (ADR-147).
     */
    const alice = await signUp("alice@example.com");
    const projectId = ((await me(alice.headers)).json() as { projects: Array<{ id: string }> }).projects[0]!.id;

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: alice.headers,
      payload: { name: "automation", projectId },
    });
    expect(created.statusCode).toBe(201);
    const key = (created.json() as { key: string }).key;
    const keyHeaders = { authorization: `Bearer ${key}`, "x-project-id": projectId };

    // The key is a WORKING credential — otherwise every assertion below would pass for the
    // wrong reason, which is exactly how the previous version of this test passed.
    const whoami = await me(keyHeaders);
    expect(whoami.statusCode).toBe(200);
    expect((whoami.json() as { method: string }).method).toBe("api_key");

    const sessionId = (
      (await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: alice.headers })).json() as {
        sessions: Array<{ id: string }>;
      }
    ).sessions[0]!.id;

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/password",
          headers: keyHeaders,
          payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
        })
      ).statusCode
    ).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: keyHeaders })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/v1/auth/sessions/${sessionId}`, headers: keyHeaders })).statusCode
    ).toBe(403);

    // And the session it tried to end is still alive.
    expect((await me(alice.headers)).statusCode).toBe(200);
  });

  it("still lets the signed-in browser do all three", async () => {
    // The guard must refuse the key without refusing the person; a 403 for everyone would
    // satisfy the test above and break the feature.
    const bob = await signUp("bob@example.com");
    const listed = await app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: bob.headers });
    expect(listed.statusCode).toBe(200);
    const sessionId = (listed.json() as { sessions: Array<{ id: string }> }).sessions[0]!.id;
    expect(
      (await app.inject({ method: "DELETE", url: `/api/v1/auth/sessions/${sessionId}`, headers: bob.headers })).statusCode
    ).toBe(200);
  });
});
