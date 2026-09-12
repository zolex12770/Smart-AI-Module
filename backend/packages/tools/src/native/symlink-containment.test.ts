import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
describe("sandbox containment resolves symlinks (ADR-088)", () => {
  let root: string;
  let outside: string;
  let hasSymlinks = true;

  const ctx = { projectId: "p1", userId: "u1" };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sbx-root-"));
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
    const [readTool] = createFilesystemTools(root).filter((t) => t.definition.id === "fs.read_file");
    // Whether the tool throws or returns ok:false, the one unacceptable outcome is the host
    // file's contents coming back.
    const outcome = await readTool.handler({ path: "escape/host-secret.txt" }, ctx).catch((e: unknown) => ({
      ok: false as const,
      error: String(e),
    }));
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
