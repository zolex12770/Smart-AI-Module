import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DrizzleDb } from "@ai-platform/database";
import { buildTestApp, closeTestApp } from "../../test-app.js";
import type { AppContext } from "../../context.js";

/**
 * Real HTTP-layer tests for the agent task routes — `app.inject()` against a fully real
 * `buildServer()` app (real PGlite Postgres, real dispatcher, real filesystem tools), not
 * a mocked Fastify instance. Complements `packages/agent-core/src/engine.test.ts` (which
 * covers the state machine itself) by covering the actual request/response contract:
 * status codes, validation, and the approve/reject HTTP surface.
 */
describe("agent task routes", () => {
  let app: FastifyInstance;
  let db: DrizzleDb;
  let ctx: AppContext;
  /** Session cookie + CSRF pair + x-project-id for the seeded test user (ADR-049).
   * Every request in these suites is authenticated and project-scoped, because every real
   * request is — an unauthenticated inject would only ever assert a 401. */
  let auth: Awaited<ReturnType<typeof buildTestApp>>["auth"];

  beforeEach(async () => {
    ({ app, db, ctx, auth } = await buildTestApp());
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  it("POST /api/v1/agent/tasks creates a task and it completes for real", async () => {
    const createRes = await app.inject({ headers: auth.headers,
      method: "POST",
      url: "/api/v1/agent/tasks",
      payload: { taskType: "echo_chat", input: { message: "http layer test" } },
    });
    expect(createRes.statusCode).toBe(201);
    const { task } = createRes.json();
    expect(task.state).toBe("IDLE");

    await waitFor(async () => {
      const r = await app.inject({ headers: auth.headers, method: "GET", url: `/api/v1/agent/tasks/${task.id}` });
      return r.json().task.state === "COMPLETED";
    });

    const getRes = await app.inject({ headers: auth.headers, method: "GET", url: `/api/v1/agent/tasks/${task.id}` });
    const body = getRes.json();
    expect(body.task.output.content).toContain("http layer test");
    expect(body.nodes).toHaveLength(1);
  });

  it("POST /api/v1/agent/tasks rejects an invalid body with 400", async () => {
    const res = await app.inject({ headers: auth.headers, method: "POST", url: "/api/v1/agent/tasks", payload: { taskType: "not_a_real_type" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBeDefined();
  });

  it("GET /api/v1/agent/tasks/:id 404s for an unknown task", async () => {
    const res = await app.inject({ headers: auth.headers, method: "GET", url: "/api/v1/agent/tasks/00000000-0000-0000-0000-000000000000" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/v1/agent/tasks lists created tasks", async () => {
    await app.inject({ headers: auth.headers, method: "POST", url: "/api/v1/agent/tasks", payload: { taskType: "echo_chat", input: { message: "a" } } });
    await app.inject({ headers: auth.headers, method: "POST", url: "/api/v1/agent/tasks", payload: { taskType: "echo_chat", input: { message: "b" } } });
    const res = await app.inject({ headers: auth.headers, method: "GET", url: "/api/v1/agent/tasks" });
    expect(res.json().tasks.length).toBeGreaterThanOrEqual(2);
  });

  it("the full approve HTTP flow actually deletes the real file", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const filePath = path.join(ctx.sandboxRoot, "http-delete-me.txt");
    fs.writeFileSync(filePath, "bye");

    const createRes = await app.inject({ headers: auth.headers,
      method: "POST",
      url: "/api/v1/agent/tasks",
      payload: { taskType: "delete_sandbox_file", input: { path: "http-delete-me.txt" } },
    });
    const { task } = createRes.json();

    await waitFor(async () => {
      const r = await app.inject({ headers: auth.headers, method: "GET", url: `/api/v1/agent/tasks/${task.id}` });
      return r.json().task.state === "WAITING_FOR_APPROVAL";
    });

    const { nodes } = (await app.inject({ headers: auth.headers, method: "GET", url: `/api/v1/agent/tasks/${task.id}` })).json();
    expect(fs.existsSync(filePath)).toBe(true); // not touched yet

    const approveRes = await app.inject({ headers: auth.headers,
      method: "POST",
      url: `/api/v1/agent/tasks/${task.id}/approve`,
      payload: { nodeId: nodes[0].id, approvedBy: "http-test" },
    });
    expect(approveRes.statusCode).toBe(200);

    await waitFor(async () => {
      const r = await app.inject({ headers: auth.headers, method: "GET", url: `/api/v1/agent/tasks/${task.id}` });
      return r.json().task.state === "COMPLETED";
    });
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
