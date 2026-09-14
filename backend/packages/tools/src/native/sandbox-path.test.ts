import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSandboxedPath } from "./sandbox-path.js";

/**
 * Automated regression coverage for docs/13_SECURITY_ARCHITECTURE.md §11 (path traversal) —
 * previously only exercised by a one-off manual test (PROJECT_STATUS.md Phase 3/4), tracked
 * as an open automated-testing gap until now (Phase 11).
 */
describe("resolveSandboxedPath", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sandbox-path-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves a plain relative path inside the root", () => {
    expect(resolveSandboxedPath(root, "file.txt")).toBe(join(root, "file.txt"));
    expect(resolveSandboxedPath(root, "sub/dir/file.txt")).toBe(join(root, "sub", "dir", "file.txt"));
  });

  it("resolves the root itself", () => {
    expect(resolveSandboxedPath(root, ".")).toBe(root);
  });

  it("rejects a '..' traversal that escapes the root", () => {
    expect(() => resolveSandboxedPath(root, "../outside.txt")).toThrow(/resolves outside/);
    expect(() => resolveSandboxedPath(root, "sub/../../outside.txt")).toThrow(/resolves outside/);
  });

  /**
   * The dangling-symlink escape — docs/26_DECISIONS.md ADR-125.
   *
   * `realpathSync` throws ENOENT both for a name that is not there and for a symlink whose
   * target is not there. The resolver treated the second as the first: it filed the link under
   * "does not exist", re-appended the link's own basename to the realpath'd parent, and got a
   * composite safely inside the root. The containment check passed, the caller was handed the
   * lexical path, and the OS followed the link out of the sandbox on the very next `fs` call.
   *
   * Writing through such a link is the dangerous direction, and it needs the target NOT to
   * exist — which is exactly the case the old code mishandled. An agent holding the write tools
   * can create the link itself, so this was a self-service escape rather than a hypothetical.
   */
  describe("dangling symlinks (ADR-125)", () => {
    /** Directory symlinks need no elevation on Windows when created as a junction. */
    const linkDir = (target: string, path: string) => symlinkSync(target, path, "junction");

    it("rejects a path through a dangling DIRECTORY link that points outside the root", () => {
      const outside = mkdtempSync(join(tmpdir(), "sandbox-path-outside-"));
      try {
        // The link exists; what it points at does not yet. That is the whole trick.
        const missingOutside = join(outside, "not-created-yet");
        linkDir(missingOutside, join(root, "escape"));

        expect(() => resolveSandboxedPath(root, "escape/owned.txt")).toThrow(/resolves outside/);
        expect(() => resolveSandboxedPath(root, "escape")).toThrow(/resolves outside/);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("rejects a link chain that only leaves the root on the second hop", () => {
      const outside = mkdtempSync(join(tmpdir(), "sandbox-path-outside-"));
      try {
        linkDir(join(outside, "still-missing"), join(root, "second"));
        linkDir(join(root, "second"), join(root, "first"));

        expect(() => resolveSandboxedPath(root, "first/owned.txt")).toThrow(/resolves outside/);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("still allows a dangling link that points INSIDE the root", () => {
      // Creating a file through a symlink is ordinary. The check is about where a path leads,
      // not whether it exists yet, so refusing this would break legitimate work.
      linkDir(join(root, "real-dir"), join(root, "alias"));
      expect(resolveSandboxedPath(root, "alias/new-file.txt")).toBe(join(root, "alias", "new-file.txt"));
    });

    it("refuses a circular link instead of following it forever", () => {
      // A security check that hangs is a denial of service inside the sandbox.
      linkDir(join(root, "b"), join(root, "a"));
      linkDir(join(root, "a"), join(root, "b"));
      expect(() => resolveSandboxedPath(root, "a/file.txt")).toThrow(/too many symbolic links|resolves outside/);
    });

    it("still resolves a NON-dangling link inside the root, unchanged", () => {
      writeFileSync(join(root, "target.txt"), "hello");
      linkDir(root, join(root, "self"));
      expect(resolveSandboxedPath(root, "self/target.txt")).toBe(join(root, "self", "target.txt"));
    });
  });

  it("rejects an absolute path override outside the root", () => {
    const outsideAbsolute = tmpdir();
    expect(() => resolveSandboxedPath(root, outsideAbsolute)).toThrow(/resolves outside/);
  });

  it("does not falsely reject a sibling directory that merely shares the root's name as a prefix", () => {
    // e.g. root "/sandbox" vs a sibling "/sandbox-evil" — a naive `startsWith` check without
    // the trailing separator would wrongly allow this. Confirmed rejected here.
    expect(() => resolveSandboxedPath(root, `../${root.split(/[\\/]/).pop()}-evil/file.txt`)).toThrow(/resolves outside/);
  });

  it("resolves relative to a distinct resolutionBase while still enforcing containment against root", () => {
    const sub = join(root, "coding-demo");
    // A path that's fine relative to `sub` (stays inside root)...
    expect(resolveSandboxedPath(root, "math.test.js", sub)).toBe(join(sub, "math.test.js"));
    // ...but escapes when resolved from a base deep enough that '..' clears the root entirely.
    expect(() => resolveSandboxedPath(root, "../../outside.txt", sub)).toThrow(/resolves outside/);
  });
});
