import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PgliteDb } from "@ai-platform/database";
import { buildTestApp, closeTestApp } from "../test-app.js";
import type { AppContext } from "../context.js";

/**
 * Request ids are globally unique — docs/26_DECISIONS.md ADR-098.
 *
 * Fastify's default generator restarts at `req-1` in every process. `request.id` is not only a
 * log tag in this application: it is written to audit records, propagated into job payloads, and
 * used as the usage-ledger idempotency key for a RAG query — the one spending path with no
 * persisted row to key off. So two replicas, or one process after a restart, produced the SAME
 * key for different requests, and a collision on that unique index silently drops the charge
 * rather than double-charging it.
 *
 * A UUID is asserted here rather than merely "unique within this run", because uniqueness within
 * one process is exactly the property the broken version already had.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("request ids", () => {
  let app: FastifyInstance;
  let db: PgliteDb;
  let ctx: AppContext;

  beforeEach(async () => {
    ({ app, db, ctx } = await buildTestApp());
  });

  afterEach(async () => {
    await closeTestApp(app, db, ctx);
  });

  it("are UUIDs, so they cannot collide across processes or restarts", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      // An unauthenticated request to a real route: the error body carries the request id.
      const res = await app.inject({ method: "GET", url: "/api/v1/usage" });
      const body = res.json() as { error: { requestId: string } };
      expect(body.error.requestId).toMatch(UUID_V4);
      seen.add(body.error.requestId);
    }
    expect(seen.size).toBe(5);
  });

  it("the id in an error response is the SAME id the request carries internally", async () => {
    // The error handler used to mint its own UUID, so the id handed to a caller matched nothing
    // an operator could grep for in the logs.
    let internal: string | undefined;
    app.addHook("onRequest", async (request) => {
      if (request.url === "/api/v1/usage") internal = request.id;
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/v1/usage" });
    const body = res.json() as { error: { requestId: string } };
    expect(body.error.requestId).toBe(internal);
  });
});
