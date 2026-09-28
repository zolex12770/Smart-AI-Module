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

/**
 * DL-21. qwen2.5:7b wrote a correct diff whose blank context line carried no leading space, as
 * many diff producers do and as `git apply` and GNU patch both accept. The parser dropped the
 * line, the hunk lost its blank context line, and the model was told twice that the lines were
 * "not in this order" — for a diff that was right.
 */
describe("blank context lines without their leading space", () => {
  const file = "function slugify(title) {\n  return title.trim().replace(' ', '-');\n}\n\nmodule.exports = { slugify };\n";
  // Verbatim from the audit log of the compose run.
  const diff =
    "--- a/slugify.js\n+++ b/slugify.js\n@@ -1,6 +1,7 @@\n function slugify(title) {\n" +
    "-  return title.trim().replace(' ', '-');\n+  return title.toLowerCase().trim().replace(' ', '-');\n" +
    " }\n\n module.exports = { slugify };\n";

  it("reads an empty line inside a hunk as an empty context line", () => {
    const [patch] = parseUnifiedDiff(diff);
    expect(patch!.hunks[0]!.lines).toEqual([
      " function slugify(title) {",
      "-  return title.trim().replace(' ', '-');",
      "+  return title.toLowerCase().trim().replace(' ', '-');",
      " }",
      " ",
      " module.exports = { slugify };",
    ]);
  });

  it("applies the model's diff exactly", () => {
    const [patch] = parseUnifiedDiff(diff);
    expect(applyPatchToContent(file, patch!).content).toBe(
      "function slugify(title) {\n  return title.toLowerCase().trim().replace(' ', '-');\n}\n\nmodule.exports = { slugify };\n"
    );
  });

  it("does not turn trailing blank lines after the last hunk into context", () => {
    const tail = "--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n\n\n";
    const [patch] = parseUnifiedDiff(tail);
    expect(patch!.hunks[0]!.lines).toEqual([" const a = 1;", "-const b = 2;", "+const b = 3;"]);
    expect(applyPatchToContent("const a = 1;\nconst b = 2;\n", patch!).content).toBe("const a = 1;\nconst b = 3;\n");
  });

  it("does not carry a blank line across into the next hunk or file", () => {
    const two =
      "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-x\n+y\n\n--- a/b.js\n+++ b/b.js\n@@ -1,1 +1,1 @@\n-p\n+q\n";
    const patches = parseUnifiedDiff(two);
    expect(patches.map((p) => p.hunks[0]!.lines)).toEqual([["-x", "+y"], ["-p", "+q"]]);
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
      existsSync: (p: string) => p in files,
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

  it("refuses to delete a file, and names the gated tool that can", () => {
    /**
     * docs/26_DECISIONS.md ADR-152. `code.apply_patch` is `write_local`, which defaults to
     * `requiresApproval: "never"`, while `fs.delete_file` is `destructive` -> `"always"` and its
     * own docstring says it "exists specifically to exercise and prove the approval gate". A
     * `+++ /dev/null` stanza went straight past that gate — no hunks matched, the file need not
     * exist, and `rmSync(p, { force: true })` removed it. This test asserted that behaviour.
     */
    const fs = fakeFs({ "/w/gone.txt": "bye\n" });
    const diff = ["--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye"].join("\n");
    expect(() => applyUnifiedDiff(diff, (rel) => `/w/${rel}`, fs)).toThrow(/fs\.delete_file/);
    // The file is untouched, and nothing else in the diff was applied either.
    expect(fs.removed).toEqual([]);
    expect(fs.files["/w/gone.txt"]).toBe("bye\n");
  });

  it("refuses the whole diff when only one stanza deletes", () => {
    // The refusal is not per-file: a diff that edits one file and deletes another must leave
    // the workspace exactly as it found it, or the model is left reasoning about a half state.
    const fs = fakeFs({ "/w/keep.txt": "one\n", "/w/gone.txt": "bye\n" });
    const diff = [
      "--- a/keep.txt",
      "+++ b/keep.txt",
      "@@ -1 +1 @@",
      "-one",
      "+two",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n");
    expect(() => applyUnifiedDiff(diff, (rel) => `/w/${rel}`, fs)).toThrow(/fs\.delete_file/);
    expect(fs.files["/w/keep.txt"]).toBe("one\n");
    expect(fs.removed).toEqual([]);
  });

  it("refuses to patch a file that does not exist, with an actionable message", () => {
    const fs = fakeFs({});
    const diff = ["--- a/missing.txt", "+++ b/missing.txt", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    expect(() => applyUnifiedDiff(diff, (rel) => `/w/${rel}`, fs)).toThrow(/does not exist.*\/dev\/null/s);
  });
});
