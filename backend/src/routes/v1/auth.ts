import type { FastifyInstance, FastifyReply } from "fastify";
import {
  UnauthorizedError,
  ValidationError,
  addProjectMemberRequestSchema,
  createApiKeyRequestSchema,
  deleteAccountRequestSchema,
  createProjectRequestSchema,
  loginRequestSchema,
  signupRequestSchema,
} from "@ai-platform/shared";
import { generateCsrfToken } from "@ai-platform/security";
import type { AppContext } from "../../context.js";
import { CSRF_COOKIE, SESSION_COOKIE, requireProject, requireUser } from "../../plugins/auth.js";

/**
 * Identity, project and API-key endpoints — docs/26_DECISIONS.md ADR-049.
 *
 * Cookie policy: the session cookie is `httpOnly` (JavaScript cannot read it, so an XSS bug
 * cannot exfiltrate a session) and `Secure` in production. Its `SameSite` is resolved by the
 * composition root (ADR-070): `None` when Secure, because this platform deploys the web app
 * and the API as separate services on different hostnames and a `Lax` cookie is never sent on
 * a cross-site request — with `Lax` the deployed app could not authenticate at all. `Lax`
 * locally, where the two share a host and `None` would be rejected for not being Secure.
 *
 * The CSRF cookie is deliberately NOT httpOnly — the SPA must read it to echo it back, which
 * is the whole mechanism of a double-submit token. That is also why `SameSite=None` does not
 * reintroduce CSRF risk here: an attacker's site can cause the cookie to be sent but still
 * cannot read it to set the matching header.
 */
export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const setSessionCookies = (reply: FastifyReply, token: string, expiresAt: Date) => {
    const csrf = generateCsrfToken();
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: ctx.cookieSameSite,
      secure: ctx.cookieSecure,
      path: "/",
      expires: expiresAt,
    });
    reply.setCookie(CSRF_COOKIE, csrf, {
      httpOnly: false,
      sameSite: ctx.cookieSameSite,
      secure: ctx.cookieSecure,
      path: "/",
      expires: expiresAt,
    });
    return csrf;
  };

  app.post(
    "/api/v1/auth/signup",
    // Tighter than the global limit: account creation is the classic abuse target.
    { config: { rateLimit: { max: ctx.authRateLimitMax, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const parsed = signupRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      const { user, projectId } = await ctx.auth.signup(parsed.data, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
        requestId: request.id,
      });
      // Log the new account straight in — a signup that then demands a login is a worse
      // experience for no security gain, since the credential was just proven.
      const session = await ctx.auth.login(parsed.data.email, parsed.data.password, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
        requestId: request.id,
      });
      const csrfToken = setSessionCookies(reply, session.token, session.expiresAt);
      reply.status(201).send({ user, defaultProjectId: projectId, csrfToken });
    }
  );

  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: ctx.authRateLimitMax * 2, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const parsed = loginRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      const session = await ctx.auth.login(parsed.data.email, parsed.data.password, {
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"],
        requestId: request.id,
      });
      const csrfToken = setSessionCookies(reply, session.token, session.expiresAt);
      const projects = await ctx.auth.listProjectsForUser(session.user.id);
      reply.send({ user: session.user, projects, csrfToken });
    }
  );

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (token) {
      await ctx.auth.logout(token, { ipAddress: request.ip, requestId: request.id });
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    reply.send({ ok: true });
  });

  app.get("/api/v1/auth/me", async (request) => {
    const user = requireUser(request);
    const projects = await ctx.auth.listProjectsForUser(user.id);
    return { user, projects, method: request.auth?.method };
  });

  // --- projects -------------------------------------------------------------------------

  app.get("/api/v1/projects", async (request) => {
    const user = requireUser(request);
    return { projects: await ctx.auth.listProjectsForUser(user.id) };
  });

  app.post("/api/v1/projects", async (request, reply) => {
    const user = requireUser(request);
    const parsed = createProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const organizationId = await ctx.auth.primaryOrganizationId(user.id);
    const project = await ctx.auth.createProject(user, organizationId, parsed.data.name, parsed.data.description);
    reply.status(201).send({ project });
  });

  app.post("/api/v1/projects/:projectId/members", async (request, reply) => {
    const authCtx = await requireProject(request, ctx.auth, "project:admin");
    const parsed = addProjectMemberRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const result = await ctx.auth.addProjectMember(authCtx, parsed.data.email, parsed.data.role);
    reply.status(201).send(result);
  });

  /**
   * Account and data deletion — NFR-008, docs/26_DECISIONS.md ADR-102.
   *
   * There was previously no way to delete an account or its data by any route, CLI or repository
   * call, and no way even to suspend one. It is self-service rather than an operator ticket
   * because a privacy requirement satisfied only by asking someone else is not satisfied.
   *
   * Three things guard it, and each guards something different:
   *  - the session (who), the current password (that it is really them, not a stolen cookie),
   *    and a typed confirmation (that they meant this request and not a neighbouring one).
   *  - a tight rate limit, because the password check here is a password check like any other.
   *  - a wrong password is 401 and a wrong confirmation is 400, so the two are distinguishable
   *    to the person typing and neither reveals anything to anyone else.
   *
   * The response reports what was destroyed, including any storage object that could NOT be
   * removed. Reporting success while leaving a tenant's files on disk would be the one failure
   * mode of a deletion endpoint that matters.
   */
  app.delete(
    "/api/v1/auth/account",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const user = requireUser(request);
      const parsed = deleteAccountRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      if (!(await ctx.auth.verifyUserPassword(user.id, parsed.data.password))) {
        throw new UnauthorizedError("Password is incorrect.");
      }

      const result = await ctx.auth.deleteOwnAccount(user.id, {
        ipAddress: request.ip,
        requestId: request.id,
      });

      // The rows are gone; now the bytes. Each failure is reported rather than swallowed: an
      // orphaned object is a privacy problem, and the operator needs the paths to finish by hand.
      const failures: string[] = [];
      for (const asset of result.assets) {
        try {
          await ctx.assetStore.deleteByPath(asset.storagePath);
        } catch (err) {
          failures.push(asset.storagePath);
          request.log.error(
            { err, storage_path: asset.storagePath, user_id: result.userId },
            "account deleted, but a storage object could not be removed"
          );
        }
      }

      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      reply.clearCookie(CSRF_COOKIE, { path: "/" });
      return {
        deleted: {
          organizations: result.deletedOrganizationIds.length,
          projects: result.deletedProjectIds.length,
          storageObjects: result.assets.length - failures.length,
        },
        // Organizations with other members keep their content; only this user's access ended.
        retainedOrganizations: result.retainedOrganizationIds.length,
        storageObjectsNotRemoved: failures,
      };
    }
  );


  // --- api keys -------------------------------------------------------------------------

  app.get("/api/v1/api-keys", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "apikey:manage");
    return { apiKeys: await ctx.auth.listApiKeys(authCtx) };
  });

  app.post("/api/v1/api-keys", async (request, reply) => {
    const authCtx = await requireProject(request, ctx.auth, "apikey:manage");
    const parsed = createApiKeyRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const created = await ctx.auth.createApiKey(authCtx, parsed.data.name, parsed.data.expiresInDays);
    // The plaintext key appears in this response and nowhere else, ever.
    reply.status(201).send({
      apiKey: { id: created.id, keyPrefix: created.keyPrefix, expiresAt: created.expiresAt },
      key: created.key,
      warning: "This key is shown once. Store it now — it cannot be retrieved again.",
    });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/api-keys/:id", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "apikey:manage");
    await ctx.auth.revokeApiKey(authCtx, request.params.id);
    return { ok: true };
  });

  // --- audit ----------------------------------------------------------------------------

  app.get("/api/v1/audit", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:admin");
    return { entries: await ctx.auth.listAudit(authCtx) };
  });
}
