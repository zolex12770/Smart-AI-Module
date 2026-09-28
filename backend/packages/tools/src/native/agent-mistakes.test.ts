import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolInvocationContext } from "@ai-platform/shared";
import { createTerminalTools } from "./terminal.js";
import { ProcessSandbox } from "@ai-platform/security";
import { createCodingTools } from "./coding.js";

/**
 * The two mistakes a real coding run actually made — docs/26_DECISIONS.md ADR-145.
 *
 * UAT-17 drove the coding agent against a genuinely broken file and it failed twice at the
 * ten-minute ceiling. The persisted activity log said precisely why, and neither reason was the
 * agent engine:
 *
 *  1. The model called the terminal with `{ command: "node", args: ["node", "sum.test.cjs"] }`,
 *     repeating the binary as its own first argument. The process tried to load a module called
 *     `node`, and the loader error that came back looks nothing like the assertion failure the
 *     model was hunting — so it never saw the real failure at all.
 *  2. Never having seen it, the patch it wrote was a no-op: the hunk's `+` line was identical to
 *     its `-` line. Every hunk matched, so the tool answered `hunksApplied: 1, action: modified`.
 *     Accurate, and read by the model as "fixed".
 *
 * Both are reported to the model now, because a tool that answers a mistake with a useful error
 * is how a reasoning loop corrects itself — and because "applied a change" when nothing changed is
 * the kind of false success this platform refuses everywhere else.
 */
const PROJECT_ID = "p1";
const ctx = (projectId = PROJECT_ID): ToolInvocationContext => ({ projectId, userId: "u1" }) as ToolInvocationContext;

/** ADR-090: tools resolve inside the CALLER'S project workspace, not the bare deployment root. */
function workspaceOf(root: string): string {
  const dir = join(root, PROJECT_ID);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("the terminal refuses a command repeated as its own argument", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-mistake-"));
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* windows may briefly hold a handle */
    }
  });

  const terminal = () =>
    // The real sandbox, not a stub: a stub would let a regression in the isolation path pass.
    createTerminalTools(root, new ProcessSandbox(root)).find((t) => t.definition.id === "terminal.run_command")!;

  it("rejects the exact call the failed run made, and says what to send instead", async () => {
    const result = await terminal().handler({ command: "node", args: ["node", "sum.test.cjs"], cwd: "." }, ctx());

    expect(result.ok).toBe(false);
    const message = String(result.error);
    // The diagnosis, not just a refusal: a model that is told only "no" repeats itself.
    expect(message).toMatch(/both the command and its first argument/i);
    expect(message).toMatch(/\["sum\.test\.cjs"\]/);
  });

  it("still runs the correct form of the same call", async () => {
    writeFileSync(join(workspaceOf(root), "ok.cjs"), 'console.log("ran");\n');
    const result = await terminal().handler({ command: "node", args: ["ok.cjs"], cwd: "." }, ctx());

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.output)).toContain("ran");
  });

  it("does not refuse an argument that merely contains the command name", async () => {
    // `node` inside a filename is not the same mistake, and refusing it would be a new bug.
    writeFileSync(join(workspaceOf(root), "node-helper.cjs"), 'console.log("helper");\n');
    const result = await terminal().handler({ command: "node", args: ["node-helper.cjs"], cwd: "." }, ctx());

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.output)).toContain("helper");
  });

  it("tells the model what each argument means", () => {
    // The schema said `command: string` and `args: string[]` with no descriptions at all, which
    // is what left the convention to be guessed.
    const schema = terminal().definition.inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    expect(schema.properties.command?.description).toMatch(/not.*repeated in `args`|never repeated/i);
    expect(schema.properties.args?.description).toMatch(/WITHOUT the program itself/i);
  });
});

describe("a patch that changes nothing is not reported as applied", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agent-patch-"));
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* windows may briefly hold a handle */
    }
  });

  const patchTool = () => createCodingTools(root).find((t) => t.definition.id === "code.apply_patch")!;
  const SOURCE = "function sum(a, b) {\n  return a - b;\n}\nmodule.exports = { sum };\n";

  it("refuses the model's no-op diff — its body, with a header that counts it correctly", async () => {
    writeFileSync(join(workspaceOf(root), "sum.cjs"), SOURCE);

    // The model's own hunk body: the `+` line repeats the `-` line, and the real bug (`a - b`) is
    // never touched. Its original header (`@@ -2,3 +2,3 @@` over four lines) is now refused as
    // malformed before this guard is reached — see the next test — so the header here is the
    // correct one, to keep the no-op guard itself covered.
    const diff = [
      "--- a/sum.cjs",
      "+++ b/sum.cjs",
      "@@ -1,4 +1,4 @@",
      " function sum(a, b) {",
      "   return a - b;",
      " }",
      "-module.exports = { sum };",
      "+module.exports = { sum };",
      "",
    ].join("\n");

    const result = await patchTool().handler({ diff }, ctx());

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/changed nothing|byte-for-byte identical/i);
    // And the file is untouched, rather than rewritten with identical content.
    expect(readFileSync(join(workspaceOf(root), "sum.cjs"), "utf8")).toBe(SOURCE);
  });

  it("refuses the recorded no-op diff verbatim: its header is recounted, and it changes nothing", async () => {
    writeFileSync(join(workspaceOf(root), "sum.cjs"), SOURCE);
    const diff = [
      "--- a/sum.cjs",
      "+++ b/sum.cjs",
      "@@ -2,3 +2,3 @@",
      " function sum(a, b) {",
      "   return a - b;",
      " }",
      "-module.exports = { sum };",
      "+module.exports = { sum };",
      "",
    ].join("\n");
    const result = await patchTool().handler({ diff }, ctx());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/changed nothing/);
    expect(readFileSync(join(workspaceOf(root), "sum.cjs"), "utf8")).toBe(SOURCE);
  });

  it("applies a right body under a miscounted header, as git apply --recount does, and says so", async () => {
    // The shape a real run sent repeatedly: `-2,5 +2,5` over a three-line body that is correct.
    writeFileSync(join(workspaceOf(root), "sum.cjs"), SOURCE);
    const diff = "--- a/sum.cjs\n+++ b/sum.cjs\n@@ -2,5 +2,5 @@\n function sum(a, b) {\n-  return a - b;\n+  return a + b;\n";
    const result = await patchTool().handler({ diff }, ctx());
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspaceOf(root), "sum.cjs"), "utf8")).toBe(SOURCE.replace("a - b", "a + b"));
    expect(JSON.stringify(result.output)).toMatch(/"hunksRecounted":1/);
  });

  it("still refuses a miscounted body whose context does not match the file", async () => {
    writeFileSync(join(workspaceOf(root), "sum.cjs"), SOURCE);
    const diff = "--- a/sum.cjs\n+++ b/sum.cjs\n@@ -2,5 +2,5 @@\n function sum(x, y) {\n-  return x - y;\n+  return x + y;\n";
    const result = await patchTool().handler({ diff }, ctx());
    expect(result.ok).toBe(false);
    expect(readFileSync(join(workspaceOf(root), "sum.cjs"), "utf8")).toBe(SOURCE);
  });

  it("accepts a doubled marker when the header counts it correctly — a Markdown list item is a real '+-' line", async () => {
    writeFileSync(join(workspaceOf(root), "notes.md"), "# Notes\n- one\n");
    const diff = "--- a/notes.md\n+++ b/notes.md\n@@ -1,2 +1,3 @@\n # Notes\n - one\n+- two\n";
    const result = await patchTool().handler({ diff }, ctx());
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspaceOf(root), "notes.md"), "utf8")).toBe("# Notes\n- one\n- two\n");
  });

  /**
   * The autonomous-completion pass's real run (qwen2.5:7b, fix_failing_test on sum.js). Two
   * diffs, both applied, which together left `sum.js` unparseable and without its export.
   */
  it("refuses a creation diff aimed at a file that already exists, instead of overwriting it", async () => {
    writeFileSync(join(workspaceOf(root), "sum.js"), SOURCE);
    const diff = "--- /dev/null\n+++ b/sum.js\n@@ -0,0 +1,3 @@\n+function sum(a, b) {\n++    return a + b;\n++}\n";
    const result = await patchTool().handler({ diff }, ctx());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/already exists.*code\.read_lines/s);
    expect(readFileSync(join(workspaceOf(root), "sum.js"), "utf8")).toBe(SOURCE);
  });

  it("refuses the run's second diff: a header of 2 old / 3 new over a body of 1 / 2", async () => {
    writeFileSync(join(workspaceOf(root), "sum.js"), SOURCE);
    const diff = "--- a/sum.js\n+++ b/sum.js\n@@ -1,2 +1,3 @@\n-function sum(a, b) {\n+function sum(a, b) {\n++    return a + b;\n";
    const result = await patchTool().handler({ diff }, ctx());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/Malformed hunk.*two diff markers/s);
    expect(readFileSync(join(workspaceOf(root), "sum.js"), "utf8")).toBe(SOURCE);
  });

  it("refuses a diff with no file headers, and points at code.replace_text", async () => {
    // Verbatim from a later real run: bare -/+ lines, no `---`/`+++`, no `@@`.
    writeFileSync(join(workspaceOf(root), "sum.js"), SOURCE);
    const diff = "-function sum(a, b) {\n+function sum(a, b) {\n+  return a + b;\n+";
    const result = await patchTool().handler({ diff }, ctx());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/no file headers.*code\.replace_text/s);
    expect(readFileSync(join(workspaceOf(root), "sum.js"), "utf8")).toBe(SOURCE);
  });

  it("names the files that DO exist when the model edits one that does not, in every edit tool", async () => {
    // Verbatim from a real run: the source is sum.js, the model worked on "sum.cjs" for seven turns.
    writeFileSync(join(workspaceOf(root), "sum.js"), SOURCE);
    writeFileSync(join(workspaceOf(root), "sum.test.cjs"), "require('./sum.js');\n");
    const tool = (id: string) => createCodingTools(root).find((t) => t.definition.id === id)!;

    const read = await tool("code.read_lines").handler({ path: "sum.cjs", startLine: 1, endLine: 5 }, ctx());
    const replace = await tool("code.replace_text").handler({ path: "sum.cjs", oldText: "a - b", newText: "a + b" }, ctx());
    const patch = await patchTool().handler(
      { diff: "--- a/sum.cjs\n+++ b/sum.cjs\n@@ -2 +2 @@\n-  return a - b;\n+  return a + b;\n" },
      ctx()
    );

    for (const result of [read, replace, patch]) {
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/"sum\.cjs" does not exist\. Files in "\.": sum\.js, sum\.test\.cjs/);
      // Names relative to the workspace, never the deployment's absolute layout.
      expect(String(result.error)).not.toContain(root);
    }
    // And the file that does exist is untouched by any of it.
    expect(readFileSync(join(workspaceOf(root), "sum.js"), "utf8")).toBe(SOURCE);
  });

  it("says which line did not match, and that it differs only in indentation", async () => {
    // Verbatim from a real run: six spaces where the file has two, reported as "the file has changed".
    writeFileSync(join(workspaceOf(root), "sum.js"), SOURCE);
    const diff = "--- a/sum.js\n+++ b/sum.js\n@@ -2,4 +2,4 @@\n-      return a - b;\n+      return a + b;\n  }";
    const result = await patchTool().handler({ diff }, ctx());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('"      return a - b;" is not in the file, which has "  return a - b;"');
    expect(String(result.error)).toMatch(/different indentation.*code\.replace_text/s);
    expect(String(result.error)).not.toMatch(/has changed since/);
    expect(readFileSync(join(workspaceOf(root), "sum.js"), "utf8")).toBe(SOURCE);
  });

  it("code.replace_text says when oldText differs only in indentation, and shows the file's text (DL-25)", async () => {
    // Verbatim from the final compose run: four spaces where the file has two, five times in a
    // row. The patch tool said "different indentation"; this tool only said "not found", and the
    // run ended at its turn limit on a one-character fix.
    writeFileSync(join(workspaceOf(root), "sum.js"), SOURCE);
    const tool = createCodingTools(root).find((t) => t.definition.id === "code.replace_text")!;
    const result = await tool.handler({ path: "sum.js", oldText: "    return a - b;", newText: "    return a + b;" }, ctx());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/different indentation/);
    expect(String(result.error)).toContain('"  return a - b;"');
    expect(String(result.error)).toMatch(/line 2/);
    // Diagnosis only: nothing is applied on a guess.
    expect(readFileSync(join(workspaceOf(root), "sum.js"), "utf8")).toBe(SOURCE);
  });

  it("code.replace_text keeps the plain answer when the text is not there at all", async () => {
    writeFileSync(join(workspaceOf(root), "sum.js"), SOURCE);
    const tool = createCodingTools(root).find((t) => t.definition.id === "code.replace_text")!;
    const result = await tool.handler({ path: "sum.js", oldText: "return a * b;", newText: "return a + b;" }, ctx());
    expect(String(result.error)).toMatch(/was not found/);
    expect(String(result.error)).not.toMatch(/indentation\b.*line \d/);
  });

  it("applies a diff that really changes the line", async () => {
    // The guard must not refuse the fix the agent was actually supposed to make.
    writeFileSync(join(workspaceOf(root), "sum.cjs"), SOURCE);
    const diff = [
      "--- a/sum.cjs",
      "+++ b/sum.cjs",
      "@@ -1,3 +1,3 @@",
      " function sum(a, b) {",
      "-  return a - b;",
      "+  return a + b;",
      " }",
      "",
    ].join("\n");

    const result = await patchTool().handler({ diff }, ctx());

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspaceOf(root), "sum.cjs"), "utf8")).toContain("return a + b;");
  });

  it("still creates a new file, which has nothing to compare against", async () => {
    const diff = [
      "--- /dev/null",
      "+++ b/created.txt",
      "@@ -0,0 +1,1 @@",
      "+hello",
      "",
    ].join("\n");

    const result = await patchTool().handler({ diff }, ctx());
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspaceOf(root), "created.txt"), "utf8")).toContain("hello");
  });
});
