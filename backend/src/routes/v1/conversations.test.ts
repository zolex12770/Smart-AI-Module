import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { buildTestApp, closeTestApp, joinProjectAs } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * Conversations a person can name and remove — audit finding 18. Every conversation was titled
 * by its UUID prefix, forever, and none could be deleted.
 */
describe("conversation titles, rename and delete", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;
  let auth: Awaited<ReturnType<typeof buildTestApp>>["auth"];

  beforeEach(async () => {
    ({ app, db, ctx, auth } = await buildTestApp());
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  const startChat = async (content: string) => {
    const res = await app.inject({ method: "POST", url: "/api/v1/chat", headers: auth.headers, payload: { messages: [{ role: "user", content }] } });
    expect(res.statusCode).toBe(200);
    return res.headers["x-conversation-id"] as string;
  };
  const list = async (headers = auth.headers) =>
    ((await app.inject({ method: "GET", url: "/api/v1/conversations", headers })).json() as {
      conversations: Array<{ id: string; title: string | null }>;
    }).conversations;

  it("titles a new conversation by what the user asked, cut at a word", async () => {
    const short = await startChat("How deep is the harbour?");
    const long = await startChat(
      "Please write a detailed maintenance schedule for the lighthouse lens, the fog signal and the keeper's cottage roof"
    );
    const rows = await list();
    expect(rows.find((c) => c.id === short)?.title).toBe("How deep is the harbour?");
    const title = rows.find((c) => c.id === long)?.title ?? "";
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title).toMatch(/^Please write a detailed maintenance schedule for the/);
  });

  it("renames and deletes, and a viewer can do neither", async () => {
    const id = await startChat("hello");
    const viewer = await joinProjectAs(app, ctx, auth.headers, auth.projectId, "viewer");
    const patchAs = (headers: Record<string, string>, title: string) =>
      app.inject({ method: "PATCH", url: `/api/v1/conversations/${id}`, headers, payload: { title } });

    expect((await patchAs(viewer.headers, "Mine now")).statusCode).toBe(403);
    expect((await patchAs(auth.headers, "   ")).statusCode).toBe(400);
    expect((await patchAs(auth.headers, "Harbour questions")).statusCode).toBe(200);
    expect((await list()).find((c) => c.id === id)?.title).toBe("Harbour questions");

    expect((await app.inject({ method: "DELETE", url: `/api/v1/conversations/${id}`, headers: viewer.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/conversations/${id}`, headers: auth.headers })).statusCode).toBe(200);
    expect((await list()).some((c) => c.id === id)).toBe(false);
    expect((await app.inject({ method: "GET", url: `/api/v1/conversations/${id}/messages`, headers: auth.headers })).statusCode).toBe(404);
    // Deleting again is the same 404 as another project's id.
    expect((await app.inject({ method: "DELETE", url: `/api/v1/conversations/${id}`, headers: auth.headers })).statusCode).toBe(404);
  });
});
