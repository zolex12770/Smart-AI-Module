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
    expect((deletion!.detail as { email: string }).email).toBe("alice@example.com");
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
    const detail = row.detail as { organizations_deleted: number; organizations_retained: number; email: string };
    expect(detail.organizations_deleted).toBe(1);
    expect(detail.organizations_retained).toBe(0);
    expect(detail.email).toBe("alice@example.com");
  });

});
