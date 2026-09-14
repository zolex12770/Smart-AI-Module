import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { QuotaManager } from "@ai-platform/quota";
import { PgUsageRecordRepository } from "@ai-platform/database";
import { buildTestApp, closeTestApp, TEST_PASSWORD } from "../../test-app.js";
import { generateCsrfToken } from "@ai-platform/security";
import type { AppContext } from "../../context.js";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "../../plugins/auth.js";

/**
 * `POST /api/v1/audio` and friends — docs/26_DECISIONS.md ADR-114.
 *
 * Speech was reachable only from inside the long-form video pipeline, so "generate audio" was not
 * a thing a user could ask for. These tests cover the route contract: who may ask, what is
 * refused, what is queued, what a deployment with no synthesiser answers, and that one tenant
 * cannot see another's generations.
 */
describe("audio generation routes", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;
  let auth: Awaited<ReturnType<typeof buildTestApp>>["auth"];

  beforeEach(async () => {
    ({ app, db, ctx, auth } = await buildTestApp());
    // The route contract does not depend on this machine having piper: what matters here is what
    // the route does when a provider IS configured. The worker's real synthesis is covered by
    // backend/packages/media's audio-generation integration test.
    ctx.audioGenerationAvailable = true;
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  const post = (payload: unknown, headers = auth.headers) =>
    app.inject({ method: "POST", url: "/api/v1/audio", headers, payload });

  it("records a pending generation and queues the work, without synthesising inline", async () => {
    const res = await post({ text: "Hello from the platform." });
    expect(res.statusCode).toBe(202);
    const { generation } = res.json() as { generation: { id: string; status: string; text: string } };
    expect(generation.status).toBe("pending");
    expect(generation.text).toBe("Hello from the platform.");

    // The row is real and scoped to the caller's project.
    const stored = await ctx.audioGenerations.get(auth.projectId, generation.id);
    expect(stored?.status).toBe("pending");
    expect(stored?.createdByUserId).toBe(auth.userId);

    // And the job exists, attributed so `GET /api/v1/jobs` can show it to its owner (ADR-072).
    const jobs = await ctx.jobQueue.listForProject(auth.projectId, { queue: "audio.generate" });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe("created");
  });

  it("refuses an empty or over-long text before anything is queued", async () => {
    expect((await post({ text: "" })).statusCode).toBe(400);
    expect((await post({ text: "x".repeat(5001) })).statusCode).toBe(400);
    expect((await post({})).statusCode).toBe(400);
    expect(await ctx.jobQueue.listForProject(auth.projectId, { queue: "audio.generate" })).toHaveLength(0);
  });

  it("answers a deployment with no speech provider with a capability error, not a queued job", async () => {
    ctx.audioGenerationAvailable = false;
    const res = await post({ text: "Nothing should be queued." });
    expect(res.statusCode).toBe(501);
    expect((res.json() as { error: { code: string } }).error.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(await ctx.jobQueue.listForProject(auth.projectId, { queue: "audio.generate" })).toHaveLength(0);
  });

  it("refuses an anonymous caller", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/audio", payload: { text: "hello" } });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a viewer, who may read the project but not spend in it", async () => {
    const email = `viewer-audio-${Date.now()}@example.test`;
    await ctx.auth.signup({ email, password: TEST_PASSWORD, displayName: "Viewer", organizationName: "Viewer Org" });
    const invited = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${auth.projectId}/members`,
      headers: auth.headers,
      payload: { email, role: "viewer" },
    });
    expect(invited.statusCode).toBe(201);
    const session = await ctx.auth.login(email, TEST_PASSWORD);
    const csrf = generateCsrfToken();
    const viewerHeaders = {
      cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${csrf}`,
      [CSRF_HEADER]: csrf,
      "x-project-id": auth.projectId,
    };

    const res = await post({ text: "A viewer should not be able to spend." }, viewerHeaders);
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { message: string } }).error.message).toContain("media:generate");

    // But a viewer can read what the project generated.
    expect((await app.inject({ method: "GET", url: "/api/v1/audio", headers: viewerHeaders })).statusCode).toBe(200);
  });

  it("refuses when the project's speech quota would be exceeded, before creating a row", async () => {
    // A real QuotaManager over the real ledger, with a limit small enough for one request to pass.
    ctx.quota = new QuotaManager(new PgUsageRecordRepository(db), { dailySpeechCharacterLimit: 10 });
    const res = await post({ text: "this text is far longer than ten characters" });
    expect(res.statusCode).toBe(429);
    expect((res.json() as { error: { code: string; message: string } }).error.code).toBe("QUOTA_EXCEEDED");
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/speech limit of 10 characters/);
    expect(await ctx.audioGenerations.list(auth.projectId)).toHaveLength(0);
    expect(await ctx.jobQueue.listForProject(auth.projectId, { queue: "audio.generate" })).toHaveLength(0);
  });

  it("lists and reads back a generation, and hides another tenant's", async () => {
    const created = await post({ text: "Mine." });
    const { generation } = created.json() as { generation: { id: string } };

    const list = await app.inject({ method: "GET", url: "/api/v1/audio", headers: auth.headers });
    expect((list.json() as { generations: unknown[] }).generations).toHaveLength(1);

    const read = await app.inject({ method: "GET", url: `/api/v1/audio/${generation.id}`, headers: auth.headers });
    expect(read.statusCode).toBe(200);

    // A second tenant, through the real signup path, gets 404 — not 403 — for the same id.
    const other = await ctx.auth.signup({
      email: `other-audio-${Date.now()}@example.test`,
      password: TEST_PASSWORD,
      displayName: "Other",
      organizationName: "Other Org",
    });
    const otherSession = await ctx.auth.login(other.user.email, TEST_PASSWORD);
    const csrf = generateCsrfToken();
    const otherHeaders = {
      cookie: `${SESSION_COOKIE}=${otherSession.token}; ${CSRF_COOKIE}=${csrf}`,
      [CSRF_HEADER]: csrf,
      "x-project-id": other.projectId,
    };
    const crossTenant = await app.inject({ method: "GET", url: `/api/v1/audio/${generation.id}`, headers: otherHeaders });
    expect(crossTenant.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/audio", headers: otherHeaders })).json()).toEqual({
      generations: [],
    });
  });

  it("records a cancellation request once, and reports the second as already requested", async () => {
    const created = await post({ text: "Cancel me." });
    const { generation } = created.json() as { generation: { id: string } };

    const first = await app.inject({ method: "POST", url: `/api/v1/audio/${generation.id}/cancel`, headers: auth.headers });
    expect(first.json()).toEqual({ ok: true, alreadyRequested: false });
    const second = await app.inject({ method: "POST", url: `/api/v1/audio/${generation.id}/cancel`, headers: auth.headers });
    expect(second.json()).toEqual({ ok: true, alreadyRequested: true });

    const stored = await ctx.audioGenerations.get(auth.projectId, generation.id);
    expect(stored?.cancelRequestedAt).toBeInstanceOf(Date);
    // The row is NOT claimed cancelled by the route — the worker settles it (docs/07 §1.5).
    expect(stored?.status).toBe("pending");
  });

  it("404s a cancel for an id in another project", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/audio/7d8f3c2e-1b4a-4c6d-9e8f-0a1b2c3d4e5f/cancel",
      headers: auth.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});
