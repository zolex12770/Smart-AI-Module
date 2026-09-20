import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFilesystemTools } from "./filesystem.js";
import { resolveSandboxedPath } from "./sandbox-path.js";

/**
 * docs/26_DECISIONS.md ADR-088 — symlink containment, and the escape that was open.
 *
 * `resolveSandboxedPath` compared `path.resolve()` output as a string. Its own docstring
 * acknowledged it handled only "a symlink-free lexical escape", while docs/13 §11 requires
 * "reject ... symlink escapes (resolve symlinks before the containment check)" — and
 * `backend/packages/security/src/sandbox.ts` had been doing exactly that all along. Two containment
 * implementations; the filesystem tools used the weak one.
 *
 * It was demonstrated, not theorised. Before the fix, this exact setup returned:
 *
 *     {"ok":true,"output":{"content":"TOP SECRET HOST FILE CONTENTS", ...}}
 *
 * An agent can create such a symlink with the write tools it already holds, or find one in a
 * repository it was asked to work on.
 *
 * Every test drives a REAL symlink on a REAL filesystem. Asserting on the string-handling alone
 * would pass against the broken version, since the bug was precisely that only strings were
 * compared.
 */
/**
 * Can this platform create a FILE symlink? Probed at collection time so the cases that need one
 * are reported as SKIPPED rather than passing with no assertions — an assertion-free green is the
 * same "cannot fail" defect these suites exist to close. Linux (and CI) creates them freely.
 */
const FILE_SYMLINKS_SUPPORTED = (() => {
  const dir = mkdtempSync(join(tmpdir(), "symlink-probe-"));
  try {
    writeFileSync(join(dir, "target"), "x");
    symlinkSync(join(dir, "target"), join(dir, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe("sandbox containment resolves symlinks (ADR-088)", () => {
  let root: string;
  let outside: string;
  let hasSymlinks = true;

  const ctx = { projectId: "p1", userId: "u1" };
  /**
   * Where the TOOLS resolve — docs/26_DECISIONS.md ADR-090, and why ADR-152 rewrote these tests.
   *
   * Every handler resolves against `projectWorkspace(root, context)`, so with `projectId: "p1"`
   * the effective root is `<root>/p1`. The three end-to-end cases below planted their symlink at
   * `<root>/…`, one directory ABOVE anything the tool can address — so the read hit ENOENT on a
   * path that was not a link, the write created an ordinary new file inside the workspace, and
   * all three assertions held no matter what the resolver did. The helper-level tests above are
   * correct as they stand: they call `resolveSandboxedPath(root, …)` directly.
   */
  let workspace: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sbx-root-"));
    workspace = join(root, ctx.projectId);
    mkdirSync(workspace, { recursive: true });
    outside = mkdtempSync(join(tmpdir(), "sbx-outside-"));
    writeFileSync(join(outside, "host-secret.txt"), "TOP SECRET HOST FILE CONTENTS");
    try {
      // `junction` works on Windows without the developer-mode/elevation a directory symlink
      // needs; on POSIX the type argument is ignored.
      symlinkSync(outside, join(root, "escape"), "junction");
    } catch {
      hasSymlinks = false;
    }
  });

  afterEach(() => {
    for (const dir of [root, outside]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows may hold a handle briefly */
      }
    }
  });

  it("refuses to READ a host file through a symlink inside the workspace", () => {
    if (!hasSymlinks) return;
    expect(() => resolveSandboxedPath(root, "escape/host-secret.txt")).toThrow(/outside the sandboxed root/);
  });

  it("refuses to WRITE through a symlink, which would plant a file on the host", () => {
    if (!hasSymlinks) return;
    // The write direction matters at least as much as the read: this is how an agent following a
    // prompt injection would modify something outside its workspace. The target does not exist,
    // which is exactly the case `realpathSync` alone cannot handle.
    expect(() => resolveSandboxedPath(root, "escape/planted.txt")).toThrow(/outside the sandboxed root/);
  });

  it("refuses a symlink to a FILE, not only to a directory", () => {
    if (!hasSymlinks) return;
    try {
      symlinkSync(join(outside, "host-secret.txt"), join(root, "link-to-file"), "file");
    } catch {
      return;
    }
    expect(() => resolveSandboxedPath(root, "link-to-file")).toThrow(/outside the sandboxed root/);
  });

  it("refuses a symlink nested several directories deep", () => {
    if (!hasSymlinks) return;
    mkdirSync(join(root, "a", "b"), { recursive: true });
    try {
      symlinkSync(outside, join(root, "a", "b", "out"), "junction");
    } catch {
      return;
    }
    expect(() => resolveSandboxedPath(root, "a/b/out/host-secret.txt")).toThrow(/outside the sandboxed root/);
  });

  it("does not leak where the symlink actually pointed", () => {
    if (!hasSymlinks) return;
    // The caller is a model, possibly following a prompt injection. Echoing the resolved
    // destination would hand back the host path the sandbox exists to withhold.
    try {
      resolveSandboxedPath(root, "escape/host-secret.txt");
      throw new Error("should have thrown");
    } catch (error) {
      expect(String(error)).not.toContain(outside);
    }
  });

  it("blocks the escape through the REAL tool, not just the helper", async () => {
    if (!hasSymlinks) return;
    // Planted inside the project workspace, which is the only place the tool can reach.
    try {
      symlinkSync(outside, join(workspace, "escape"), "junction");
    } catch {
      return;
    }
    // The link really is reachable and really does lead outside: without this the assertion
    // below would pass against a path that simply does not exist, which is how it used to pass.
    expect(existsSync(join(workspace, "escape", "host-secret.txt"))).toBe(true);

    const [readTool] = createFilesystemTools(root).filter((t) => t.definition.id === "fs.read_file");
    // Whether the tool throws or returns ok:false, the one unacceptable outcome is the host
    // file's contents coming back.
    const outcome = await readTool.handler({ path: "escape/host-secret.txt" }, ctx).catch((e: unknown) => ({
      ok: false as const,
      error: String(e),
    }));
    expect(JSON.stringify(outcome)).not.toContain("TOP SECRET HOST FILE CONTENTS");
  });

  /**
   * The same escape, through a link whose target does not exist yet — ADR-125.
   *
   * ADR-088 closed the case where the link points at something real. A DANGLING link stayed
   * open, because `realpathSync` reports "the link's target is missing" and "this name was never
   * here" with the same ENOENT, and the resolver read the first as the second. Writing is both
   * the dangerous direction and the case where the target does not exist, so the gap lined up
   * exactly with the operation that matters: `fs.write_file` through such a link CREATES the
   * host file.
   *
   * This needs a real FILE symlink. A junction cannot stand in: pointed at a missing directory
   * the write fails for the ordinary reason that its parent is absent, so the test would pass
   * against the unfixed resolver and prove nothing. Reported as a skip where file symlinks need
   * elevation, and run for real in CI, where Linux creates them without ceremony.
   */
  it.skipIf(!FILE_SYMLINKS_SUPPORTED)(
    "refuses to WRITE through a DANGLING FILE link that points outside the workspace",
    async () => {
      const plantedAt = join(outside, "planted-by-the-agent.txt");
      // The link exists; its target does not. An agent can create exactly this with the write
      // tools it already holds. Inside the WORKSPACE, so the tool can address it (ADR-152).
      symlinkSync(plantedAt, join(workspace, "dangling.txt"), "file");
      expect(existsSync(plantedAt)).toBe(false);
      // The link is where the tool will look: `lstat` succeeds on it even though its target
      // does not exist, which is what makes this the dangling case rather than a missing file.
      expect(lstatSync(join(workspace, "dangling.txt")).isSymbolicLink()).toBe(true);

      const [writeTool] = createFilesystemTools(root).filter((t) => t.definition.id === "fs.write_file");
      const outcome = await writeTool
        .handler({ path: "dangling.txt", content: "PLANTED ON THE HOST" }, ctx)
        .catch((e: unknown) => ({ ok: false as const, error: String(e) }));

      // Whether it throws or returns ok:false, the unacceptable outcome is a file on the host.
      expect(existsSync(plantedAt)).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain("PLANTED ON THE HOST");
    }
  );

  it.skipIf(!FILE_SYMLINKS_SUPPORTED)("refuses to READ through a dangling FILE link", async () => {
    const target = join(outside, "host-secret.txt"); // exists, from beforeEach
    const link = join(workspace, "read-me.txt");
    // Created while the target is absent, then the target appears: containment must depend on
    // where the link LEADS, not on what existed when it was made.
    symlinkSync(join(outside, "not-yet.txt"), link, "file");
    writeFileSync(join(outside, "not-yet.txt"), "TOP SECRET HOST FILE CONTENTS");
    expect(existsSync(target)).toBe(true);
    // Reachable from inside the workspace, and leading outside it.
    expect(existsSync(link)).toBe(true);

    const [readTool] = createFilesystemTools(root).filter((t) => t.definition.id === "fs.read_file");
    const outcome = await readTool
      .handler({ path: "read-me.txt" }, ctx)
      .catch((e: unknown) => ({ ok: false as const, error: String(e) }));
    expect(JSON.stringify(outcome)).not.toContain("TOP SECRET HOST FILE CONTENTS");
  });

  describe("legitimate paths still work — a containment check that blocks everything is useless", () => {
    it("allows a plain relative path", () => {
      expect(resolveSandboxedPath(root, "notes.txt")).toBe(join(root, "notes.txt"));
    });

    it("allows a path that does not exist yet, which every write needs", () => {
      expect(() => resolveSandboxedPath(root, "new/deeply/nested/file.txt")).not.toThrow();
    });

    it("allows a symlink that stays INSIDE the sandbox", () => {
      if (!hasSymlinks) return;
      mkdirSync(join(root, "real"), { recursive: true });
      writeFileSync(join(root, "real", "inner.txt"), "fine");
      try {
        symlinkSync(join(root, "real"), join(root, "alias"), "junction");
      } catch {
        return;
      }
      // Containment, not symlink-phobia: a link whose destination is inside the root is fine.
      expect(() => resolveSandboxedPath(root, "alias/inner.txt")).not.toThrow();
    });

    it("still rejects a lexical `..` escape", () => {
      expect(() => resolveSandboxedPath(root, "../outside.txt")).toThrow(/outside the sandboxed root/);
    });

    it("still rejects a sibling directory that merely shares the root's prefix", () => {
      // `/tmp/sbx-root-x` must not be reachable from root `/tmp/sbx-root`; a naive
      // `startsWith(root)` without the separator would allow it.
      expect(() => resolveSandboxedPath(root, `../${join(root).split(/[\\/]/).pop()}-sibling/f.txt`)).toThrow(
        /outside the sandboxed root/
      );
    });
  });
});
