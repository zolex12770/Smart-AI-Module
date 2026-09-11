import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessSandbox } from "@ai-platform/security";
import { createTerminalTools } from "./terminal.js";

/**
 * docs/26_DECISIONS.md ADR-077 — the terminal tool must not hand a model the process's secrets.
 *
 * THIS IS A REGRESSION TEST FOR A REAL, DEMONSTRATED LEAK. `createTerminalTools` used to call
 * `spawn(command, args, { cwd, shell: false })`. Node gives a child the parent's entire
 * `process.env` when no `env` is supplied, so a command authored by a MODEL — the only kind this
 * tool ever runs — could read every provider key and the database URL by printing them. A probe
 * against that exact code path returned:
 *
 *   stdout: "sk-ant-CANARY-12345 | postgres://u:p@host/db"
 *
 * The canaries below are fake values chosen to be unmistakable in a diff or a log. The test runs
 * a REAL child process through the REAL sandbox: an assertion about how the spawn was configured
 * would pass against a mock while the process still leaked.
 */
describe("terminal.run_command environment isolation (ADR-077)", () => {
  let root: string;
  let workspace: string;
  const PROJECT_ID = "p1";
  const CANARIES = {
    ANTHROPIC_API_KEY: "sk-ant-CANARY-must-not-escape",
    OPENAI_API_KEY: "sk-CANARY-must-not-escape",
    DATABASE_URL: "postgres://canary:canary@localhost/canary",
    SESSION_SECRET: "CANARY-session-secret",
  };
  const saved: Record<string, string | undefined> = {};

  const tools = () => createTerminalTools(root, new ProcessSandbox(root));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "term-iso-"));
    // ADR-090: the tool resolves inside the project workspace, not the bare root.
    workspace = join(root, PROJECT_ID);
    mkdirSync(workspace, { recursive: true });
    for (const [key, value] of Object.entries(CANARIES)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(CANARIES)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** Writes a script into the sandbox and runs it the way the agent would. */
  async function runScript(source: string) {
    writeFileSync(join(workspace, "probe.js"), source);
    const [tool] = tools();
    return tool.handler({ command: "node", args: ["probe.js"] }, {
      projectId: PROJECT_ID,
      userId: "u1",
    });
  }

  it("does not pass the parent's secrets to the child", async () => {
    const result = await runScript(
      'console.log(JSON.stringify({a: process.env.ANTHROPIC_API_KEY ?? null, o: process.env.OPENAI_API_KEY ?? null, d: process.env.DATABASE_URL ?? null, s: process.env.SESSION_SECRET ?? null}));'
    );

    expect(result.ok).toBe(true);
    const stdout = (result.output as { stdout: string }).stdout;
    const seen = JSON.parse(stdout.trim());
    // Every one absent. Not redacted, not masked — absent, because the sandbox builds the
    // child's environment from scratch rather than filtering the parent's.
    expect(seen).toEqual({ a: null, o: null, d: null, s: null });
  });

  it("leaks nothing even when the child dumps its ENTIRE environment", async () => {
    // The stronger claim, and the one that survives someone adding a new secret later: an
    // allow-list of names to strip would have to be updated for every new variable, and the one
    // nobody remembered is the one that leaks. This asserts on the whole environment instead.
    const result = await runScript("console.log(JSON.stringify(process.env));");
    expect(result.ok).toBe(true);

    const childEnv = JSON.parse((result.output as { stdout: string }).stdout.trim()) as Record<string, string>;
    const dumped = JSON.stringify(childEnv);
    for (const value of Object.values(CANARIES)) {
      expect(dumped).not.toContain(value);
    }
    // And the converse: it still gets what a process genuinely needs to run at all.
    expect(childEnv.PATH ?? childEnv.Path).toBeTruthy();
  });

  it("still returns a real non-zero exit code as a normal result", async () => {
    // The leak fix must not turn an informative failing-test run into a tool error — the coding
    // agent's whole loop depends on reading exit code 1 and the output that came with it.
    const result = await runScript('console.error("boom"); process.exit(3);');
    expect(result.ok).toBe(true);
    const output = result.output as { exitCode: number; stderr: string };
    expect(output.exitCode).toBe(3);
    expect(output.stderr).toContain("boom");
  });

  it("reports which isolation actually ran the command", async () => {
    const result = await runScript('console.log("ok");');
    // An operator reading a tool result must be able to tell a container run from a process
    // run; "it was sandboxed" means materially different things for the two.
    expect((result.output as { isolation: string }).isolation).toBe("process");
  });

  it("still refuses a flag-shaped argument", async () => {
    // The ADR-032 argument-injection fix must survive this refactor: `node --eval=<code>` is
    // arbitrary code execution that a command allow-list alone does not stop.
    const [tool] = tools();
    const result = await tool.handler(
      { command: "node", args: ["--eval=console.log(process.env)"] },
      { projectId: PROJECT_ID, userId: "u1" }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/flag/i);
  });

  it("still refuses a command outside the allow-list", async () => {
    const [tool] = tools();
    const result = await tool.handler(
      { command: "curl", args: ["https://example.com"] },
      { projectId: PROJECT_ID, userId: "u1" }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/allow-list/i);
  });
});
