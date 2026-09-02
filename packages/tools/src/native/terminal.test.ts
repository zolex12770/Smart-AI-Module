import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolHandler } from "@ai-platform/shared";
import { createTerminalTools } from "./terminal.js";

/**
 * Regression test for a real, live vulnerability found during Phase 11 security hardening
 * (docs/26_DECISIONS.md, docs/13_SECURITY_ARCHITECTURE.md §6/§11) — not a theoretical
 * review finding. Before the fix, `terminal.run_command`'s `args` were passed to `node`
 * completely unvalidated; `node`'s own CLI parser treats a single argv token like
 * `--eval=<code>` as a flag rather than a filename, so `args: ["--eval=..."]` was genuine
 * arbitrary code execution — confirmed directly against a running server by reading a file
 * planted outside the sandbox root via exactly this path before the fix existed.
 */
describe("terminal.run_command security", () => {
  let root: string;
  let runCommand: ToolHandler;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "terminal-test-"));
    const [tool] = createTerminalTools(root);
    runCommand = tool.handler;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a command outside the allow-list", async () => {
    const result = await runCommand({ command: "bash", args: ["-c", "echo pwned"] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in the allow-list/);
  });

  it("rejects a flag-shaped argument (the real --eval= exploit) even for an allow-listed command", async () => {
    const outsideFile = join(tmpdir(), `terminal-test-secret-${Date.now()}.txt`);
    writeFileSync(outsideFile, "SECRET_OUTSIDE_SANDBOX");
    try {
      const result = await runCommand({
        command: "node",
        args: [`--eval=console.log(require("fs").readFileSync(${JSON.stringify(outsideFile)},"utf8"))`],
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/looks like a command-line flag/);
    } finally {
      rmSync(outsideFile, { force: true });
    }
  });

  it("rejects a leading-dash-free path-traversal escape in the script argument", async () => {
    const result = await runCommand({ command: "node", args: ["../../../etc/passwd"] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/resolves outside/);
  });

  it("rejects a path-traversal escape in a SECOND argument too, not only the first", async () => {
    writeFileSync(join(root, "ok.js"), "");
    const result = await runCommand({ command: "node", args: ["ok.js", "../../../etc/passwd"] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/resolves outside/);
  });

  it("does not reject a legitimate flag-free non-path second argument", async () => {
    writeFileSync(join(root, "echo-arg.js"), "console.log(process.argv[2]);");
    const result = await runCommand({ command: "node", args: ["echo-arg.js", "42"] });
    expect(result.ok).toBe(true);
    const output = result.output as { exitCode: number; stdout: string };
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("42");
  });

  it("still runs a legitimate real script inside the sandbox (no regression)", async () => {
    writeFileSync(join(root, "ok.js"), 'console.log("real script output");');
    const result = await runCommand({ command: "node", args: ["ok.js"] });
    expect(result.ok).toBe(true);
    const output = result.output as { exitCode: number; stdout: string };
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("real script output");
  });

  it("still runs a legitimate script from a sandboxed subdirectory cwd (no regression)", async () => {
    const sub = join(root, "coding-demo");
    mkdirSync(sub);
    writeFileSync(join(sub, "math.test.js"), 'console.log("PASS");');
    const result = await runCommand({ command: "node", args: ["math.test.js"], cwd: "coding-demo" });
    expect(result.ok).toBe(true);
    const output = result.output as { exitCode: number; stdout: string };
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("PASS");
  });
});
