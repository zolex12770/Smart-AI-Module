import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globFiles, globToRegExp, searchFiles } from "./search.js";

/**
 * ADR-062. The ADR-047 audit recorded FR-010 ("answer 'where is X defined?'") as not met at
 * all — the coding agent had no search capability whatsoever. These run against a real
 * temporary tree rather than a mocked filesystem, because the behaviour that matters
 * (skipping node_modules, skipping binaries, bounding results) is filesystem behaviour.
 */
describe("globToRegExp", () => {
  it("matches a simple star within one path segment", () => {
    expect(globToRegExp("src/*.ts").test("src/index.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/nested/index.ts")).toBe(false);
  });

  it("matches any depth with a double star, including none", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/index.ts")).toBe(true);
    expect(re.test("src/a/b/c/index.ts")).toBe(true);
    expect(re.test("other/index.ts")).toBe(false);
  });

  it("supports brace alternation", () => {
    const re = globToRegExp("**/*.{ts,tsx}");
    expect(re.test("app/page.tsx")).toBe(true);
    expect(re.test("app/page.ts")).toBe(true);
    expect(re.test("app/page.css")).toBe(false);
  });

  it("escapes regex metacharacters in literal segments", () => {
    expect(globToRegExp("a.b/c.ts").test("a.b/c.ts")).toBe(true);
    expect(globToRegExp("a.b/c.ts").test("axb/c.ts")).toBe(false);
  });
});

describe("searchFiles / globFiles", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "search-test-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });

    writeFileSync(join(root, "src", "math.ts"), "export function addNumbers(a: number, b: number) {\n  return a + b;\n}\n");
    writeFileSync(join(root, "src", "util.ts"), "import { addNumbers } from './math.js';\nexport const two = addNumbers(1, 1);\n");
    writeFileSync(join(root, "src", "app.tsx"), "export const App = () => null;\n");
    writeFileSync(join(root, "README.md"), "addNumbers is documented here.\n");
    // Must never appear in results: dependency and build output.
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "addNumbers everywhere\n");
    writeFileSync(join(root, "dist", "math.js"), "addNumbers compiled\n");
    // Binary-looking content must be skipped rather than dumped into a model's context.
    writeFileSync(join(root, "src", "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x41, 0x42]));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds a symbol across files and reports real line numbers", () => {
    const matches = searchFiles(root, { pattern: "addNumbers" });
    const paths = matches.map((m) => m.path).sort();
    expect(paths).toContain("src/math.ts");
    expect(paths).toContain("src/util.ts");
    expect(paths).toContain("README.md");

    const definition = matches.find((m) => m.path === "src/math.ts");
    expect(definition?.line).toBe(1);
    expect(definition?.text).toContain("export function addNumbers");
  });

  it("never searches node_modules or build output", () => {
    const paths = searchFiles(root, { pattern: "addNumbers" }).map((m) => m.path);
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("dist/"))).toBe(false);
  });

  it("restricts results with a glob", () => {
    const matches = searchFiles(root, { pattern: "addNumbers", glob: "src/**/*.ts" });
    expect(matches.every((m) => m.path.startsWith("src/") && m.path.endsWith(".ts"))).toBe(true);
    expect(matches.some((m) => m.path === "README.md")).toBe(false);
  });

  it("supports regular expressions when asked", () => {
    const matches = searchFiles(root, { pattern: "^export (function|const)", isRegex: true });
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("returns an error-free empty result for a pattern that matches nothing", () => {
    expect(searchFiles(root, { pattern: "definitelyNotPresentAnywhere" })).toEqual([]);
  });

  it("is case-insensitive by default and case-sensitive on request", () => {
    expect(searchFiles(root, { pattern: "ADDNUMBERS" }).length).toBeGreaterThan(0);
    expect(searchFiles(root, { pattern: "ADDNUMBERS", caseSensitive: true })).toEqual([]);
  });

  it("bounds the number of results so a model cannot flood its own context", () => {
    expect(searchFiles(root, { pattern: "a", maxResults: 2 })).toHaveLength(2);
  });

  it("lists files by glob, sorted, excluding ignored directories", () => {
    const files = globFiles(root, "**/*.ts");
    expect(files).toEqual(["src/math.ts", "src/util.ts"]);
  });

  it("matches nested globs and alternation together", () => {
    expect(globFiles(root, "src/**/*.{ts,tsx}")).toEqual(["src/app.tsx", "src/math.ts", "src/util.ts"]);
  });
});
