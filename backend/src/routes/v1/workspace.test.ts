import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * Seeding the workspace the coding agent works in — docs/26_DECISIONS.md ADR-142.
 *
 * The agent holds tools to read, write, search and run commands inside a per-project workspace,
 * and nothing could put anything into it: no route mentioned a workspace, a repo, a clone or an
 * upload-to-workspace, and the Files screen's upload writes to the asset store, which the
 * filesystem tools cannot see. So "fix the failing test" had no test to fix — the agent's first
 * action was always to discover an empty directory.
 *
 * The property that matters most here is containment. This route writes to the same directory the
 * agent's own tools are confined to, so if it were looser than they are it would be a way around
 * the boundary rather than a way into it.
 */
describe("the project workspace", () => {
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

  const write = (path: string, content: string) =>
    app.inject({ method: "POST", url: "/api/v1/workspace/files", headers: auth.headers, payload: { path, content } });

  it("accepts a file and lists it back", async () => {
    expect((await write("src/index.test.ts", "expect(1).toBe(2);")).statusCode).toBe(201);

    const listed = await app.inject({ method: "GET", url: "/api/v1/workspace/files", headers: auth.headers });
    expect(listed.statusCode).toBe(200);
    const { files } = listed.json() as { files: Array<{ path: string; sizeBytes: number }> };
    expect(files.map((f) => f.path)).toContain("src/index.test.ts");
    expect(files.find((f) => f.path === "src/index.test.ts")!.sizeBytes).toBeGreaterThan(0);
  });

  it("puts the file where the agent's own tools will find it", async () => {
    // The whole point: the same path, through the tool the agent actually uses.
    await write("notes.txt", "seeded by the operator");

    const result = await ctx.toolRegistry.call(
      "fs.read_file",
      { path: "notes.txt" },
      { projectId: auth.projectId, userId: auth.userId }
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.output)).toContain("seeded by the operator");
  });

  it("returns a file's contents for confirming what the agent will see", async () => {
    await write("a/b/c.txt", "nested content");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/workspace/file?path=a/b/c.txt",
      headers: auth.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ path: "a/b/c.txt", content: "nested content" });
  });

  it("refuses a path that escapes the workspace, without saying where it led", async () => {
    const res = await write("../../escaped.txt", "should never be written");
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const body = JSON.stringify(res.json());
    expect(body).toMatch(/outside the sandboxed root|resolves outside/i);
    // The refusal must not echo the resolved destination (ADR-088).
    expect(body).not.toMatch(/[A-Za-z]:\\\\|\/tmp\//);
  });

  it("refuses an absolute path", async () => {
    const res = await write("/etc/passwd", "no");
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("keeps one project's workspace out of another's", async () => {
    // Two tenants, one filesystem: the scope comes from the authenticated session, never the
    // request, so there is nothing here for a caller to point at somebody else's workspace.
    await write("private.txt", "tenant one's file");

    const other = await buildTestApp();
    try {
      const listed = await other.app.inject({
        method: "GET",
        url: "/api/v1/workspace/files",
        headers: other.auth.headers,
      });
      const { files } = listed.json() as { files: Array<{ path: string }> };
      expect(files.map((f) => f.path)).not.toContain("private.txt");
    } finally {
      await closeTestApp(other.app, other.db, other.ctx);
    }
  });

  it("reports an empty workspace as empty rather than as an error", async () => {
    const listed = await app.inject({ method: "GET", url: "/api/v1/workspace/files", headers: auth.headers });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { files: unknown[] }).files).toEqual([]);
  });

  it("404s for a file that is not there", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/workspace/file?path=absent.txt",
      headers: auth.headers,
    });
    expect(res.statusCode).toBe(404);
  });

  it("requires a session for every workspace route", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/workspace/files" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/workspace/file?path=a" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/workspace/files", payload: { path: "a", content: "b" } }))
        .statusCode
    ).toBe(401);
  });
});
