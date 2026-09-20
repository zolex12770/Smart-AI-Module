import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auditLog, type PgliteDb } from "@ai-platform/database";
import { eq } from "drizzle-orm";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * The audit row really reaches the table — docs/26_DECISIONS.md ADR-139.
 *
 * The registry tests prove the sink is called on every path. This proves the other half: that
 * what the composition root does with it produces a row an auditor can query, with the tenant,
 * the tool, the outcome and the arguments on it. A sink that is called and writes nothing would
 * pass the first set of tests and satisfy nobody asking what a tool did last month.
 */
describe("a tool call leaves a row in audit_log", () => {
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

  const toolRows = async () => db.select().from(auditLog).where(eq(auditLog.action, "tool.call"));

  /** Waits for the fire-and-forget write, which is deliberately not awaited by the call path. */
  async function waitForRows(atLeast: number): Promise<Array<Record<string, unknown>>> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const rows = await toolRows();
      if (rows.length >= atLeast) return rows as Array<Record<string, unknown>>;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return (await toolRows()) as Array<Record<string, unknown>>;
  }

  it("writes the tenant, the tool, the outcome and the arguments", async () => {
    // A real tool call through the real registry: write a file inside the project workspace.
    const result = await ctx.toolRegistry.call(
      "fs.write_file",
      { path: "audited.txt", content: "hello" },
      { projectId: auth.projectId, userId: auth.userId }
    );
    expect(result.ok).toBe(true);

    const rows = await waitForRows(1);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.projectId).toBe(auth.projectId);
    expect(row.resourceType).toBe("tool");
    expect(row.resourceId).toBe("fs.write_file");
    expect(row.outcome).toBe("success");
    const detail = row.detail as { outcome?: string; arguments?: Record<string, unknown>; durationMs?: number };
    expect(detail.outcome).toBe("ok");
    // What it was asked to do, which is the question the trail exists to answer.
    expect(detail.arguments).toMatchObject({ path: "audited.txt" });
    expect(typeof detail.durationMs).toBe("number");
  });

  it("records a refused call as a refusal rather than not at all", async () => {
    // A path outside the workspace is refused by containment (ADR-088/ADR-125). The attempt is
    // exactly what an audit trail must keep.
    const result = await ctx.toolRegistry.call(
      "fs.read_file",
      { path: "../../../etc/passwd" },
      { projectId: auth.projectId, userId: auth.userId }
    );
    expect(result.ok).toBe(false);

    const rows = await waitForRows(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("failure");
    expect(rows[0]!.resourceId).toBe("fs.read_file");
  });

  it("keeps one row per call", async () => {
    const scope = { projectId: auth.projectId, userId: auth.userId };
    await ctx.toolRegistry.call("fs.write_file", { path: "one.txt", content: "1" }, scope);
    await ctx.toolRegistry.call("fs.write_file", { path: "two.txt", content: "2" }, scope);

    const rows = await waitForRows(2);
    expect(rows).toHaveLength(2);
    const paths = rows.map((r) => (r.detail as { arguments?: { path?: string } }).arguments?.path).sort();
    expect(paths).toEqual(["one.txt", "two.txt"]);
  });

  it("truncates a long argument in the stored row, and says it did", async () => {
    /**
     * `truncateForAudit` was unexercised — docs/26_DECISIONS.md ADR-152.
     *
     * The sink lived inline in the composition root and the harness kept a hand-written copy
     * that had drifted: no truncation, no `serverId`, no `error`. So this file, which is the one
     * named for ADR-139, was asserting the COPY's shape, and a repo-wide grep for
     * `truncateForAudit` returned two lines, both inside `index.ts`. Both now import one factory,
     * and this asserts on the bytes that reach the column.
     */
    const long = "x".repeat(2_000);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workspace/files",
      headers: auth.headers,
      payload: { path: "long.txt", content: long },
    });
    expect(res.statusCode).toBeLessThan(300);

    const tool = await ctx.toolRegistry.call(
      "fs.write_file",
      { path: "long.txt", content: long },
      { projectId: auth.projectId, userId: auth.userId }
    );
    expect(tool.ok).toBe(true);

    const rows = await waitForRows(1);
    const detail = rows[rows.length - 1].detail as { arguments: Record<string, unknown> };
    const stored = String(detail.arguments.content);
    // Bounded, and honest about being bounded: a trail that quietly drops data is worse than
    // one that says it did.
    expect(stored.length).toBeLessThan(long.length);
    expect(stored).toMatch(/… \(2000 characters\)$/);
    // And the argument that was short enough is stored whole.
    expect(detail.arguments.path).toBe("long.txt");
  });
});
