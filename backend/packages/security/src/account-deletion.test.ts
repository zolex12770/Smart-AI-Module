import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  auditLog,
  assets,
  conversations,
  createDb,
  documents,
  messages,
  organizations,
  projectMembers,
  projects,
  runMigrations,
  users,
  type PgliteDb,
} from "@ai-platform/database";
import { eq } from "drizzle-orm";
import { AuthService } from "./auth-service.js";
import { TEST_SCRYPT_PARAMS } from "./password.js";

/**
 * Account and data deletion — NFR-008, docs/26_DECISIONS.md ADR-102.
 *
 * NFR-008 is a P1 privacy requirement and there was no way to satisfy it: no route, no CLI, no
 * repository call, and no way even to suspend an account. It was also not achievable by deleting
 * the user row, which is the reason this is tested against a REAL database rather than asserted
 * from the schema: `conversations`, `documents`, `tasks` and `usage_records` all carry
 * `createdByUserId` with `onDelete: "set null"`, so deleting the user leaves every message and
 * document in place with a null author. Only the organization cascade actually removes content,
 * and only a real cascade can prove it did.
 */
describe("deleting an account", () => {
  let db: PgliteDb;
  let auth: AuthService;

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    auth = new AuthService(db, { scryptParams: TEST_SCRYPT_PARAMS });
  });

  afterEach(async () => {
    await db.$client.close();
  });

  const PASSWORD = "a-sufficiently-long-password";
  const signup = (email: string) => auth.signup({ email, password: PASSWORD, displayName: email.split("@")[0] });

  /** Real content in a project: a conversation, a message and an asset. */
  const seedContent = async (projectId: string, userId: string, marker: string) => {
    const now = new Date();
    await db.insert(conversations).values({
      id: `conv-${marker}`,
      projectId,
      createdByUserId: userId,
      title: marker,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(messages).values({
      id: `msg-${marker}`,
      conversationId: `conv-${marker}`,
      role: "user",
      content: `secret content ${marker}`,
      createdAt: now,
    });
    await db.insert(assets).values({
      id: `asset-${marker}`,
      projectId,
      kind: "image",
      mimeType: "image/png",
      sizeBytes: 3,
      storagePath: `/tmp/${marker}.png`,
      checksum: "abc",
      createdAt: now,
    });
    await db.insert(documents).values({
      id: `doc-${marker}`,
      projectId,
      uploadedByUserId: userId,
      filename: `${marker}.txt`,
      status: "ready",
      scanStatus: "clean",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  };

  it("removes the user, their organization, their project and all of its content", async () => {
    const { user, projectId } = await signup("alice@example.com");
    await seedContent(projectId, user.id, "alice");

    const result = await auth.deleteOwnAccount(user.id);

    expect(result.deletedProjectIds).toEqual([projectId]);
    expect(result.deletedOrganizationIds).toHaveLength(1);
    expect(await db.select().from(users).where(eq(users.id, user.id))).toEqual([]);
    expect(await db.select().from(projects).where(eq(projects.id, projectId))).toEqual([]);
    // The content, not just the parent rows — this is the requirement's actual wording.
    expect(await db.select().from(conversations)).toEqual([]);
    expect(await db.select().from(messages)).toEqual([]);
    expect(await db.select().from(documents)).toEqual([]);
    expect(await db.select().from(assets)).toEqual([]);
    expect(await db.select().from(organizations)).toEqual([]);
  });

  it("reports the storage objects the caller must delete, rather than leaving them unknown", async () => {
    const { user, projectId } = await signup("alice@example.com");
    await seedContent(projectId, user.id, "alice");

    const result = await auth.deleteOwnAccount(user.id);
    expect(result.assets).toEqual([{ id: "asset-alice", projectId, storagePath: "/tmp/alice.png" }]);
  });

  it("ends the session immediately — the credential cannot outlive the account", async () => {
    const { user } = await signup("alice@example.com");
    const { token } = await auth.login("alice@example.com", PASSWORD);
    expect(await auth.authenticate({ kind: "session", token })).not.toBeNull();

    await auth.deleteOwnAccount(user.id);
    expect(await auth.authenticate({ kind: "session", token })).toBeNull();
  });

  it("does NOT destroy an organization whose project has a COLLABORATOR — via the real invite path", async () => {
    // The API's only way to add a collaborator, `addProjectMember`, writes a `projectMembers`
    // row and NO `organizationMembers` row — and `authorizeProject` grants full project
    // permissions from that row alone. So this test deliberately goes through the service rather
    // than inserting membership rows by hand. The previous version of it inserted an
    // `organizationMembers` row the API never writes, which is exactly why it passed while the
    // code cascade-deleted a colleague's project and every message in it.
    const { user: alice, projectId } = await signup("alice@example.com");
    const { user: bob } = await signup("bob@example.com");
    await seedContent(projectId, alice.id, "shared");

    const aliceCtx = await auth.authorizeProject(alice, projectId, "session", "cred-alice");
    await auth.addProjectMember(aliceCtx, "bob@example.com", "editor");

    const result = await auth.deleteOwnAccount(alice.id);

    const [org] = await db.select().from(organizations);
    expect(result.deletedOrganizationIds).toEqual([]);
    expect(result.retainedOrganizationIds).toEqual([org.id]);
    // Bob's project and its content survive.
    expect(await db.select().from(projects).where(eq(projects.id, projectId))).toHaveLength(1);
    expect(await db.select().from(messages)).toHaveLength(1);
    // Alice is gone, her memberships with her, and the surviving rows keep a null author.
    expect(await db.select().from(users).where(eq(users.id, alice.id))).toEqual([]);
    expect(await db.select().from(projectMembers).where(eq(projectMembers.userId, alice.id))).toEqual([]);
    const [conv] = await db.select().from(conversations);
    expect(conv.createdByUserId).toBeNull();
    // And Bob can still reach the project he was invited to.
    const bobCtx = await auth.authorizeProject(bob, projectId, "session", "cred-bob");
    expect(bobCtx.projectId).toBe(projectId);
  });

  it("still destroys an organization whose only other membership row is the departing user's own", async () => {
    // The other direction: a solo account must not be retained by its own rows.
    const { user, projectId } = await signup("solo@example.com");
    await seedContent(projectId, user.id, "solo");
    const result = await auth.deleteOwnAccount(user.id);
    expect(result.deletedOrganizationIds).toHaveLength(1);
    expect(await db.select().from(projects)).toEqual([]);
    expect(await db.select().from(messages)).toEqual([]);
  });


  it("leaves an audit record that survives the account it describes", async () => {
    const { user } = await signup("alice@example.com");
    await auth.deleteOwnAccount(user.id);
    // Written before the deletion, because audit_log.user_id is `set null`: afterwards the
    // foreign key would reject it, and a deletion that erases its own record is not an audit.
    const rows = await db.select().from(auditLog);
    const deletion = rows.find((r) => r.action === "auth.account_deleted");
    expect(deletion).toBeDefined();
    expect(deletion!.userId).toBeNull();
    const expectedHash = createHash("sha256").update("alice@example.com").digest("hex");
    expect((deletion!.detail as { email_sha256: string }).email_sha256).toBe(expectedHash);
    // The erasure record must not itself be the row that keeps the address (ADR-109).
    expect(JSON.stringify(deletion!.detail)).not.toContain("alice@example.com");
  });

  it("refuses a password that is not the caller's", async () => {
    const { user } = await signup("alice@example.com");
    expect(await auth.verifyUserPassword(user.id, "not-the-password")).toBe(false);
    expect(await auth.verifyUserPassword(user.id, PASSWORD)).toBe(true);
  });

  it("is not silently idempotent — deleting a gone account is an error, not a success", async () => {
    const { user } = await signup("alice@example.com");
    await auth.deleteOwnAccount(user.id);
    await expect(auth.deleteOwnAccount(user.id)).rejects.toThrow();
  });

  it("writes no 'deleted' audit record when the deletion does not happen", async () => {
    // The record used to be written BEFORE the attempt with outcome "success", so a failure left a
    // permanent row asserting a deletion that had not occurred — the one thing this row is
    // queried to answer. A non-existent user is the reachable failure: it must produce no record.
    const before = await db.select().from(auditLog);
    await expect(auth.deleteOwnAccount("no-such-user")).rejects.toThrow();
    const after = await db.select().from(auditLog);
    expect(after.filter((r) => r.action === "auth.account_deleted")).toEqual([]);
    expect(after).toHaveLength(before.length);
  });

  it("records what was actually destroyed, not merely that something was", async () => {
    const { user, projectId } = await signup("alice@example.com");
    await seedContent(projectId, user.id, "alice");
    await auth.deleteOwnAccount(user.id);
    const [row] = (await db.select().from(auditLog)).filter((r) => r.action === "auth.account_deleted");
    const detail = row.detail as { organizations_deleted: number; organizations_retained: number; email_sha256: string };
    expect(detail.organizations_deleted).toBe(1);
    expect(detail.organizations_retained).toBe(0);
    expect(detail.email_sha256).toBe(createHash("sha256").update("alice@example.com").digest("hex"));
  });


  it("deletes a PRIVATE project even when another project in the same organization has a collaborator (ADR-109)", async () => {
    // ADR-107 judged the organization as a unit: one collaborator on ANY project kept the whole
    // organization, including a private project only the departing user could reach.
    const { user: alice, projectId: sharedProject } = await signup("alice@example.com");
    const aliceOrg = await auth.primaryOrganizationId(alice.id);
    const { id: privateProject } = await auth.createProject(alice, aliceOrg!, "private");
    await seedContent(privateProject, alice.id, "diary");
    await signup("bob@example.com");
    const aliceCtx = await auth.authorizeProject(alice, sharedProject, "session", "cred-alice");
    await auth.addProjectMember(aliceCtx, "bob@example.com", "viewer");

    const result = await auth.deleteOwnAccount(alice.id);

    expect(result.deletedProjectIds).toEqual([privateProject]);
    expect(result.retainedProjectIds).toEqual([sharedProject]);
    expect(result.assets.map((a) => a.id)).toEqual(["asset-diary"]);
    expect(await db.select().from(projects).where(eq(projects.id, privateProject))).toEqual([]);
    expect(await db.select().from(projects).where(eq(projects.id, sharedProject))).toHaveLength(1);
    expect((await db.select().from(messages)).map((m) => m.content)).not.toContain("secret content diary");
  });

  it("removes the organization when its LAST collaborator later deletes their account too (ADR-109)", async () => {
    // A deletes first: the project Bob works on is kept. Then Bob deletes. ADR-107 only ever looked
    // at organizations from the deleter's organization_members rows, so Bob's deletion never
    // considered A's organization and its content outlived everyone who could reach it.
    const { user: alice, projectId } = await signup("alice@example.com");
    await seedContent(projectId, alice.id, "shared");
    const { user: bob } = await signup("bob@example.com");
    const aliceCtx = await auth.authorizeProject(alice, projectId, "session", "cred-alice");
    await auth.addProjectMember(aliceCtx, "bob@example.com", "editor");

    await auth.deleteOwnAccount(alice.id);
    expect(await db.select().from(projects).where(eq(projects.id, projectId))).toHaveLength(1);

    await auth.deleteOwnAccount(bob.id);
    expect(await db.select().from(organizations)).toEqual([]);
    expect(await db.select().from(projects)).toEqual([]);
    expect(await db.select().from(messages)).toEqual([]);
  });

  it("scrubs the IP and email from every audit row the person left behind (ADR-109)", async () => {
    const { user } = await signup("alice@example.com");
    await expect(auth.login("alice@example.com", "wrong-password-entirely", { ipAddress: "203.0.113.77" })).rejects.toThrow();
    await auth.login("alice@example.com", PASSWORD, { ipAddress: "198.51.100.42" });

    await auth.deleteOwnAccount(user.id, { ipAddress: "203.0.113.200", requestId: "req-del" });

    const rows = await db.select().from(auditLog);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.ipAddress, row.action).toBeNull();
      expect(JSON.stringify(row.detail ?? {}), row.action).not.toContain("alice@example.com");
    }
  });

  it("writes no deletion record when the deletion itself fails inside its transaction (ADR-109)", async () => {
    // The not-found test cannot tell audit-first from audit-after: both throw before either write.
    // This forces a failure AFTER the lookup, inside deleteUserAccount's transaction, which is the
    // only case in which writing the success row first would leave a false record.
    const { user } = await signup("alice@example.com");
    await db.$client.exec(`
      CREATE FUNCTION refuse_user_delete() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'simulated failure during account deletion'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_user_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION refuse_user_delete();
    `);

    // Drizzle wraps the database error ("Failed query: ...") and keeps the original as `cause`,
    // so the assertion follows the chain rather than matching the wrapper's text.
    const failure = await auth.deleteOwnAccount(user.id).then(
      () => null,
      (err: Error & { cause?: unknown }) => err
    );
    expect(failure).not.toBeNull();
    expect(String((failure!.cause as Error | undefined)?.message ?? failure!.message)).toMatch(/simulated failure/);
    expect(await db.select().from(users).where(eq(users.id, user.id))).toHaveLength(1);
    const records = (await db.select().from(auditLog)).filter((r) => r.action === "auth.account_deleted");
    expect(records).toEqual([]);
  });
});
