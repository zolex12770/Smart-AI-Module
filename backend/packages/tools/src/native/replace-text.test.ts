import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolInvocationContext } from "@ai-platform/shared";
import { createCodingTools } from "./coding.js";

/**
 * `code.replace_text` — the exact search-and-replace edit.
 *
 * Added after a real fix_failing_test run in which qwen2.5:7b read the right file and knew the
 * right change, then sent five unified diffs whose `@@` counts disagreed with their bodies. The
 * edit it wanted is exactly the one the first test performs.
 */
const PROJECT = "project-replace";
const SOURCE = "function sum(a, b) {\n  return a - b;\n}\n\nmodule.exports = { sum };\n";

describe("code.replace_text", () => {
  let root: string;
  let file: string;
  const ctx = (): ToolInvocationContext => ({ projectId: PROJECT, userId: "u" }) as ToolInvocationContext;
  const tool = () => createCodingTools(root).find((t) => t.definition.id === "code.replace_text")!;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "replace-text-"));
    mkdirSync(join(root, PROJECT), { recursive: true });
    file = join(root, PROJECT, "sum.js");
    writeFileSync(file, SOURCE);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("makes the edit the model was trying to make, and nothing else", async () => {
    const result = await tool().handler({ path: "sum.js", oldText: "return a - b;", newText: "return a + b;" }, ctx());
    expect(result.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(SOURCE.replace("a - b", "a + b"));
    expect(result.output).toMatchObject({ replacedAtLine: 2 });
  });

  it("refuses text that is not in the file — a stale or imagined version — and changes nothing", async () => {
    const result = await tool().handler({ path: "sum.js", oldText: "return a * b;", newText: "return a + b;" }, ctx());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/not found.*code\.read_lines/s);
    expect(readFileSync(file, "utf8")).toBe(SOURCE);
  });

  it("refuses text copied WITH its line number from code.read_lines", async () => {
    const result = await tool().handler({ path: "sum.js", oldText: "2\t  return a - b;", newText: "  return a + b;" }, ctx());
    expect(result.ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(SOURCE);
  });

  it("refuses an ambiguous edit, saying how many times the text occurs", async () => {
    writeFileSync(file, "x = 1;\nx = 1;\n");
    const result = await tool().handler({ path: "sum.js", oldText: "x = 1;", newText: "x = 2;" }, ctx());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/occurs 2 times/);
    expect(readFileSync(file, "utf8")).toBe("x = 1;\nx = 1;\n");
  });

  it("refuses an edit that changes nothing, rather than reporting it done", async () => {
    const result = await tool().handler({ path: "sum.js", oldText: "return a - b;", newText: "return a - b;" }, ctx());
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/identical/);
  });

  it("does not create files, and does not escape the workspace", async () => {
    const missing = await tool().handler({ path: "nope.js", oldText: "a", newText: "b" }, ctx());
    expect(missing.ok).toBe(false);
    expect(String(missing.error)).toMatch(/does not exist/);
    writeFileSync(join(root, "outside.txt"), "secret\n");
    const escape = await tool().handler({ path: "../outside.txt", oldText: "secret", newText: "owned" }, ctx());
    expect(escape.ok).toBe(false);
    expect(readFileSync(join(root, "outside.txt"), "utf8")).toBe("secret\n");
  });

  it("keeps a CRLF file CRLF when the model sends LF", async () => {
    writeFileSync(file, "a\r\nb\r\nc\r\n");
    const result = await tool().handler({ path: "sum.js", oldText: "a\nb", newText: "a\nB" }, ctx());
    expect(result.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("a\r\nB\r\nc\r\n");
  });
});
