import { createHash } from "node:crypto";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
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
import { createDecoyHash, hashPassword, needsRehash, verifyPassword, type ScryptParams } from "./password.js";
import { generateApiKey, generateSessionToken, hashToken } from "./tokens.js";

export interface AuthServiceOptions {
  /** Session lifetime. Sliding: `lastUsedAt` advances on use, `expiresAt` does not. */
  sessionTtlMs?: number;
  /** Failed logins before a temporary lockout. */
  maxFailedLogins?: number;
  lockoutMs?: number;
  /**
   * How many projects one organization may hold — docs/26_DECISIONS.md ADR-126.
   *
   * Spend ceilings are enforced per TENANT now, so projects no longer multiply a budget. This is
   * the other half: an unbounded create loop is still a way to fill a database, and nothing in
   * the product needs thousands of projects in one organization.
   */
  maxProjectsPerOrganization?: number;
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
  private readonly maxProjectsPerOrganization: number;
  private readonly scryptParams: ScryptParams | undefined;
  private readonly decoyHash: Promise<string>;
  private readonly now: () => Date;

  constructor(
    private readonly db: DrizzleDb,
    options: AuthServiceOptions = {}
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.maxFailedLogins = options.maxFailedLogins ?? 10;
    this.lockoutMs = options.lockoutMs ?? 15 * 60 * 1000;
    this.maxProjectsPerOrganization = options.maxProjectsPerOrganization ?? 100;
    this.scryptParams = options.scryptParams;
    /**
     * The decoy is derived HERE, from the same parameters this instance hashes with — ADR-147.
     *
     * It used to be a constant pinned at the test cost while real passwords were written at
     * OWASP's, so the branch that exists to equalise work was thirty times cheaper than the one
     * it equalises against. Deriving it once at construction keeps the cost identical and off
     * the request path; the promise is awaited on every login, resolved after the first.
     */
    this.decoyHash = createDecoyHash(this.scryptParams);
    // A handler, so a failure here is never an unhandled rejection. The error itself still
    // surfaces — at the await in `login`, which then fails closed.
    void this.decoyHash.catch(() => undefined);
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
   * Emptiness is re-checked INSIDE the transaction, so it cannot promote anyone on a database
   * that already has COMMITTED users — which is the property that matters, because it is what
   * makes the two environment variables inert on every boot after the first.
   *
   * It is NOT a mutual-exclusion guarantee, and an earlier version of this comment claimed it
   * was. The check is a plain SELECT under the default READ COMMITTED isolation: two
   * transactions can both see an empty table and both insert. What actually bounds that is
   * narrower and worth stating precisely — the only caller is boot-time and HTTP-role-only, and
   * two replicas booting with the SAME `BOOTSTRAP_ADMIN_EMAIL` collide on `users_email_unique`.
   * Two replicas booting simultaneously with DIFFERENT bootstrap emails would produce two
   * administrators. That is an operator configuring two different bootstrap identities at once,
   * not an attack, and closing it properly needs an advisory lock or a serializable transaction —
   * which is a real change, deliberately not made here rather than described as already done.
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
   * Confirms a caller really knows their own password — NFR-008, ADR-102, hardened by ADR-108.
   *
   * It does not mint a session, but it IS subject to the same per-account lockout as `login`.
   * The first version deliberately skipped the lockout counter and leaned on the route's rate
   * limit instead — and that limit was keyed on `request.ip`, which comes from a client-supplied
   * `X-Forwarded-For` under the former `trustProxy: true` (ADR-112). Rotating that header gave unlimited guesses, and
   * the check ignored `lockedUntil`, so even an account `login` had locked would accept a correct
   * guess here. A correct guess deletes the account, which is precisely the stolen-cookie case this
   * check exists to stop. Being locked out of the account you are trying to delete is a far smaller
   * harm than that.
   */
  async verifyUserPassword(userId: string, password: string, meta: RequestMeta = {}): Promise<boolean> {
    const rows = await this.db
      .select({
        passwordHash: users.passwordHash,
        status: users.status,
        failedLoginCount: users.failedLoginCount,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row || row.status !== "active") return false;

    const now = this.now();
    if (row.lockedUntil && row.lockedUntil > now) {
      await this.recordAudit({
        userId,
        action: "auth.reauth",
        outcome: "denied",
        method: "session",
        detail: { reason: "locked" },
        ...meta,
      });
      throw new UnauthorizedError("This account is temporarily locked after too many failed attempts.");
    }

    const ok = await verifyPassword(password, row.passwordHash);
    if (!ok) {
      const failed = row.failedLoginCount + 1;
      await this.db
        .update(users)
        .set({
          failedLoginCount: failed,
          lockedUntil: failed >= this.maxFailedLogins ? new Date(now.getTime() + this.lockoutMs) : row.lockedUntil,
          updatedAt: now,
        })
        .where(eq(users.id, userId));
      await this.recordAudit({
        userId,
        action: "auth.reauth",
        outcome: "denied",
        method: "session",
        detail: { reason: "bad_password" },
        ...meta,
      });
      return false;
    }

    if (row.failedLoginCount > 0) {
      await this.db
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null, updatedAt: now })
        .where(eq(users.id, userId));
    }
    return true;
  }

  /**
   * Deletes the caller's account and the data they solely own — NFR-008, ADR-102.
   *
   * The audit record is written AFTER the deletion succeeds, with a null user id and a SHA-256 of the email
   * in `detail`. Writing it first — which an earlier version did, for the real reason that
   * `audit_log.user_id` is `onDelete: "set null"` and cannot name a deleted user — meant a
   * rollback left a permanent row asserting a deletion that never happened, which is the one
   * question an operator queries this row to answer.
   *
   * Returns the storage objects the caller must now remove; see `deleteUserAccount`.
   */
  async deleteOwnAccount(userId: string, meta: RequestMeta = {}): Promise<AccountDeletionResult> {
    const rows = await this.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    if (!rows[0]) throw new NotFoundError("Account not found.");

    // The deletion first, the record afterwards (ADR-107). It was the other way round, with
    // `outcome: "success"` written BEFORE the attempt, so any rollback inside the transaction
    // left a permanent audit row asserting a deletion that had not happened — the one question
    // an operator queries this row to answer. The original reason for writing first was real:
    // `audit_log.user_id` is `onDelete: "set null"`, so a row written afterwards cannot name a
    // user that no longer exists. The answer is to write it afterwards with a null user id and a hash of the email in
    // `detail` (ADR-109), which is what an operator actually needs.
    const result = await deleteUserAccount(this.db, userId);
    await this.recordAudit({
      userId: null,
      action: "auth.account_deleted",
      outcome: "success",
      method: "session",
      detail: {
        // A hash of the address, not the address (ADR-109). It still answers "was the account for
        // alice@example.com deleted, and when" — hash the address and look — without the record of
        // an erasure being the one row that retains the person's email.
        email_sha256: createHash("sha256").update(rows[0].email).digest("hex"),
        deleted_user_id: userId,
        organizations_deleted: result.deletedOrganizationIds.length,
        organizations_retained: result.retainedOrganizationIds.length,
        projects_deleted: result.deletedProjectIds.length,
        projects_retained: result.retainedProjectIds.length,
      },
      // No IP address on this row either, for the same reason; the request id still correlates it.
      requestId: meta.requestId,
    });
    return result;
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

    /**
     * Locked is decided BEFORE the password is looked at — docs/26_DECISIONS.md ADR-125.
     *
     * The order used to be the other way round, and it made the lockout a password oracle: a
     * locked account still verified every guess, answered a wrong one with "Invalid email or
     * password." and a RIGHT one with "This account is temporarily locked…". An attacker who
     * tripped the lock could then read the correct password straight off the difference, which
     * is the opposite of what a lockout is for.
     */
    const locked = Boolean(row?.lockedUntil && row.lockedUntil > now);

    // Always do the same work whether or not the account exists, and whether or not it is
    // locked: verifying against a decoy hash keeps the timing of "unknown email" and "locked"
    // close to "wrong password". Skipping the verification for a locked account would replace
    // the message oracle with a timing one.
    const decoy = await this.decoyHash;
    const encoded = locked ? decoy : (row?.passwordHash ?? decoy);
    const passwordOk = await verifyPassword(password, encoded);

    if (locked) {
      await this.recordAudit({
        userId: row?.id ?? null,
        action: "auth.login",
        outcome: "denied",
        method: "session",
        // The REASON is recorded, because an operator reading the audit trail needs to tell a
        // locked account from a wrong password. The CALLER is told neither.
        detail: { reason: "locked" },
        ...meta,
      });
      throw new UnauthorizedError(INVALID_CREDENTIALS);
    }

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
      throw new UnauthorizedError(INVALID_CREDENTIALS);
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

  /**
   * Changing one's own password — docs/26_DECISIONS.md ADR-127.
   *
   * The current password is required even though the caller already holds a session, for the
   * same reason account deletion requires it (ADR-102): a stolen cookie must not be enough to
   * take the account permanently. `verifyUserPassword` is what does that check, so this inherits
   * its lockout and its failure counting — guesses here are as limited as guesses at the door.
   *
   * Every session is revoked afterwards, INCLUDING the caller's own. That is the point of
   * changing a password after a suspected compromise: whoever else is holding a token loses it,
   * and there is no way to keep the current session without also keeping theirs, since the server
   * cannot tell which one is the honest browser.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta = {}
  ): Promise<{ revokedSessions: number }> {
    const ok = await this.verifyUserPassword(userId, currentPassword, meta);
    if (!ok) {
      // Same string the login denial uses: this endpoint must not become a place to test
      // passwords more cheaply than the front door.
      throw new UnauthorizedError(INVALID_CREDENTIALS);
    }
    if (currentPassword === newPassword) {
      throw new ValidationError("The new password must be different from the current one.");
    }

    const passwordHash = await hashPassword(newPassword, this.scryptParams);
    const now = this.now();
    await this.db
      .update(users)
      .set({ passwordHash, failedLoginCount: 0, lockedUntil: null, updatedAt: now })
      .where(eq(users.id, userId));

    const revokedSessions = await this.revokeAllSessions(userId);
    await this.recordAudit({
      userId,
      action: "auth.password_change",
      outcome: "success",
      method: "session",
      detail: { revokedSessions },
      ...meta,
    });
    return { revokedSessions };
  }

  /**
   * The caller's own live sessions, so a compromise is something they can SEE — ADR-127.
   *
   * No token and no token hash is returned: this is for recognising a session ("a browser in
   * another city, still active"), not for using one.
   */
  async listSessions(userId: string): Promise<
    Array<{ id: string; createdAt: Date; lastUsedAt: Date; expiresAt: Date; userAgent: string | null; ipAddress: string | null }>
  > {
    const now = this.now();
    return this.db
      .select({
        id: sessions.id,
        createdAt: sessions.createdAt,
        lastUsedAt: sessions.lastUsedAt,
        expiresAt: sessions.expiresAt,
        userAgent: sessions.userAgent,
        ipAddress: sessions.ipAddress,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
      .orderBy(desc(sessions.lastUsedAt));
  }

  /**
   * Revokes one of the caller's own sessions — ADR-127.
   *
   * Scoped to the user in the same statement that revokes, not checked first and revoked after:
   * a session id belonging to somebody else simply matches nothing, so there is no window and no
   * separate authorisation step to forget.
   */
  async revokeSession(userId: string, sessionId: string, meta: RequestMeta = {}): Promise<boolean> {
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: this.now() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    if (rows.length > 0) {
      await this.recordAudit({
        userId,
        action: "auth.session_revoke",
        outcome: "success",
        method: "session",
        resourceType: "session",
        resourceId: sessionId,
        ...meta,
      });
    }
    return rows.length > 0;
  }

  /** Revokes every session for a user. Called by `changePassword` (ADR-127) and account deletion. */
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
    // Membership is the ONLY route into a project (ADR-108). `isSystemAdmin` used to short-circuit
    // this into owner+admin on every project in every organization — read every tenant's data,
    // spend their quota, mint API keys bound to their projects — while SECURITY.md, ADR-096 and
    // the permission table described the flag as gating the `/admin` surface only. The branch was
    // harmless while no account could hold the flag; ADR-096 made the flag reachable, which made
    // the branch a silent cross-tenant super-user. Operating the deployment does not require
    // reading its tenants' content, so the grant is removed rather than documented.
    if (!orgRole && !projectRole) {
      // Deliberately a 404, not a 403 — see the method docstring.
      throw new NotFoundError(`Project "${projectId}" not found.`);
    }

    const permissions = resolvePermissions(orgRole, projectRole);

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

  /**
   * Each project the user can reach, with the permissions they hold ON it — ADR-148.
   *
   * The `permissions` array comes from `resolvePermissions`, the same function `authorizeProject`
   * decides real requests with, so the browser cannot hold a different idea of what a user may do
   * than the API enforces. It is returned rather than derived client-side from `role` because
   * `role` is not the whole story: an organization owner with no project membership, or with a
   * `viewer` one, is authorized through their ORG role, and a screen that read `role` alone would
   * hide controls from a user the API would have obeyed.
   */
  async listProjectsForUser(
    userId: string
  ): Promise<Array<{ id: string; name: string; organizationId: string; role: string; permissions: Permission[] }>> {
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
        permissions: resolvePermissions(
          (r.orgRole as OrgRole | null) ?? null,
          (r.projectRole as ProjectRole | null) ?? null
        ),
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
    // Organization membership only — no system-administrator bypass (ADR-108).
    if (!membership[0]) {
      throw new NotFoundError(`Organization "${organizationId}" not found.`);
    }

    /**
     * A ceiling on projects, checked inside the transaction that creates one — ADR-126.
     *
     * Quotas draw against the tenant now, so a second project buys no extra budget. What it can
     * still do is fill the database: creating projects was unbounded and cheap.
     *
     * A TRANSACTION IS NOT ENOUGH for a count-then-insert — docs/26_DECISIONS.md ADR-158. This
     * comment used to claim the shared transaction meant "two concurrent creates cannot both
     * read one under the limit and both proceed". Under READ COMMITTED, which is Postgres's
     * default and what this runs at, that is precisely what they can do: neither sees the
     * other's uncommitted row, both count N, both insert, and the organization lands at N+2
     * against a cap of N+1. The advisory lock below makes the pair genuinely exclusive without
     * an isolation-level change or a retry loop, and it is transaction-scoped, so a commit or a
     * rollback releases it and a thrown error cannot leak it.
     */
    const now = this.now();
    const id = uuid();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${organizationId}))`);
      const [existing] = await tx
        .select({ total: count() })
        .from(projects)
        .where(eq(projects.organizationId, organizationId));
      if ((existing?.total ?? 0) >= this.maxProjectsPerOrganization) {
        throw new ValidationError(
          `This organization already has the maximum of ${this.maxProjectsPerOrganization} projects.`
        );
      }
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

  /**
   * Who is in this project, and as what — docs/26_DECISIONS.md ADR-154.
   *
   * `addProjectMember` was the only member route, and the product had no caller for it, so the
   * viewer/editor/admin table `PROJECT_ROLE_PERMISSIONS` defines could not be used: every user a
   * deployment could create through its own interface was an admin of their own project, and a
   * `viewer` existed only in tests. A role that cannot be granted, inspected or revoked is not an
   * access-control system.
   *
   * `project:read`, because knowing who your collaborators are is not privileged; granting and
   * revoking are, and those two keep `project:admin`.
   */
  async listProjectMembers(
    ctx: AuthContext
  ): Promise<Array<{ userId: string; email: string; displayName: string; role: ProjectRole }>> {
    if (!ctx.projectId) throw new ValidationError("A project must be selected.");
    const rows = await this.db
      .select({
        userId: projectMembers.userId,
        email: users.email,
        displayName: users.displayName,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, ctx.projectId))
      .orderBy(users.email);
    return rows.map((r) => ({ ...r, role: r.role as ProjectRole }));
  }

  /**
   * Removing a member — ADR-154. A grant with no revocation is a one-way door: the only way to
   * take an editor's access back was a hand-written SQL statement.
   *
   * The LAST admin cannot be removed. A project whose every admin has been removed can never have
   * another one added, because adding one requires `project:admin` — so the guard is what stops a
   * project locking itself out permanently, and it refuses rather than silently keeping the row.
   */
  async removeProjectMember(ctx: AuthContext, userId: string): Promise<boolean> {
    if (!ctx.projectId) throw new ValidationError("A project must be selected.");
    const members = await this.listProjectMembers(ctx);
    const target = members.find((m) => m.userId === userId);
    if (!target) return false;
    if (target.role === "admin" && members.filter((m) => m.role === "admin").length === 1) {
      throw new ValidationError(
        "This is the project's last administrator. Add another before removing this one, or the project cannot be administered again."
      );
    }
    await this.db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, ctx.projectId), eq(projectMembers.userId, userId)));
    await this.recordAudit({
      userId: ctx.user.id,
      projectId: ctx.projectId,
      action: "project.member.remove",
      outcome: "success",
      method: ctx.method,
      resourceType: "user",
      resourceId: userId,
      detail: { role: target.role },
    });
    return true;
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
 * The ONE thing a failed login is allowed to say (ADR-125). Every denial — unknown email, wrong
 * password, disabled account, locked account — uses this exact string, so the response cannot be
 * used to learn which of those it was.
 */
const INVALID_CREDENTIALS = "Invalid email or password.";

