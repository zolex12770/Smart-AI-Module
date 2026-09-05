import { describe, expect, it } from "vitest";
import { PatchError, applyPatchToContent, applyUnifiedDiff, parseUnifiedDiff } from "./patch.js";

/**
 * ADR-062. The coding agent's ability to change code correctly rests entirely on this file,
 * and the failure that matters is silent: a hunk applied to *nearly* the right place
 * corrupts a file while reporting success. These tests pin the matching strategy — exact,
 * then bounded search, then refuse — and the all-or-nothing guarantee.
 */
describe("parseUnifiedDiff", () => {
  it("parses a single-file, single-hunk diff", () => {
    const diff = [
      "--- a/src/math.js",
      "+++ b/src/math.js",
      "@@ -1,3 +1,3 @@",
      " const ANSWER =",
      "-41;",
      "+42;",
      " module.exports = { ANSWER };",
    ].join("\n");
    const [patch] = parseUnifiedDiff(diff);
    expect(patch.oldPath).toBe("src/math.js");
    expect(patch.newPath).toBe("src/math.js");
    expect(patch.hunks).toHaveLength(1);
    expect(patch.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 });
  });

  it("parses a multi-file diff", () => {
    const diff = [
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- a/two.txt",
      "+++ b/two.txt",
      "@@ -1 +1 @@",
      "-c",
      "+d",
    ].join("\n");
    expect(parseUnifiedDiff(diff).map((p) => p.newPath)).toEqual(["one.txt", "two.txt"]);
  });

  it("recognises file creation and deletion", () => {
    const created = parseUnifiedDiff(["--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1 @@", "+hello"].join("\n"));
    expect(created[0].isNewFile).toBe(true);
    const deleted = parseUnifiedDiff(["--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye"].join("\n"));
    expect(deleted[0].isDeletedFile).toBe(true);
  });

  it("rejects a diff with no file header rather than guessing", () => {
    expect(() => parseUnifiedDiff("@@ -1 +1 @@\n-a\n+b")).toThrow(PatchError);
  });
});

describe("applyPatchToContent", () => {
  const file = ["line one", "line two", "line three", "line four"].join("\n") + "\n";

  it("applies a hunk that matches exactly at its stated line", () => {
    const [patch] = parseUnifiedDiff(
      ["--- a/f.txt", "+++ b/f.txt", "@@ -2,2 +2,2 @@", " line two", "-line three", "+LINE THREE"].join("\n")
    );
    const result = applyPatchToContent(file, patch);
    expect(result.content).toBe(["line one", "line two", "LINE THREE", "line four"].join("\n") + "\n");
    expect(result.offsets).toEqual([]);
  });

  it("finds a hunk that drifted, and reports the offset rather than hiding it", () => {
    const shifted = ["header", "inserted", ...file.split("\n")].join("\n");
    const [patch] = parseUnifiedDiff(
      ["--- a/f.txt", "+++ b/f.txt", "@@ -2,2 +2,2 @@", " line two", "-line three", "+LINE THREE"].join("\n")
    );
    const result = applyPatchToContent(shifted, patch);
    expect(result.content).toContain("LINE THREE");
    expect(result.offsets[0]).toBe(2);
  });

  it("REFUSES a hunk whose context does not match, instead of applying it fuzzily", () => {
    const [patch] = parseUnifiedDiff(
      ["--- a/f.txt", "+++ b/f.txt", "@@ -2,2 +2,2 @@", " completely different", "-nope", "+yes"].join("\n")
    );
    expect(() => applyPatchToContent(file, patch)).toThrow(/does not match/);
  });

  it("applies several hunks in one file, accounting for length changes", () => {
    const [patch] = parseUnifiedDiff(
      [
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1,1 +1,2 @@",
        "-line one",
        "+LINE ONE",
        "+extra line",
        "@@ -4,1 +5,1 @@",
        "-line four",
        "+LINE FOUR",
      ].join("\n")
    );
    const result = applyPatchToContent(file, patch);
    expect(result.content.split("\n")).toEqual(["LINE ONE", "extra line", "line two", "line three", "LINE FOUR", ""]);
  });

  it("preserves CRLF line endings", () => {
    const crlf = "alpha\r\nbeta\r\n";
    const [patch] = parseUnifiedDiff(["--- a/f.txt", "+++ b/f.txt", "@@ -1,1 +1,1 @@", "-alpha", "+ALPHA"].join("\n"));
    expect(applyPatchToContent(crlf, patch).content).toBe("ALPHA\r\nbeta\r\n");
  });
});

describe("applyUnifiedDiff", () => {
  function fakeFs(initial: Record<string, string>) {
    const files = { ...initial };
    const removed: string[] = [];
    return {
      files,
      removed,
      readFileSync: ((p: string) => {
        if (!(p in files)) throw new Error("ENOENT");
        return files[p];
      }) as never,
      writeFileSync: ((p: string, c: string) => {
        files[p] = c;
      }) as never,
      rmSync: (p: string) => {
        delete files[p];
        removed.push(p);
      },
    };
  }

  it("writes every file when all hunks apply", () => {
    const fs = fakeFs({ "/w/one.txt": "a\n", "/w/two.txt": "c\n" });
    const diff = [
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- a/two.txt",
      "+++ b/two.txt",
      "@@ -1 +1 @@",
      "-c",
      "+d",
    ].join("\n");
    const applied = applyUnifiedDiff(diff, (rel) => `/w/${rel}`, fs);
    expect(applied.map((a) => [a.path, a.action])).toEqual([
      ["one.txt", "modified"],
      ["two.txt", "modified"],
    ]);
    expect(fs.files["/w/one.txt"]).toBe("b\n");
    expect(fs.files["/w/two.txt"]).toBe("d\n");
  });

  it("is ATOMIC — one bad hunk means no file is written at all", () => {
    const fs = fakeFs({ "/w/one.txt": "a\n", "/w/two.txt": "c\n" });
    const diff = [
      "--- a/one.txt",
      "+++ b/one.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- a/two.txt",
      "+++ b/two.txt",
      "@@ -1 +1 @@",
      "-THIS DOES NOT MATCH",
      "+d",
    ].join("\n");
    expect(() => applyUnifiedDiff(diff, (rel) => `/w/${rel}`, fs)).toThrow(PatchError);
    // The first file's patch was valid, but nothing may be written when the set fails.
    expect(fs.files["/w/one.txt"]).toBe("a\n");
    expect(fs.files["/w/two.txt"]).toBe("c\n");
  });

  it("creates a new file from a /dev/null diff", () => {
    const fs = fakeFs({});
    const diff = ["--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+hello", "+world"].join("\n");
    const applied = applyUnifiedDiff(diff, (rel) => `/w/${rel}`, fs);
    expect(applied[0].action).toBe("created");
    expect(fs.files["/w/new.txt"]).toBe("hello\nworld\n");
  });

  it("deletes a file from a /dev/null target", () => {
    const fs = fakeFs({ "/w/gone.txt": "bye\n" });
    const diff = ["--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye"].join("\n");
    const applied = applyUnifiedDiff(diff, (rel) => `/w/${rel}`, fs);
    expect(applied[0].action).toBe("deleted");
    expect(fs.removed).toEqual(["/w/gone.txt"]);
  });

  it("refuses to patch a file that does not exist, with an actionable message", () => {
    const fs = fakeFs({});
    const diff = ["--- a/missing.txt", "+++ b/missing.txt", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    expect(() => applyUnifiedDiff(diff, (rel) => `/w/${rel}`, fs)).toThrow(/does not exist.*\/dev\/null/s);
  });
});
