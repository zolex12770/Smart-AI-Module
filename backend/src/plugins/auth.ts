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
 *   caller's identity for every request (cheap, indexed hash lookup), but *what* they may do
 *   is decided by each route naming the permission it needs. A route that names nothing gets
 *   nothing — there is no ambient authority.
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
}

export function registerAuth(app: FastifyInstance, options: AuthPluginOptions): void {
  app.decorateRequest("auth", null);

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
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
