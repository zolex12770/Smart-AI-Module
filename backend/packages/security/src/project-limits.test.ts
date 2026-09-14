import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { v4 as uuid } from "uuid";
import { createDb, projects, runMigrations, type PgliteDb } from "@ai-platform/database";
import { AuthService } from "./auth-service.js";
import { ValidationError } from "@ai-platform/shared";

/**
 * A ceiling on projects — docs/26_DECISIONS.md ADR-126.
 *
 * Spend limits were enforced per project and any authenticated user can create projects, so every
 * configured ceiling could be multiplied by pressing a button. ADR-126 moves the budget to the
 * tenant, which removes the incentive; this is the other half, because an unbounded create loop is
 * still a way to fill a database with rows nothing will ever read.
 */
const TEST_SCRYPT_PARAMS = { N: 2, r: 1, p: 1 } as const;

describe("projects per organization", () => {
  let db: PgliteDb;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "project-limits-"));
    db = await createDb(":memory:");
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows may briefly hold a handle */
    }
  });

  const signup = async (auth: AuthService) =>
    auth.signup({ email: "alice@example.com", password: "a-sufficiently-long-password", displayName: "Alice" });

  it("refuses to create more projects than the organization may hold", async () => {
    // Signup already creates one project, so a cap of 3 leaves room for two more.
    const auth = new AuthService(db, { scryptParams: TEST_SCRYPT_PARAMS, maxProjectsPerOrganization: 3 });
    const { user } = await signup(auth);
    const organizationId = await auth.primaryOrganizationId(user.id);

    await auth.createProject(user, organizationId, "second");
    await auth.createProject(user, organizationId, "third");

    await expect(auth.createProject(user, organizationId, "fourth")).rejects.toBeInstanceOf(ValidationError);
    await expect(auth.createProject(user, organizationId, "fourth")).rejects.toThrow(/maximum of 3 projects/);

    // And the refusal is real: nothing was written.
    const projects = await auth.listProjectsForUser(user.id);
    expect(projects).toHaveLength(3);
  });

  it("counts only the organization's own projects", async () => {
    // A different tenant's projects must not consume this one's allowance.
    const auth = new AuthService(db, { scryptParams: TEST_SCRYPT_PARAMS, maxProjectsPerOrganization: 2 });
    const { user: alice } = await signup(auth);
    const { user: bob } = await auth.signup({
      email: "bob@example.com",
      password: "a-sufficiently-long-password",
      displayName: "Bob",
    });

    const aliceOrg = await auth.primaryOrganizationId(alice.id);
    const bobOrg = await auth.primaryOrganizationId(bob.id);
    expect(aliceOrg).not.toBe(bobOrg);

    await auth.createProject(alice, aliceOrg, "alice-second");
    // Alice is now at her cap; Bob is not affected by it.
    await expect(auth.createProject(alice, aliceOrg, "alice-third")).rejects.toThrow(/maximum/);
    await expect(auth.createProject(bob, bobOrg, "bob-second")).resolves.toMatchObject({ name: "bob-second" });
  });

  it("has a default cap, so a deployment that configures nothing is still bounded", async () => {
    // The point of a default is that an operator who never thought about this is not exposed.
    // The rows are inserted directly rather than created through the service: this is about
    // where the ceiling sits, and 99 real creations would only make the test slow.
    const auth = new AuthService(db, { scryptParams: TEST_SCRYPT_PARAMS });
    const { user } = await signup(auth);
    const organizationId = await auth.primaryOrganizationId(user.id);

    const now = new Date();
    await db.insert(projects).values(
      Array.from({ length: 99 }, (_, i) => ({
        id: uuid(),
        organizationId,
        name: `filler-${i}`,
        createdAt: now,
        updatedAt: now,
      }))
    );

    await expect(auth.createProject(user, organizationId, "one-too-many")).rejects.toThrow(/maximum of 100 projects/);
  });
});
