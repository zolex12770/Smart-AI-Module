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

  it("refuses the exact no-op diff the failed run produced", async () => {
    writeFileSync(join(workspaceOf(root), "sum.cjs"), SOURCE);

    // Byte-for-byte the model's own diff: the `+` line repeats the `-` line, and the real bug
    // (`a - b`) is never touched.
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
    expect(String(result.error)).toMatch(/changed nothing|byte-for-byte identical/i);
    // And the file is untouched, rather than rewritten with identical content.
    expect(readFileSync(join(workspaceOf(root), "sum.cjs"), "utf8")).toBe(SOURCE);
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
