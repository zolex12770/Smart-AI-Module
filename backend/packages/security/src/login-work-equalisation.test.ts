import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, runMigrations, type PgliteDb } from "@ai-platform/database";
import { AuthService } from "./auth-service.js";
import type { ScryptParams } from "./password.js";

/**
 * A failed login must cost the same whatever the reason — docs/26_DECISIONS.md ADR-147.
 *
 * ADR-125 removed the lockout's MESSAGE oracle and equalised the work by verifying every guess,
 * including guesses against accounts that do not exist and accounts that are locked, so the
 * endpoint's timing would not answer what its wording refuses to. The decoy those guesses were
 * verified against was a hardcoded constant at `N=4096`, while real passwords are written at
 * OWASP's `N=131072`. The step that exists to equalise the work was thirty-two times cheaper
 * than the work it equalises against: "no such account" and "locked" were both plainly faster
 * than "wrong password", which is the oracle again, in the one channel the fix was aimed at.
 *
 * No existing test could see it. Every one of them runs at `TEST_SCRYPT_PARAMS`, whose `N` is
 * 4096 — the decoy's own value — so the two costs matched in the suite and nowhere else.
 *
 * So this file pins a THIRD cost, matching neither the test default nor the old constant, and
 * asserts on the hash the login path actually verifies against. It fails against the constant.
 */
const observed = vi.hoisted(() => ({ encoded: [] as string[] }));

vi.mock("./password.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./password.js")>();
  return {
    ...actual,
    // Wraps rather than replaces: the real scrypt still runs, and what is asserted below is the
    // argument the production code chose, not a stub's idea of it.
    verifyPassword: async (password: string, encoded: string) => {
      observed.encoded.push(encoded);
      return actual.verifyPassword(password, encoded);
    },
  };
});

/** Deliberately neither DEFAULT (2^17) nor TEST (2^12) — the constant's value must not fit. */
const PARAMS: ScryptParams = { N: 1 << 14, r: 8, p: 1 };
const PASSWORD = "a-sufficiently-long-password";

function costOf(encoded: string): number {
  const parts = encoded.split("$");
  expect(parts[0]).toBe("scrypt");
  return Number(parts[1]);
}

describe("login does the same work whether the account exists, is locked, or gave a wrong password", () => {
  let db: PgliteDb;
  let auth: AuthService;

  beforeEach(async () => {
    observed.encoded = [];
    db = await createDb(":memory:");
    await runMigrations(db);
    auth = new AuthService(db, { scryptParams: PARAMS, maxFailedLogins: 2 });
    await auth.signup({ email: "alice@example.com", password: PASSWORD, displayName: "Alice" });
  });

  afterEach(async () => {
    await db.$client.close();
  });

  const lastCost = () => costOf(observed.encoded[observed.encoded.length - 1]);

  it("verifies a real wrong password at the configured cost", async () => {
    // The baseline the other two are equalised against. If this did not hold the comparison
    // below would be meaningless, so it is asserted rather than assumed.
    observed.encoded = [];
    await expect(auth.login("alice@example.com", "wrong-password-entirely")).rejects.toThrow();
    expect(observed.encoded).toHaveLength(1);
    expect(lastCost()).toBe(PARAMS.N);
  });

  it("verifies an unknown email at that same cost", async () => {
    observed.encoded = [];
    await expect(auth.login("nobody@example.com", PASSWORD)).rejects.toThrow();
    expect(observed.encoded).toHaveLength(1);
    // The assertion the hardcoded decoy fails: it arrives here carrying N=4096.
    expect(lastCost()).toBe(PARAMS.N);
  });

  it("verifies a guess against a locked account at that same cost", async () => {
    await expect(auth.login("alice@example.com", "wrong-password-entirely")).rejects.toThrow();
    await expect(auth.login("alice@example.com", "wrong-password-entirely")).rejects.toThrow();

    observed.encoded = [];
    // Now locked. ADR-125 still verifies the guess so the lock is not visible in the timing —
    // which only works if the decoy costs what the stored hash costs.
    await expect(auth.login("alice@example.com", PASSWORD)).rejects.toThrow(/Invalid email or password/);
    expect(observed.encoded).toHaveLength(1);
    expect(lastCost()).toBe(PARAMS.N);
  });

  it("never verifies a guess against the stored hash of a locked account", async () => {
    // The decoy is not merely the same cost — it must be a DIFFERENT hash, or a correct guess
    // against a locked account would return true and the lock would leak through the audit row.
    await expect(auth.login("alice@example.com", "wrong-password-entirely")).rejects.toThrow();
    await expect(auth.login("alice@example.com", "wrong-password-entirely")).rejects.toThrow();

    observed.encoded = [];
    await expect(auth.login("alice@example.com", PASSWORD)).rejects.toThrow();
    const { verifyPassword } = await import("./password.js");
    expect(await verifyPassword(PASSWORD, observed.encoded[0])).toBe(false);
  });
});
