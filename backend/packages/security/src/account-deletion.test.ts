import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  auditLog,
  assets,
  conversations,
  createDb,
  documents,
  messages,
  organizationMembers,
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

  it("does NOT destroy an organization that has another member — that content is not theirs", async () => {
    const { user: alice, projectId: aliceProject } = await signup("alice@example.com");
    const { user: bob } = await signup("bob@example.com");
    await seedContent(aliceProject, alice.id, "shared");

    // Bob joins Alice's organization and project.
    const now = new Date();
    const [org] = await db.select().from(organizations).limit(1);
    await db.insert(organizationMembers).values({
      id: "om-bob",
      organizationId: org.id,
      userId: bob.id,
      role: "member",
      createdAt: now,
    });
    await db.insert(projectMembers).values({
      id: "pm-bob",
      projectId: aliceProject,
      userId: bob.id,
      role: "editor",
      createdAt: now,
    });

    const result = await auth.deleteOwnAccount(alice.id);

    expect(result.deletedOrganizationIds).toEqual([]);
    expect(result.retainedOrganizationIds).toEqual([org.id]);
    // Bob's project and its content survive.
    expect(await db.select().from(projects).where(eq(projects.id, aliceProject))).toHaveLength(1);
    expect(await db.select().from(messages)).toHaveLength(1);
    // Alice is gone, her memberships with her, and the surviving rows keep a null author.
    expect(await db.select().from(users).where(eq(users.id, alice.id))).toEqual([]);
    expect(await db.select().from(organizationMembers).where(eq(organizationMembers.userId, alice.id))).toEqual([]);
    const [conv] = await db.select().from(conversations);
    expect(conv.createdByUserId).toBeNull();
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
});
