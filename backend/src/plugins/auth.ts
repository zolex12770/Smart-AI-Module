import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  PermissionError,
  UnauthorizedError,
  ValidationError,
  type AuthContext,
  type AuthenticatedUser,
  type Permission,
} from "@ai-platform/shared";
import type { AuthService } from "@ai-platform/security";

/**
 * Authentication and authorization for every request — docs/26_DECISIONS.md ADR-049.
 *
 * The platform previously had none: every route ran for any caller, and ownership was a
 * hardcoded `local-user` string. This plugin is the single gate. Its shape reflects three
 * decisions:
 *
 * - **Authentication is global; authorization is per-route.** A `preHandler` resolves the
 *   caller's identity for every request (cheap, indexed hash lookup) and REFUSES any request
 *   to a path outside `publicPaths` that presented no valid credential. What a caller may then
 *   do is decided by each route naming the permission it needs; a route that names nothing gets
 *   nothing.
 *
 *   The refusal is new (ADR-097). `publicPaths` was accepted by this plugin and never read, so
 *   the claim that "a route absent from this list requires authentication; there is no ambient
 *   authority anywhere else in the API" rested entirely on every route remembering its own
 *   guard. Today all of them do -- audited, only `/api/health` and signup lack one, and both are
 *   public -- but the property was asserted in two docstrings and enforced in none, which is the
 *   kind of gap that is discovered by the first route that forgets.
 * - **Two credential types, one context.** A browser sends an httpOnly session cookie; a
 *   program sends `Authorization: Bearer aip_...`. Both resolve to the same `AuthContext`, so
 *   no route needs to care which was used.
 * - **CSRF applies only to cookies.** A bearer token is not attached automatically by the
 *   browser, so it is not forgeable cross-site; a cookie is. Mutating requests authenticated
 *   by cookie must therefore carry the double-submit token, and those authenticated by API
 *   key must not be required to.
 */

export const SESSION_COOKIE = "aip_session";
export const CSRF_COOKIE = "aip_csrf";
export const CSRF_HEADER = "x-csrf-token";

declare module "fastify" {
  interface FastifyRequest {
    /** Set for every request; null when the caller presented no valid credential. */
    auth: { user: AuthenticatedUser; method: "session" | "api_key"; credentialId: string; projectId?: string } | null;
  }
}

export interface AuthPluginOptions {
  authService: AuthService;
  cookieSecure: boolean;
  /** Paths that never require authentication. Everything else does. */
  publicPaths: string[];
  /**
   * Paths whose caller is never looked up, even when a credential is presented — liveness
   * (DL-23). The lookup is a database query; with Postgres stopped, a probe that carried a
   * session cookie got 500 from `/api/health`, and an orchestrator restarts a process whose
   * liveness fails, although this one recovers by itself when the database returns.
   */
  anonymousPaths?: string[];
}

export function registerAuth(app: FastifyInstance, options: AuthPluginOptions): void {
  app.decorateRequest("auth", null);

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const matched = request.routeOptions?.url;
    // Only a path that is ALSO public: skipping the lookup must never skip the deny below.
    if (matched && options.anonymousPaths?.includes(matched) && options.publicPaths.includes(matched)) {
      request.auth = null;
      return;
    }
    const bearer = readBearer(request);
    const cookie = request.cookies?.[SESSION_COOKIE];

    if (bearer) {
      request.auth = await options.authService.authenticate({ kind: "api_key", key: bearer });
    } else if (cookie) {
      request.auth = await options.authService.authenticate({ kind: "session", token: cookie });
      if (request.auth && isMutating(request.method)) {
        assertCsrf(request);
      }
    } else {
      request.auth = null;
    }

    // Deny by default (ADR-097). Compared against the ROUTE PATTERN rather than the raw URL, so
    // a query string cannot smuggle a path past it and a parameterised route is matched as it
    // was declared. OPTIONS is exempt: a CORS preflight carries no credential by definition.
    // Only for a MATCHED route. Fastify runs this hook for the not-found handler too, where
    // `routeOptions.url` is undefined -- refusing there would answer 401 to every unknown path,
    // turning a plain 404 into an authentication challenge for a route that does not exist.
    // There is nothing behind an unmatched path to protect, so it stays a 404.
    const routeUrl = request.routeOptions?.url;
    if (
      routeUrl &&
      !request.auth &&
      request.method.toUpperCase() !== "OPTIONS" &&
      !options.publicPaths.includes(routeUrl)
    ) {
      if (cookie) reply.clearCookie(SESSION_COOKIE, { path: "/" });
      throw new UnauthorizedError("Authentication required.");
    }

    // A stale or revoked cookie should not leave the browser retrying forever with it.
    if (!request.auth && cookie) {
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
    }
  });
}

function readBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || Array.isArray(header)) return null;
  const [scheme, ...rest] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return null;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
}

function isMutating(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

/**
 * Double-submit cookie check. The token is readable by the SPA (not httpOnly) and must be
 * echoed in a header; a cross-site attacker can cause the cookie to be sent but cannot read
 * it to set the header, which is what makes the pair meaningful.
 */
function assertCsrf(request: FastifyRequest): void {
  const cookie = request.cookies?.[CSRF_COOKIE];
  const header = request.headers[CSRF_HEADER];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!cookie || !provided || cookie !== provided) {
    throw new PermissionError("Missing or invalid CSRF token for a cookie-authenticated request.");
  }
}

/** Throws unless the caller is authenticated. Use in any route that touches user data. */
export function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.auth) throw new UnauthorizedError("Authentication is required for this endpoint.");
  return request.auth.user;
}

/**
 * The workhorse: resolves the caller's project scope and checks one permission.
 *
 * The project comes from the API key (which is bound to exactly one project and may never
 * act outside it), or from an explicit `projectId` on the body/query/params. An API key that
 * names a different project is refused rather than silently honoured.
 */
export async function requireProject(
  request: FastifyRequest,
  authService: AuthService,
  permission: Permission
): Promise<AuthContext> {
  const auth = request.auth;
  if (!auth) throw new UnauthorizedError("Authentication is required for this endpoint.");

  const requested = extractProjectId(request);
  let projectId: string;
  if (auth.method === "api_key") {
    if (!auth.projectId) throw new PermissionError("This API key is not bound to a project.");
    if (requested && requested !== auth.projectId) {
      throw new PermissionError("This API key cannot act on a different project.");
    }
    projectId = auth.projectId;
  } else {
    if (!requested) {
      throw new ValidationError("A projectId is required (send it as a query parameter or in the body).");
    }
    projectId = requested;
  }

  const ctx = await authService.authorizeProject(auth.user, projectId, auth.method, auth.credentialId);
  await authService.requirePermission(ctx, permission, {
    ipAddress: request.ip,
    requestId: request.id,
  });
  return ctx;
}

function extractProjectId(request: FastifyRequest): string | undefined {
  const fromParams = (request.params as Record<string, unknown> | undefined)?.projectId;
  if (typeof fromParams === "string") return fromParams;
  const fromQuery = (request.query as Record<string, unknown> | undefined)?.projectId;
  if (typeof fromQuery === "string") return fromQuery;
  const body = request.body as Record<string, unknown> | undefined;
  if (body && typeof body.projectId === "string") return body.projectId;
  const header = request.headers["x-project-id"];
  if (typeof header === "string") return header;
  return undefined;
}
