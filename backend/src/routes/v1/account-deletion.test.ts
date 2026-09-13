import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { assets, conversations, messages, users, type PgliteDb } from "@ai-platform/database";
import { eq } from "drizzle-orm";
import { TEST_PASSWORD, buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * `DELETE /api/v1/auth/account` — NFR-008, docs/26_DECISIONS.md ADR-102.
 *
 * Exercised through the real app because the requirement's hard part is at this layer: the
 * storage objects. The database rows cascade away inside a transaction, so the files are removed
 * AFTER the commit, from the paths the deletion returns — and "reports success while leaving a
 * tenant's files on disk" is the one failure mode of a deletion endpoint that actually matters.
 */
describe("DELETE /api/v1/auth/account", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;
  let auth: Awaited<ReturnType<typeof buildTestApp>>["auth"];

  const PASSWORD = TEST_PASSWORD;

  beforeEach(async () => {
    ({ app, db, ctx, auth } = await buildTestApp());
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  /** A real file on disk, and the `assets` row that points at it. */
  const seedAssetWithFile = async (): Promise<string> => {
    const dir = ctx.assetsRoot;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, "deletion-fixture.png");
    writeFileSync(path, Buffer.from([1, 2, 3]));
    const now = new Date();
    await db.insert(assets).values({
      id: "asset-del",
      projectId: auth.projectId,
      kind: "image",
      mimeType: "image/png",
      sizeBytes: 3,
      storagePath: path,
      checksum: "abc",
      createdAt: now,
    });
    await db.insert(conversations).values({
      id: "conv-del",
      projectId: auth.projectId,
      createdByUserId: auth.userId,
      title: "to be deleted",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(messages).values({
      id: "msg-del",
      conversationId: "conv-del",
      role: "user",
      content: "private content",
      createdAt: now,
    });
    return path;
  };

  it("deletes the account, its content, and the real file on disk", async () => {
    const path = await seedAssetWithFile();
    expect(existsSync(path)).toBe(true);

    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/account",
      headers: auth.headers,
      payload: { password: PASSWORD, confirm: "DELETE MY ACCOUNT" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { deleted: { projects: number; storageObjects: number }; storageObjectsNotRemoved: string[] };
    expect(body.deleted.projects).toBe(1);
    expect(body.deleted.storageObjects).toBe(1);
    expect(body.storageObjectsNotRemoved).toEqual([]);

    // The bytes, not only the rows.
    expect(existsSync(path)).toBe(false);
    expect(await db.select().from(users).where(eq(users.id, auth.userId))).toEqual([]);
    expect(await db.select().from(messages)).toEqual([]);
  });

  it("refuses without the correct password, and deletes nothing", async () => {
    await seedAssetWithFile();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/account",
      headers: auth.headers,
      payload: { password: "wrong-password-entirely", confirm: "DELETE MY ACCOUNT" },
    });
    expect(res.statusCode).toBe(401);
    expect(await db.select().from(users).where(eq(users.id, auth.userId))).toHaveLength(1);
    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it("refuses without the typed confirmation", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/account",
      headers: auth.headers,
      payload: { password: PASSWORD, confirm: "yes" },
    });
    expect(res.statusCode).toBe(400);
    expect(await db.select().from(users).where(eq(users.id, auth.userId))).toHaveLength(1);
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/account",
      payload: { password: PASSWORD, confirm: "DELETE MY ACCOUNT" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a cookie-authenticated request with no CSRF token", async () => {
    const { "x-csrf-token": _omitted, ...withoutCsrf } = auth.headers;
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/account",
      headers: withoutCsrf,
      payload: { password: PASSWORD, confirm: "DELETE MY ACCOUNT" },
    });
    expect(res.statusCode).toBe(403);
    expect(await db.select().from(users).where(eq(users.id, auth.userId))).toHaveLength(1);
  });

  it("refuses an API key: deletion requires an interactive session (ADR-108)", async () => {
    // Before the fix a bearer key plus the password deleted the account: requireUser accepts any
    // credential, and a bearer request is exempt from CSRF.
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/api-keys",
      headers: auth.headers,
      payload: { name: "automation", projectId: auth.projectId },
    });
    expect(created.statusCode).toBe(201);
    const key = (created.json() as { key: string }).key;

    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/account",
      headers: { authorization: `Bearer ${key}`, "x-project-id": auth.projectId },
      payload: { password: PASSWORD, confirm: "DELETE MY ACCOUNT" },
    });
    expect(res.statusCode).toBe(403);
    expect(await db.select().from(users).where(eq(users.id, auth.userId))).toHaveLength(1);
  });

  it("rate-limits password guesses per USER, so rotating X-Forwarded-For does not help (ADR-108)", async () => {
    // The limit was keyed on request.ip, which under trustProxy comes from X-Forwarded-For: twelve
    // guesses with a different header each time all returned 401 and none returned 429.
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/v1/auth/account",
        headers: { ...auth.headers, "x-forwarded-for": `203.0.113.${i + 1}` },
        payload: { password: "wrong-password-entirely", confirm: "DELETE MY ACCOUNT" },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    expect(await db.select().from(users).where(eq(users.id, auth.userId))).toHaveLength(1);
  });

  it("removes the deleted project's agent workspace from disk (ADR-109)", async () => {
    // Before the fix the route removed only asset objects: a file written into
    // SANDBOX_ROOT/<projectId> by the agent survived with the project row gone and a 200 response
    // that reported nothing left behind.
    const workspace = join(ctx.sandboxRoot, auth.projectId);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "agent-written-secret.txt"), "private");

    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/account",
      headers: auth.headers,
      payload: { password: PASSWORD, confirm: "DELETE MY ACCOUNT" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { deleted: { workspaces: number }; workspacesNotRemoved: string[] };
    expect(body.workspacesNotRemoved).toEqual([]);
    expect(body.deleted.workspaces).toBe(1);
    expect(existsSync(workspace)).toBe(false);
  });
  it("cancels the deleted project's queued jobs, so no provider is called for an account that no longer exists (ADR-109)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/images",
      headers: auth.headers,
      payload: { prompt: "a render still waiting in the queue" },
    });
    expect(created.statusCode).toBe(202);
    const [queued] = await ctx.jobQueue.listForProject(auth.projectId, { queue: "image.generate" });
    expect(queued.state).toBe("created");

    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/account",
      headers: auth.headers,
      payload: { password: PASSWORD, confirm: "DELETE MY ACCOUNT" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted.queuedJobs).toBe(1);

    const [after] = await ctx.jobQueue.listForProject(auth.projectId, { queue: "image.generate" });
    expect(after.state).toBe("cancelled");
  });
});
