import { z } from "zod";

/**
 * Identity, tenancy and authorization types — docs/13_SECURITY_ARCHITECTURE.md §2,
 * docs/26_DECISIONS.md ADR-049. These replace the single hardcoded `local-user` owner that
 * every resource used to be attributed to.
 *
 * The hierarchy is User -> Organization -> Project -> Resource. Every user-content row in
 * the database carries a `project_id`, and every read path filters on a project the caller
 * is a member of. That filter is the IDOR defence: authorization is applied in the SQL
 * `WHERE`, not by checking an id after the row has already been fetched.
 */

/** Organization-wide role. `owner` is the only role that can delete the organization. */
export const orgRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrgRole = z.infer<typeof orgRoleSchema>;

/** Per-project role. `viewer` is read-only; `editor` may run agents and spend quota. */
export const projectRoleSchema = z.enum(["admin", "editor", "viewer"]);
export type ProjectRole = z.infer<typeof projectRoleSchema>;

export const accountStatusSchema = z.enum(["active", "suspended", "deleted"]);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

/**
 * The permission vocabulary. Every protected route names the permission it needs, so a
 * route's authorization requirement is declared at the route rather than inferred.
 */
export const permissionSchema = z.enum([
  "project:read",
  "project:write",
  "project:admin",
  "chat:write",
  "agent:run",
  "agent:approve",
  "files:read",
  "files:write",
  "memory:read",
  "memory:write",
  "media:generate",
  "tools:manage",
  "mcp:manage",
  "usage:read",
  "apikey:manage",
  "org:admin",
]);
export type Permission = z.infer<typeof permissionSchema>;

const VIEWER: Permission[] = ["project:read", "files:read", "memory:read", "usage:read"];
const EDITOR: Permission[] = [
  ...VIEWER,
  "project:write",
  "chat:write",
  "agent:run",
  "agent:approve",
  "files:write",
  "memory:write",
  "media:generate",
];
const PROJECT_ADMIN: Permission[] = [...EDITOR, "project:admin", "tools:manage", "mcp:manage", "apikey:manage"];

/** Project role -> permissions. Deliberately a static table: RBAC that can be read in one place. */
export const PROJECT_ROLE_PERMISSIONS: Record<ProjectRole, readonly Permission[]> = {
  viewer: VIEWER,
  editor: EDITOR,
  admin: PROJECT_ADMIN,
};

/** Organization role -> extra permissions granted on every project in the organization. */
export const ORG_ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  owner: [...PROJECT_ADMIN, "org:admin"],
  admin: [...PROJECT_ADMIN, "org:admin"],
  member: [],
};

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  status: AccountStatus;
  isSystemAdmin: boolean;
}

/** How the caller proved who they are. Audit rows record this verbatim. */
export type AuthMethod = "session" | "api_key";

export interface AuthContext {
  user: AuthenticatedUser;
  method: AuthMethod;
  /** Session id or API-key id, for audit and revocation. */
  credentialId: string;
  /** Present once a request has been resolved against a specific project. */
  projectId?: string;
  organizationId?: string;
  permissions: readonly Permission[];
}

export function hasPermission(ctx: Pick<AuthContext, "permissions">, permission: Permission): boolean {
  return ctx.permissions.includes(permission);
}

/**
 * Effective permissions for a member of one project. An organization owner/admin gets
 * project-admin rights on every project in their organization without an explicit
 * membership row, which is what makes org administration workable; everyone else needs a
 * real `project_members` row.
 */
export function resolvePermissions(orgRole: OrgRole | null, projectRole: ProjectRole | null): Permission[] {
  const set = new Set<Permission>();
  if (orgRole) for (const p of ORG_ROLE_PERMISSIONS[orgRole]) set.add(p);
  if (projectRole) for (const p of PROJECT_ROLE_PERMISSIONS[projectRole]) set.add(p);
  return [...set];
}

// --- request schemas -------------------------------------------------------------------

/**
 * 12 characters minimum. NIST SP 800-63B explicitly recommends length over composition
 * rules, so there is deliberately no "must contain a symbol" requirement here.
 */
export const passwordSchema = z.string().min(12).max(256);
export const emailSchema = z.string().email().max(320).toLowerCase().trim();

export const signupRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().min(1).max(120).trim(),
  organizationName: z.string().min(1).max(120).trim().optional(),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const createProjectRequestSchema = z.object({
  name: z.string().min(1).max(120).trim(),
  description: z.string().max(2000).trim().optional(),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const createApiKeyRequestSchema = z.object({
  name: z.string().min(1).max(120).trim(),
  projectId: z.string().uuid(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;

export const addProjectMemberRequestSchema = z.object({
  email: emailSchema,
  role: projectRoleSchema,
});
export type AddProjectMemberRequest = z.infer<typeof addProjectMemberRequestSchema>;
