import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFilesystemTools } from "./filesystem.js";
import { projectWorkspace } from "./workspace.js";

/**
 * docs/26_DECISIONS.md ADR-090 — one agent workspace per project.
 *
 * `SANDBOX_ROOT` is a single directory and every native filesystem tool was constructed with it
 * and then ignored the invocation context entirely, so every tenant's agent read and wrote the
 * SAME directory. Project A's agent could read a file project B's agent had just written,
 * overwrite it, or delete it, simply by naming it. `ToolInvocationContext.projectId` was threaded
 * all the way to the handlers and never used.
 *
 * That was the one place in the platform where the `project_id` predicate that IS the
 * authorization model (ADR-049) had no equivalent: every repository puts a project in the SQL
 * `WHERE`, and the filesystem had no `WHERE` at all.
 *
 * These tests drive the REAL tools against a REAL filesystem with two different project ids,
 * because the bug was precisely that the id was accepted and discarded.
 */
describe("agent workspaces are isolated per project (ADR-090)", () => {
  let root: string;
  const alice = { projectId: "project-alice", userId: "u1" };
  const mallory = { projectId: "project-mallory", userId: "u2" };

  const tool = (id: string) => createFilesystemTools(root).find((t) => t.definition.id === id)!;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ws-iso-"));
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* windows may hold a handle briefly */
    }
  });

  it("does not let one project read another's file", async () => {
    await tool("fs.write_file").handler({ path: "plans.txt", content: "ALICE CONFIDENTIAL" }, alice);

    // Same relative path, different tenant. Before this change it returned Alice's contents.
    const stolen = await tool("fs.read_file")
      .handler({ path: "plans.txt" }, mallory)
      .catch((e: unknown) => ({ ok: false as const, error: String(e) }));

    expect(JSON.stringify(stolen)).not.toContain("ALICE CONFIDENTIAL");
  });

  it("does not let one project overwrite another's file", async () => {
    await tool("fs.write_file").handler({ path: "plans.txt", content: "ALICE ORIGINAL" }, alice);
    await tool("fs.write_file").handler({ path: "plans.txt", content: "MALLORY OVERWROTE THIS" }, mallory);

    const alicesCopy = await tool("fs.read_file").handler({ path: "plans.txt" }, alice);
    expect(JSON.stringify(alicesCopy)).toContain("ALICE ORIGINAL");
  });

  it("does not let one project see another's file in a directory listing", async () => {
    await tool("fs.write_file").handler({ path: "secret-plan.txt", content: "x" }, alice);
    const listing = await tool("fs.list_directory").handler({ path: "." }, mallory);
    // Enumeration is disclosure too: the FILENAME alone can be sensitive.
    expect(JSON.stringify(listing)).not.toContain("secret-plan.txt");
  });

  it("does not let one project delete another's file", async () => {
    await tool("fs.write_file").handler({ path: "important.txt", content: "keep me" }, alice);
    await tool("fs.delete_file")
      .handler({ path: "important.txt" }, mallory)
      .catch(() => undefined);

    const stillThere = await tool("fs.read_file").handler({ path: "important.txt" }, alice);
    expect(JSON.stringify(stillThere)).toContain("keep me");
  });

  it("gives each project its own directory under the deployment root", async () => {
    await tool("fs.write_file").handler({ path: "a.txt", content: "a" }, alice);
    await tool("fs.write_file").handler({ path: "b.txt", content: "b" }, mallory);
    expect(readdirSync(root).sort()).toEqual(["project-alice", "project-mallory"]);
  });

  describe("projectWorkspace", () => {
    it("refuses a project id that could traverse out of the root", () => {
      // Ids are UUIDs from our own database, so this never fires today — which is exactly why it
      // is here. A `../` in this field would be a traversal in the ROOT, which the per-path
      // containment check is not positioned to catch.
      for (const bad of ["../escape", "..", "a/b", "", "  ", "with\\backslash"]) {
        expect(() => projectWorkspace(root, { projectId: bad })).toThrow(/project scope/i);
      }
    });

    it("accepts a real project id", () => {
      expect(() => projectWorkspace(root, { projectId: "0e4cbdab-eabe-475c-9fc7-433ca60304ad" })).not.toThrow();
    });
  });
});
