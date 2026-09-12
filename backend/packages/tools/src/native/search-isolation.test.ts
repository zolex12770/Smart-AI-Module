import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolInvocationContext } from "@ai-platform/shared";
import { createSearchTools } from "./search.js";

/**
 * Tenant isolation and containment for the SEARCH tools — docs/26_DECISIONS.md ADR-095.
 *
 * ADR-090 gave every filesystem and coding tool a per-project workspace, and ADR-088 made
 * containment resolve symlinks before checking. `search.ts` received neither. It was written
 * against the earlier single-root model and kept `context.workspaceRoot ? … : root`, so with no
 * `workspaceRoot` injected — which is the production case, since the composition root does not
 * pass one — both tools walked the DEPLOYMENT root: every tenant's workspace at once.
 *
 * Each test here failed before the fix. They are written as tenant-A-writes/tenant-B-searches
 * because that is the actual attack: a read tool with no `WHERE project_id` is a cross-tenant
 * disclosure even though it never writes anything.
 */
const ctx = (projectId: string, workspaceRoot?: string): ToolInvocationContext =>
  ({ projectId, userId: "user-1", workspaceRoot }) as ToolInvocationContext;

describe("search tools are scoped to one project workspace", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "search-iso-"));
    outside = mkdtempSync(join(tmpdir(), "search-out-"));
    // Tenant A's workspace, with something worth stealing in it.
    mkdirSync(join(root, "tenant-a"), { recursive: true });
    writeFileSync(join(root, "tenant-a", "notes.txt"), "api key: TENANT-A-SECRET\n");
    // Tenant B's workspace, holding only its own file.
    mkdirSync(join(root, "tenant-b"), { recursive: true });
    writeFileSync(join(root, "tenant-b", "own.txt"), "tenant b's own content\n");
    writeFileSync(join(outside, "host-secret.txt"), "HOST-FILE-OUTSIDE-SANDBOX\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const tools = () => {
    const [search, glob] = createSearchTools(root);
    return { search, glob };
  };

  it("fs.search cannot read another tenant's file content", async () => {
    const result = await tools().search.handler({ pattern: "TENANT-A-SECRET" }, ctx("tenant-b"));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.output)).not.toContain("TENANT-A-SECRET");
    expect((result.output as { matchCount: number }).matchCount).toBe(0);
  });

  it("fs.search still finds the caller's own content", async () => {
    const result = await tools().search.handler({ pattern: "own content" }, ctx("tenant-b"));
    const output = result.output as { matchCount: number; matches: Array<{ path: string }> };
    expect(output.matchCount).toBe(1);
    // The path is relative to the caller's workspace, so it carries no tenant id at all.
    expect(output.matches[0].path).toBe("own.txt");
  });

  it("fs.glob cannot enumerate another tenant's files", async () => {
    const result = await tools().glob.handler({ pattern: "**/*.txt" }, ctx("tenant-b"));
    const output = result.output as { files: string[] };
    expect(output.files).toEqual(["own.txt"]);
  });

  it("refuses to search at all when the invocation has no project scope", async () => {
    const result = await tools().search.handler({ pattern: "x" }, ctx(""));
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("project scope");
  });

  it("ignores an ABSOLUTE workspaceRoot rather than honouring it as an escape", async () => {
    // The composition root used to pass the deployment root here. Honouring it would re-open
    // exactly the cross-tenant walk this ADR closes, so it is ignored (parity with coding.ts).
    const result = await tools().search.handler({ pattern: "TENANT-A-SECRET" }, ctx("tenant-b", root));
    expect(result.ok).toBe(true);
    expect((result.output as { matchCount: number }).matchCount).toBe(0);
  });

  it("honours a RELATIVE workspaceRoot as a subdirectory of the caller's workspace", async () => {
    mkdirSync(join(root, "tenant-b", "checkout"), { recursive: true });
    writeFileSync(join(root, "tenant-b", "checkout", "inner.txt"), "scoped content\n");
    const result = await tools().glob.handler({ pattern: "**/*.txt" }, ctx("tenant-b", "checkout"));
    expect((result.output as { files: string[] }).files).toEqual(["inner.txt"]);
  });

  it("does not follow a symlink out of the workspace during the walk (ADR-088)", async () => {
    // Containment was applied ONCE to the search root and never to the entries the walk
    // yielded, and the walk used statSync, which resolves links. So a link the agent is allowed
    // to create inside its own workspace made every file on the host searchable.
    //
    // `junction` is used rather than a directory symlink because it needs no elevation on
    // Windows; on POSIX the type argument is ignored. The kernel resolves both identically, so
    // this exercises the real code path rather than approximating it.
    symlinkSync(outside, join(root, "tenant-b", "escape"), "junction");
    const result = await tools().search.handler({ pattern: "HOST-FILE-OUTSIDE-SANDBOX" }, ctx("tenant-b"));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.output)).not.toContain("HOST-FILE-OUTSIDE-SANDBOX");
  });

  it("does not follow a FILE symlink out of the workspace", async () => {
    // A file symlink needs developer mode or elevation on Windows, and there is no junction
    // equivalent for a file. When it cannot be created the test states so loudly rather than
    // passing quietly — a skipped test is not a passing test (product brief §29).
    let linked = true;
    try {
      symlinkSync(join(outside, "host-secret.txt"), join(root, "tenant-b", "leak.txt"), "file");
    } catch {
      linked = false;
    }
    if (!linked) {
      console.warn(
        "SKIPPING the file-symlink containment case: this platform refused symlinkSync " +
          "(Windows needs developer mode or elevation). The directory case above still ran."
      );
      return;
    }
    const result = await tools().search.handler({ pattern: "HOST-FILE" }, ctx("tenant-b"));
    expect(JSON.stringify(result.output)).not.toContain("HOST-FILE-OUTSIDE-SANDBOX");
  });

  it("still follows a link that stays inside the workspace", async () => {
    mkdirSync(join(root, "tenant-b", "real"), { recursive: true });
    writeFileSync(join(root, "tenant-b", "real", "kept.txt"), "legitimately linked\n");
    symlinkSync(join(root, "tenant-b", "real"), join(root, "tenant-b", "linked"), "junction");
    const result = await tools().search.handler({ pattern: "legitimately linked" }, ctx("tenant-b"));
    // Reachable by both names. The point is that containment did not break a legitimate link:
    // a check that rejects everything is not a containment check.
    expect((result.output as { matchCount: number }).matchCount).toBeGreaterThanOrEqual(1);
  });
});
