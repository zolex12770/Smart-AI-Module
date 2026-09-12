import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  apiKeys,
  auditLog,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  sessions,
  users,
  type DrizzleDb,
  deleteUserAccount,
  type AccountDeletionResult,
} from "@ai-platform/database";
import {
  ConflictError,
  NotFoundError,
  PermissionError,
  UnauthorizedError,
  ValidationError,
  resolvePermissions,
  type AuthContext,
  type AuthenticatedUser,
  type AuthMethod,
  type OrgRole,
  type Permission,
  type ProjectRole,
} from "@ai-platform/shared";
import { v4 as uuid } from "uuid";
import { hashPassword, needsRehash, verifyPassword, type ScryptParams } from "./password.js";
import { generateApiKey, generateSessionToken, hashToken } from "./tokens.js";

export interface AuthServiceOptions {
  /** Session lifetime. Sliding: `lastUsedAt` advances on use, `expiresAt` does not. */
  sessionTtlMs?: number;
  /** Failed logins before a temporary lockout. */
  maxFailedLogins?: number;
  lockoutMs?: number;
  scryptParams?: ScryptParams;
  now?: () => Date;
}

export interface SignupInput {
  email: string;
  password: string;
  displayName: string;
  organizationName?: string;
}

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

/**
 * Identity, tenancy and authorization (docs/26_DECISIONS.md ADR-049).
 *
 * Everything that decides *who* a caller is and *what* they may touch lives here, so there
 * is exactly one place to audit. Three properties are deliberate and load-bearing:
 *
 * - **Failures are indistinguishable.** A wrong password and an unknown email produce the
 *   same error and do comparable work, so the endpoint is not a user-enumeration oracle.
 * - **Authorization returns permissions, never booleans about a row.** Callers ask for an
 *   `AuthContext` scoped to a project; repositories then filter by that project id in SQL.
 * - **Every decision is auditable.** `recordAudit` is called for both grants and denials.
 */
export class AuthService {
  private readonly sessionTtlMs: number;
  private readonly maxFailedLogins: number;
  private readonly lockoutMs: number;
  private readonly scryptParams: ScryptParams | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly db: DrizzleDb,
    options: AuthServiceOptions = {}
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.maxFailedLogins = options.maxFailedLogins ?? 10;
    this.lockoutMs = options.lockoutMs ?? 15 * 60 * 1000;
    this.scryptParams = options.scryptParams;
    this.now = options.now ?? (() => new Date());
  }

  // --- registration ---------------------------------------------------------------------

  /**
   * Creates the user, their organization, and their first project in ONE transaction. A
   * half-created account (user with no organization) would be unusable and un-repairable
   * through the API, which is exactly the case a transaction exists to prevent.
   *
   * Self-registration NEVER produces a system administrator. That is what `bootstrapSystemAdmin`
   * is for, and it is a separate method precisely so no HTTP-reachable path can ask for the flag.
   */
  async signup(input: SignupInput, meta: RequestMeta = {}): Promise<{ user: AuthenticatedUser; projectId: string }> {
    return this.createAccount(input, meta, { isSystemAdmin: false, requireEmptyUserTable: false });
  }

  /**
   * Creates the FIRST system administrator, and only on an empty user table — ADR-096.
   *
   * Nothing could set `is_system_admin`. `signup` hardcoded it to false, the column defaults to
   * false, and no migration seeded a row — so the flag was unreachable, and with it the entire
   * `/admin` surface and the ONLY control that can enable an MCP tool. Every one of those routes
   * answered 404 to every user who could exist, which reads exactly like correct tenant
   * isolation. `bootstrapFirstAdmin` logged "BOOTSTRAPPED THE FIRST ADMINISTRATOR" and had in
   * fact created an ordinary account.
   *
   * Emptiness is re-checked INSIDE the transaction: the caller's check is an optimisation, this
   * is the guarantee. So two processes racing cannot both win, and this can never promote anyone
   * on a database that already has users — the one property that makes an unauthenticated
   * bootstrap path safe to have at all.
   */
  async bootstrapSystemAdmin(
    input: SignupInput,
    meta: RequestMeta = {}
  ): Promise<{ user: AuthenticatedUser; projectId: string }> {
    return this.createAccount(input, meta, { isSystemAdmin: true, requireEmptyUserTable: true });
  }

  private async createAccount(
    input: SignupInput,
    meta: RequestMeta,
    options: { isSystemAdmin: boolean; requireEmptyUserTable: boolean }
  ): Promise<{ user: AuthenticatedUser; projectId: string }> {
    const email = input.email.trim().toLowerCase();
    const passwordHash = await hashPassword(input.password, this.scryptParams);
    const now = this.now();
    const userId = uuid();
    const orgId = uuid();
    const projectId = uuid();

    try {
      await this.db.transaction(async (tx) => {
        if (options.requireEmptyUserTable) {
          const anyUser = await tx.select({ id: users.id }).from(users).limit(1);
          if (anyUser.length > 0) {
            throw new ConflictError(
              "Refusing to bootstrap an administrator: this database already has user accounts."
            );
          }
        }
        const existing = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
        if (existing.length > 0) throw new ConflictError("An account with that email already exists.");

        await tx.insert(users).values({
          id: userId,
          email,
          passwordHash,
          displayName: input.displayName,
          status: "active",
          isSystemAdmin: options.isSystemAdmin,
          failedLoginCount: 0,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(organizations).values({
          id: orgId,
          name: input.organizationName?.trim() || `${input.displayName}'s organization`,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(organizationMembers).values({
          id: uuid(),
          organizationId: orgId,
          userId,
          role: "owner",
          createdAt: now,
        });
        await tx.insert(projects).values({
          id: projectId,
          organizationId: orgId,
          name: "Default project",
          description: "Created automatically at signup.",
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(projectMembers).values({
          id: uuid(),
          projectId,
          userId,
          role: "admin",
          createdAt: now,
        });
      });
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      // A unique-index violation from a concurrent signup for the same email.
      if (String(err).includes("users_email_unique")) {
        throw new ConflictError("An account with that email already exists.");
      }
      throw err;
    }

    await this.recordAudit({
      userId,
      projectId,
      action: "auth.signup",
      outcome: "success",
      method: "session",
      ...meta,
    });

    return {
      user: {
        id: userId,
        email,
        displayName: input.displayName,
        status: "active",
        isSystemAdmin: options.isSystemAdmin,
      },
      projectId,
    };
  }

  /**
   * Confirms a caller really knows their own password — NFR-008, ADR-102.
   *
   * Separate from `login` on purpose: this must NOT mint a session, and it must not touch the
   * lockout counter either way. A re-authentication prompt that can lock you out of the account
   * you are about to delete is a worse experience than the risk it mitigates, and the rate limit
   * on the route already bounds guessing.
   */
  async verifyUserPassword(userId: string, password: string): Promise<boolean> {
    const rows = await this.db
      .select({ passwordHash: users.passwordHash, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row || row.status !== "active") return false;
    return verifyPassword(password, row.passwordHash);
  }

  /**
   * Deletes the caller's account and the data they solely own — NFR-008, ADR-102.
   *
   * The audit record is written BEFORE the deletion, because `audit_log.user_id` is
   * `onDelete: "set null"`: writing it afterwards would mean writing a row about a user that no
   * longer exists, and the foreign key would reject it. Written first, it survives the deletion
   * with a null user id and the email preserved in its metadata — which is what an operator
   * needs to answer "was this account deleted, and when", without retaining an account.
   *
   * Returns the storage objects the caller must now remove; see `deleteUserAccount`.
   */
  async deleteOwnAccount(userId: string, meta: RequestMeta = {}): Promise<AccountDeletionResult> {
    const rows = await this.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    if (!rows[0]) throw new NotFoundError("Account not found.");

    await this.recordAudit({
      userId,
      action: "auth.account_deleted",
      outcome: "success",
      method: "session",
      detail: { email: rows[0].email },
      ...meta,
    });

    return deleteUserAccount(this.db, userId);
  }


  // --- login / sessions -----------------------------------------------------------------

  async login(
    email: string,
    password: string,
    meta: RequestMeta = {}
  ): Promise<{ token: string; expiresAt: Date; user: AuthenticatedUser }> {
    const normalized = email.trim().toLowerCase();
    const rows = await this.db.select().from(users).where(eq(users.email, normalized)).limit(1);
    const row = rows[0];
    const now = this.now();

    // Always do the same work whether or not the account exists: verifying against a decoy
    // hash keeps the timing of "unknown email" close to "wrong password".
    const encoded = row?.passwordHash ?? DECOY_HASH;
    const passwordOk = await verifyPassword(password, encoded);

    if (!row || !passwordOk || row.status !== "active") {
      if (row) {
        const failed = row.failedLoginCount + 1;
        await this.db
          .update(users)
          .set({
            failedLoginCount: failed,
            lockedUntil: failed >= this.maxFailedLogins ? new Date(now.getTime() + this.lockoutMs) : row.lockedUntil,
            updatedAt: now,
          })
          .where(eq(users.id, row.id));
      }
      await this.recordAudit({
        userId: row?.id ?? null,
        action: "auth.login",
        outcome: "denied",
        method: "session",
        detail: { email: normalized, reason: !row ? "unknown_email" : !passwordOk ? "bad_password" : row.status },
        ...meta,
      });
      throw new UnauthorizedError("Invalid email or password.");
    }

    if (row.lockedUntil && row.lockedUntil > now) {
      await this.recordAudit({
        userId: row.id,
        action: "auth.login",
        outcome: "denied",
        method: "session",
        detail: { reason: "locked" },
        ...meta,
      });
      throw new UnauthorizedError("This account is temporarily locked after too many failed attempts.");
    }

    // Opportunistically upgrade a hash created under weaker parameters.
    const rehash = needsRehash(row.passwordHash, this.scryptParams)
      ? await hashPassword(password, this.scryptParams)
      : undefined;

    const { token, tokenHash } = generateSessionToken();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);

    await this.db.transaction(async (tx) => {
      await tx.insert(sessions).values({
        id: uuid(),
        userId: row.id,
        tokenHash,
        expiresAt,
        userAgent: meta.userAgent ?? null,
        ipAddress: meta.ipAddress ?? null,
        createdAt: now,
        lastUsedAt: now,
      });
      await tx
        .update(users)
        .set({
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: now,
          updatedAt: now,
          ...(rehash ? { passwordHash: rehash } : {}),
        })
        .where(eq(users.id, row.id));
    });

    await this.recordAudit({ userId: row.id, action: "auth.login", outcome: "success", method: "session", ...meta });

    return {
      token,
      expiresAt,
      user: {
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        status: row.status,
        isSystemAdmin: row.isSystemAdmin,
      },
    };
  }

  async logout(token: string, meta: RequestMeta = {}): Promise<void> {
    const tokenHash = hashToken(token);
    const now = this.now();
    const updated = await this.db
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
      .returning({ userId: sessions.userId });
    if (updated[0]) {
      await this.recordAudit({
        userId: updated[0].userId,
        action: "auth.logout",
        outcome: "success",
        method: "session",
        ...meta,
      });
    }
  }

  /** Revokes every session for a user — used on password change and by an admin. */
  async revokeAllSessions(userId: string): Promise<number> {
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: this.now() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return rows.length;
  }

  // --- credential resolution -------------------------------------------------------------

  /**
   * Resolves a bearer credential to a user. Returns null rather than throwing so the caller
   * decides whether an unauthenticated request is fatal (most routes) or fine (public ones).
   */
  async authenticate(
    credential: { kind: "session"; token: string } | { kind: "api_key"; key: string }
  ): Promise<{ user: AuthenticatedUser; method: AuthMethod; credentialId: string; projectId?: string } | null> {
    const now = this.now();
    if (credential.kind === "session") {
      const tokenHash = hashToken(credential.token);
      const rows = await this.db
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
        .limit(1);
      const row = rows[0];
      if (!row || row.user.status !== "active") return null;
      // Sliding activity timestamp; not awaited on the hot path for latency, but errors are
      // swallowed deliberately — a failed bookkeeping write must not fail the request.
      void this.db
        .update(sessions)
        .set({ lastUsedAt: now })
        .where(eq(sessions.id, row.session.id))
        .catch(() => undefined);
      return {
        user: toAuthenticatedUser(row.user),
        method: "session",
        credentialId: row.session.id,
      };
    }

    const keyHash = hashToken(credential.key);
    const rows = await this.db
      .select({ key: apiKeys, user: users })
      .from(apiKeys)
      .innerJoin(users, eq(apiKeys.userId, users.id))
      .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
      .limit(1);
    const row = rows[0];
    if (!row || row.user.status !== "active") return null;
    if (row.key.expiresAt && row.key.expiresAt <= now) return null;
    void this.db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.key.id)).catch(() => undefined);
    return {
      user: toAuthenticatedUser(row.user),
      method: "api_key",
      credentialId: row.key.id,
      // An API key is bound to one project; it can never be used against another.
      projectId: row.key.projectId,
    };
  }

  // --- authorization ---------------------------------------------------------------------

  /**
   * The single authorization decision point. Returns the caller's effective permissions on
   * one project, or throws. A project the caller cannot see raises `NotFoundError`, not
   * `PermissionError`: telling an outsider that a project id exists is itself a leak.
   */
  async authorizeProject(
    user: AuthenticatedUser,
    projectId: string,
    method: AuthMethod,
    credentialId: string
  ): Promise<AuthContext> {
    const rows = await this.db
      .select({
        project: projects,
        projectRole: projectMembers.role,
        orgRole: organizationMembers.role,
      })
      .from(projects)
      .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.id)))
      .leftJoin(
        organizationMembers,
        and(eq(organizationMembers.organizationId, projects.organizationId), eq(organizationMembers.userId, user.id))
      )
      .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
      .limit(1);

    const row = rows[0];
    if (!row) throw new NotFoundError(`Project "${projectId}" not found.`);

    const orgRole = (row.orgRole as OrgRole | null) ?? null;
    const projectRole = (row.projectRole as ProjectRole | null) ?? null;
    if (!orgRole && !projectRole && !user.isSystemAdmin) {
      // Deliberately a 404, not a 403 — see the method docstring.
      throw new NotFoundError(`Project "${projectId}" not found.`);
    }

    const permissions = user.isSystemAdmin
      ? resolvePermissions("owner", "admin")
      : resolvePermissions(orgRole, projectRole);

    return {
      user,
      method,
      credentialId,
      projectId: row.project.id,
      organizationId: row.project.organizationId,
      permissions,
    };
  }

  /** Throws unless the context carries the permission. Records the denial. */
  async requirePermission(ctx: AuthContext, permission: Permission, meta: RequestMeta = {}): Promise<void> {
    if (ctx.permissions.includes(permission)) return;
    await this.recordAudit({
      userId: ctx.user.id,
      projectId: ctx.projectId ?? null,
      action: `authz.${permission}`,
      outcome: "denied",
      method: ctx.method,
      ...meta,
    });
    throw new PermissionError(`This action requires the "${permission}" permission.`);
  }

  // --- projects -------------------------------------------------------------------------

  async listProjectsForUser(userId: string): Promise<Array<{ id: string; name: string; organizationId: string; role: string }>> {
    const rows = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        organizationId: projects.organizationId,
        projectRole: projectMembers.role,
        orgRole: organizationMembers.role,
      })
      .from(projects)
      .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)))
      .leftJoin(
        organizationMembers,
        and(eq(organizationMembers.organizationId, projects.organizationId), eq(organizationMembers.userId, userId))
      )
      .where(isNull(projects.deletedAt))
      .orderBy(desc(projects.createdAt));

    return rows
      .filter((r) => r.projectRole !== null || r.orgRole === "owner" || r.orgRole === "admin")
      .map((r) => ({
        id: r.id,
        name: r.name,
        organizationId: r.organizationId,
        role: r.projectRole ?? (r.orgRole === null ? "viewer" : "admin"),
      }));
  }

  async createProject(
    user: AuthenticatedUser,
    organizationId: string,
    name: string,
    description?: string
  ): Promise<{ id: string; name: string }> {
    const membership = await this.db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, user.id)))
      .limit(1);
    if (!membership[0] && !user.isSystemAdmin) {
      throw new NotFoundError(`Organization "${organizationId}" not found.`);
    }

    const now = this.now();
    const id = uuid();
    await this.db.transaction(async (tx) => {
      await tx.insert(projects).values({ id, organizationId, name, description: description ?? null, createdAt: now, updatedAt: now });
      await tx.insert(projectMembers).values({ id: uuid(), projectId: id, userId: user.id, role: "admin", createdAt: now });
    });
    await this.recordAudit({
      userId: user.id,
      projectId: id,
      action: "project.create",
      outcome: "success",
      method: "session",
      resourceType: "project",
      resourceId: id,
    });
    return { id, name };
  }

  async primaryOrganizationId(userId: string): Promise<string> {
    const rows = await this.db
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("This account belongs to no organization.");
    return rows[0].organizationId;
  }

  async addProjectMember(ctx: AuthContext, email: string, role: ProjectRole): Promise<{ userId: string }> {
    if (!ctx.projectId) throw new ValidationError("A project must be selected.");
    const target = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (!target[0]) throw new NotFoundError(`No account exists for ${email}.`);
    const now = this.now();
    await this.db
      .insert(projectMembers)
      .values({ id: uuid(), projectId: ctx.projectId, userId: target[0].id, role, createdAt: now })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.userId],
        set: { role },
      });
    await this.recordAudit({
      userId: ctx.user.id,
      projectId: ctx.projectId,
      action: "project.member.add",
      outcome: "success",
      method: ctx.method,
      resourceType: "user",
      resourceId: target[0].id,
      detail: { role },
    });
    return { userId: target[0].id };
  }

  // --- api keys --------------------------------------------------------------------------

  /** The plaintext key is returned exactly once and never stored. */
  async createApiKey(
    ctx: AuthContext,
    name: string,
    expiresInDays?: number
  ): Promise<{ id: string; key: string; keyPrefix: string; expiresAt: Date | null }> {
    if (!ctx.projectId) throw new ValidationError("A project must be selected.");
    const { key, keyHash, keyPrefix } = generateApiKey();
    const now = this.now();
    const id = uuid();
    const expiresAt = expiresInDays ? new Date(now.getTime() + expiresInDays * 86_400_000) : null;
    await this.db.insert(apiKeys).values({
      id,
      userId: ctx.user.id,
      projectId: ctx.projectId,
      name,
      keyHash,
      keyPrefix,
      expiresAt,
      createdAt: now,
    });
    await this.recordAudit({
      userId: ctx.user.id,
      projectId: ctx.projectId,
      action: "apikey.create",
      outcome: "success",
      method: ctx.method,
      resourceType: "api_key",
      resourceId: id,
    });
    return { id, key, keyPrefix, expiresAt };
  }

  async listApiKeys(ctx: AuthContext) {
    if (!ctx.projectId) throw new ValidationError("A project must be selected.");
    return this.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.projectId, ctx.projectId))
      .orderBy(desc(apiKeys.createdAt));
  }

  async revokeApiKey(ctx: AuthContext, keyId: string): Promise<void> {
    if (!ctx.projectId) throw new ValidationError("A project must be selected.");
    // Scoped to the caller's project: a key id from another project simply matches nothing.
    const rows = await this.db
      .update(apiKeys)
      .set({ revokedAt: this.now() })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.projectId, ctx.projectId)))
      .returning({ id: apiKeys.id });
    if (!rows[0]) throw new NotFoundError(`API key "${keyId}" not found.`);
    await this.recordAudit({
      userId: ctx.user.id,
      projectId: ctx.projectId,
      action: "apikey.revoke",
      outcome: "success",
      method: ctx.method,
      resourceType: "api_key",
      resourceId: keyId,
    });
  }

  // --- audit -----------------------------------------------------------------------------

  async recordAudit(entry: {
    userId?: string | null;
    projectId?: string | null;
    action: string;
    outcome: "success" | "denied" | "failure";
    method: AuthMethod | "system";
    resourceType?: string;
    resourceId?: string;
    detail?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
    requestId?: string;
  }): Promise<void> {
    try {
      await this.db.insert(auditLog).values({
        id: uuid(),
        userId: entry.userId ?? null,
        projectId: entry.projectId ?? null,
        action: entry.action,
        resourceType: entry.resourceType ?? null,
        resourceId: entry.resourceId ?? null,
        outcome: entry.outcome,
        method: entry.method,
        ipAddress: entry.ipAddress ?? null,
        requestId: entry.requestId ?? null,
        detail: entry.detail ?? null,
        createdAt: this.now(),
      });
    } catch (err) {
      // An audit write must never convert a successful request into a 500, but losing one
      // silently is also unacceptable — surface it on stderr for the log pipeline.
      // eslint-disable-next-line no-console
      console.error("[security] failed to write audit row:", err);
    }
  }

  async listAudit(ctx: AuthContext, limit = 100) {
    if (!ctx.projectId) throw new ValidationError("A project must be selected.");
    return this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.projectId, ctx.projectId))
      .orderBy(desc(auditLog.createdAt))
      .limit(Math.min(limit, 500));
  }

  /** Count of active users — used by the bootstrap path to detect a fresh installation. */
  async userCount(): Promise<number> {
    const rows = await this.db.select({ count: sql<number>`count(*)::int` }).from(users);
    return Number(rows[0]?.count ?? 0);
  }
}

function toAuthenticatedUser(row: typeof users.$inferSelect): AuthenticatedUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    isSystemAdmin: row.isSystemAdmin,
  };
}

/**
 * A real scrypt hash of a random value, used to equalise work on the unknown-email path.
 * Generated once at module load so login timing does not depend on account existence.
 */
const DECOY_HASH =
  "scrypt$4096$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" +
  "Ki2N0oQhWkYlqvVQrHkbT0M9m2vCkQ8QO2K8YvOaZ6t8sZQe1H0oQm4wYb1Nl5rD8f0K3xX7cJ0oP5vT9wQ2Zg==";
