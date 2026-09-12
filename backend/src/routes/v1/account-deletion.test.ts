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
});
