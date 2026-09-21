import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  NotFoundError,
  PermissionError,
  UnauthorizedError,
  ValidationError,
  addProjectMemberRequestSchema,
  changePasswordRequestSchema,
  createApiKeyRequestSchema,
  deleteAccountRequestSchema,
  createProjectRequestSchema,
  loginRequestSchema,
  signupRequestSchema,
} from "@ai-platform/shared";
import { generateCsrfToken } from "@ai-platform/security";
import { removeProjectWorkspace } from "@ai-platform/tools";
import type { AppContext } from "../../context.js";
import { CSRF_COOKIE, SESSION_COOKIE, requireProject, requireUser } from "../../plugins/auth.js";

/**
 * The account-scoped routes refuse an API key — docs/26_DECISIONS.md ADR-147.
 *
 * ADR-108 established the rule for account deletion and gave the reason in full: an API key is
 * bound to exactly one project and is documented as an automation credential, the kind that
 * lives in CI or in a contractor's script, and a bearer request is exempt from CSRF. It must
 * not be able to act on the ACCOUNT that owns it.
 *
 * The rule was then written out by hand at two of the four places it applies, and the two that
 * were missed — listing and revoking browser sessions — are exactly the ones that let a
 * project-scoped key enumerate every live session of its owner, with the IP address and user
 * agent ADR-127 stores so a human can recognise their own laptop, and then end all of them.
 * One helper, so the next account-scoped route cannot be written without meeting it.
 */
function requireSessionCredential(request: FastifyRequest, action: string): void {
  if (request.auth?.method !== "session") {
    throw new PermissionError(`${action} requires a signed-in session; an API key cannot do it.`);
  }
}

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

  /**
   * Changing your own password, and seeing who else is signed in — docs/26_DECISIONS.md ADR-127.
   *
   * `revokeAllSessions` shipped with the docstring "used on password change and by an admin" and
   * neither caller existed: there was no way to change a password, no way to see a session, and
   * no way to end one. A user whose laptop was stolen could do nothing at all.
   *
   * Session credential only, like account deletion (ADR-108): an API key is a project-scoped
   * automation credential and must not be able to take over the account that owns it. Rate
   * limited per authenticated user, because this is a place where a stolen session could
   * otherwise be used to guess the password more cheaply than the front door.
   */
  app.post(
    "/api/v1/auth/password",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "15 minutes",
          hook: "preHandler",
          keyGenerator: (req: FastifyRequest) => req.auth?.user.id ?? req.ip,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      requireSessionCredential(request, "Changing a password");
      const parsed = changePasswordRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      const result = await ctx.auth.changePassword(user.id, parsed.data.currentPassword, parsed.data.newPassword, {
        ipAddress: request.ip,
        requestId: request.id,
      });

      // The caller's own session is among the revoked ones, deliberately: a password change that
      // left one live token behind would be useless against the case it exists for. The cookies
      // go too, so the browser does not keep presenting a credential the server has already
      // thrown away.
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      reply.clearCookie(CSRF_COOKIE, { path: "/" });
      reply.send({ ok: true, revokedSessions: result.revokedSessions, signedOut: true });
    }
  );

  app.get("/api/v1/auth/sessions", async (request) => {
    const user = requireUser(request);
    requireSessionCredential(request, "Listing your sessions");
    return { sessions: await ctx.auth.listSessions(user.id) };
  });

  app.delete("/api/v1/auth/sessions/:sessionId", async (request, reply) => {
    const user = requireUser(request);
    requireSessionCredential(request, "Ending a session");
    const { sessionId } = request.params as { sessionId: string };
    // Scoped to the caller inside the update, so another user's session id matches nothing and
    // is reported as absent rather than refused — the two are indistinguishable on purpose.
    const revoked = await ctx.auth.revokeSession(user.id, sessionId, {
      ipAddress: request.ip,
      requestId: request.id,
    });
    if (!revoked) throw new NotFoundError(`Session "${sessionId}" not found.`);
    reply.send({ ok: true });
  });

  // --- projects -------------------------------------------------------------------------

  app.get("/api/v1/projects", async (request) => {
    const user = requireUser(request);
    return { projects: await ctx.auth.listProjectsForUser(user.id) };
  });

  /**
   * Rate-limited per USER — docs/26_DECISIONS.md ADR-126.
   *
   * Creating projects was unbounded and cheap, and every spend ceiling was per project, so a
   * loop here bought as much budget as it liked. The ceilings draw against the tenant now
   * (ADR-126) and `createProject` caps how many an organization may hold; this stops the loop
   * itself, so neither the database nor the audit log can be filled at request speed. Keyed on
   * the authenticated user rather than the address, for the reason set out on account deletion.
   */
  app.post(
    "/api/v1/projects",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "10 minutes",
          hook: "preHandler",
          keyGenerator: (req: FastifyRequest) => req.auth?.user.id ?? req.ip,
        },
      },
    },
    async (request, reply) => {
    const user = requireUser(request);
    const parsed = createProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const organizationId = await ctx.auth.primaryOrganizationId(user.id);
    const project = await ctx.auth.createProject(user, organizationId, parsed.data.name, parsed.data.description);
    reply.status(201).send({ project });
  }
  );

  /**
   * Collaboration, reachable from the product — docs/26_DECISIONS.md ADR-154.
   *
   * `POST .../members` was the only member route and nothing in the product called it, so the
   * viewer/editor/admin table could not be used: every user a deployment created through its own
   * interface administered their own project, and a `viewer` existed only in tests. Listing and
   * removal are what make the grant a system rather than a one-way door.
   */
  app.get<{ Params: { projectId: string } }>("/api/v1/projects/:projectId/members", async (request) => {
    // Seeing who your collaborators are is not privileged; granting and revoking are.
    const authCtx = await requireProject(request, ctx.auth, "project:read");
    return { members: await ctx.auth.listProjectMembers(authCtx) };
  });

  /**
   * Deleting a project — ADR-159. `projects.deleted_at` was documented in the schema and had no
   * writer anywhere, so the soft delete did not exist and the per-organization cap could never
   * be freed.
   */
  app.delete<{ Params: { projectId: string } }>("/api/v1/projects/:projectId", async (request) => {
    const authCtx = await requireProject(request, ctx.auth, "project:admin");
    const deleted = await ctx.auth.deleteProject(authCtx, { ipAddress: request.ip, requestId: request.id });
    if (!deleted) throw new NotFoundError(`Project "${request.params.projectId}" not found.`);
    return { ok: true };
  });

  app.post("/api/v1/projects/:projectId/members", async (request, reply) => {
    const authCtx = await requireProject(request, ctx.auth, "project:admin");
    const parsed = addProjectMemberRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const result = await ctx.auth.addProjectMember(authCtx, parsed.data.email, parsed.data.role);
    reply.status(201).send(result);
  });

  app.delete<{ Params: { projectId: string; userId: string } }>(
    "/api/v1/projects/:projectId/members/:userId",
    async (request) => {
      const authCtx = await requireProject(request, ctx.auth, "project:admin");
      const removed = await ctx.auth.removeProjectMember(authCtx, request.params.userId);
      // 404 rather than 403 for a member of another project: the same disclosure rule as
      // everywhere else (ADR-089).
      if (!removed) throw new NotFoundError(`No member "${request.params.userId}" in this project.`);
      return { ok: true };
    }
  );

  /**
   * Account and data deletion — NFR-008, docs/26_DECISIONS.md ADR-102.
   *
   * There was previously no way to delete an account or its data by any route, CLI or repository
   * call, and no way even to suspend one. It is self-service rather than an operator ticket
   * because a privacy requirement satisfied only by asking someone else is not satisfied.
   *
   * Three things guard it, and each guards something different:
   *  - an interactive session (who — an API key is refused), the current password (that it is
   *    really them, counted against the account lockout), and a typed confirmation (that they
   *    meant this request and not a neighbouring one).
   *  - a rate limit per user, because the password check here is a password check like any other.
   *  - a wrong password is 401 and a wrong confirmation is 400, so the two are distinguishable
   *    to the person typing and neither reveals anything to anyone else.
   *
   * The response reports what was destroyed, including any storage object that could NOT be
   * removed. Reporting success while leaving a tenant's files on disk would be the one failure
   * mode of a deletion endpoint that matters.
   */
  app.delete(
    "/api/v1/auth/account",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "15 minutes",
          // Keyed on the AUTHENTICATED USER and evaluated after authentication (ADR-108). The
          // default key is `request.ip`, which was once the client-supplied leftmost
          // X-Forwarded-For entry (ADR-112): rotating that header gave unlimited password guesses.
          // A per-user key holds however the address is derived. `preHandler` runs after the auth
          // plugin's own preHandler, so `request.auth` is set.
          hook: "preHandler",
          keyGenerator: (req: FastifyRequest) => req.auth?.user.id ?? req.ip,
        },
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      // A person with a browser session, not a credential (ADR-108). An API key is a
      // project-scoped automation credential; it must not be able to destroy the account and
      // every organization the user solely owns, and a bearer request is exempt from CSRF.
      requireSessionCredential(request, "Deleting an account");
      const parsed = deleteAccountRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);

      if (!(await ctx.auth.verifyUserPassword(user.id, parsed.data.password, { ipAddress: request.ip, requestId: request.id }))) {
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

      // And the agent workspaces (ADR-109): every file the agent wrote for a deleted project lives
      // under SANDBOX_ROOT/<projectId>, and with the project row gone nothing could ever reach it.
      const workspaceFailures: string[] = [];
      for (const projectId of result.deletedProjectIds) {
        try {
          await removeProjectWorkspace(ctx.sandboxRoot, projectId);
        } catch (err) {
          workspaceFailures.push(projectId);
          request.log.error(
            { err, project_id: projectId, user_id: result.userId },
            "account deleted, but a project workspace could not be removed"
          );
        }
      }

      // Queued work for a deleted project would still run — calling a paid provider for an account
      // that no longer exists — and then fail at the foreign key (ADR-109). Work that has already
      // started cannot be stopped here; the asset stores remove its bytes when its row cannot be written.
      let queuedJobsCancelled = 0;
      const jobFailures: string[] = [];
      for (const projectId of result.deletedProjectIds) {
        try {
          queuedJobsCancelled += await ctx.jobQueue.cancelPendingForProject(projectId);
        } catch (err) {
          jobFailures.push(projectId);
          request.log.error(
            { err, project_id: projectId, user_id: result.userId },
            "account deleted, but its queued jobs could not be cancelled"
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
          workspaces: result.deletedProjectIds.length - workspaceFailures.length,
          queuedJobs: queuedJobsCancelled,
        },
        // Projects another user can still reach keep their content; only this user's access ended.
        retainedOrganizations: result.retainedOrganizationIds.length,
        retainedProjects: result.retainedProjectIds.length,
        storageObjectsNotRemoved: failures,
        workspacesNotRemoved: workspaceFailures,
        projectsWithJobsNotCancelled: jobFailures,
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
