import { afterEach, describe, expect, it } from "vitest";
import { auditLog, users } from "@ai-platform/database";
import { and, eq } from "drizzle-orm";
import { buildTestApp, closeTestApp } from "./test-app.js";

/**
 * Whose address `request.ip` is — docs/26_DECISIONS.md ADR-112.
 *
 * It feeds every per-IP rate limit and every audit row. The server used `trustProxy: true`, which
 * takes the LEFTMOST X-Forwarded-For entry — the one the client writes — so any caller could name
 * its own address, rotate it per request, and never meet a per-IP limit, while the audit trail
 * recorded whatever it claimed. Observed here through the audit row a failed login writes, which
 * is where an operator would look.
 */
const CLIENT_WRITTEN = "198.51.100.7";

describe("TRUST_PROXY_HOPS", () => {
  const previous = process.env.TRUST_PROXY_HOPS;

  afterEach(() => {
    if (previous === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = previous;
  });

  /** The address recorded for a failed login arriving from `remoteAddress` with `forwardedFor`. */
  async function recordedAddress(hops: string | undefined, remoteAddress: string, forwardedFor: string) {
    if (hops === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = hops;

    const { app, db, ctx, auth } = await buildTestApp();
    try {
      const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, auth.userId));
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress,
        headers: { "x-forwarded-for": forwardedFor },
        payload: { email: user.email, password: "not-the-password-at-all" },
      });
      expect(res.statusCode).toBe(401);

      const rows = await db
        .select({ ip: auditLog.ipAddress })
        .from(auditLog)
        .where(and(eq(auditLog.userId, auth.userId), eq(auditLog.action, "auth.login")));
      // The harness's own login carries no address; the failed one above is the only one that does.
      return rows.map((r) => r.ip).filter((ip): ip is string => ip !== null);
    } finally {
      await closeTestApp(app, db, ctx);
    }
  }

  it("ignores X-Forwarded-For by default and records the connection's own address", async () => {
    expect(await recordedAddress(undefined, "10.0.0.5", CLIENT_WRITTEN)).toEqual(["10.0.0.5"]);
  });

  it("behind one proxy, records the entry that proxy appended — never the one the client wrote", async () => {
    expect(await recordedAddress("1", "10.0.0.5", `${CLIENT_WRITTEN}, 203.0.113.9`)).toEqual(["203.0.113.9"]);
  });

  it("behind two proxies, skips exactly the two entries they appended", async () => {
    expect(await recordedAddress("2", "10.0.0.5", `${CLIENT_WRITTEN}, 203.0.113.9, 192.0.2.44`)).toEqual([
      "203.0.113.9",
    ]);
  });
});
