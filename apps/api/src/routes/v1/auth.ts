import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ValidationError,
  addProjectMemberRequestSchema,
  createApiKeyRequestSchema,
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
 * cannot exfiltrate a session), `SameSite=Lax` (not sent on cross-site POSTs), and `Secure`
 * in production. The CSRF cookie is deliberately NOT httpOnly — the SPA must read it to echo
 * it back, which is the whole mechanism of a double-submit token.
 */
export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const setSessionCookies = (reply: FastifyReply, token: string, expiresAt: Date) => {
    const csrf = generateCsrfToken();
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: ctx.cookieSecure,
      path: "/",
      expires: expiresAt,
    });
    reply.setCookie(CSRF_COOKIE, csrf, {
      httpOnly: false,
      sameSite: "lax",
      secure: ctx.cookieSecure,
      path: "/",
      expires: expiresAt,
    });
    return csrf;
  };

  app.post(
    "/api/v1/auth/signup",
    // Tighter than the global limit: account creation is the classic abuse target.
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
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
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
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
