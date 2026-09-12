import { mkdtempSync, rmSync } from "node:fs";
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
