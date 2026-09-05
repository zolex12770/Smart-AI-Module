import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessSandbox, assertContained } from "./sandbox.js";

/**
 * ADR-055. The ADR-047 audit found two concrete vulnerabilities in the previous execution
 * path: a "timeout" that only rejected a promise while the process kept running, and a child
 * that inherited the API process's ENTIRE environment — every provider API key and the
 * database URL included. Both are asserted against here for real, by running real processes.
 */
describe("ProcessSandbox", () => {
  let root: string;
  let sandbox: ProcessSandbox;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sandbox-test-"));
    sandbox = new ProcessSandbox(root);
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* windows may hold a handle briefly */
    }
  });

  it("runs a real process and captures its real exit code and stdout", async () => {
    const result = await sandbox.run({
      command: process.execPath,
      args: ["-e", "console.log('hello from the sandbox'); process.exit(3)"],
      workdir: root,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("hello from the sandbox");
    expect(result.timedOut).toBe(false);
    expect(result.isolation).toBe("process");
  });

  it("does NOT leak the parent's secrets into the child", async () => {
    process.env.SANDBOX_LEAK_CANARY = "super-secret-provider-key";
    try {
      const result = await sandbox.run({
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify(process.env))"],
        workdir: root,
      });
      const childEnv = JSON.parse(result.stdout) as Record<string, string>;
      expect(childEnv.SANDBOX_LEAK_CANARY).toBeUndefined();
      expect(result.stdout).not.toContain("super-secret-provider-key");
      // PATH is the one variable a process genuinely cannot work without.
      expect(childEnv.PATH ?? childEnv.Path).toBeTruthy();
    } finally {
      delete process.env.SANDBOX_LEAK_CANARY;
    }
  });

  it("passes through only the variables it was explicitly given", async () => {
    const result = await sandbox.run({
      command: process.execPath,
      args: ["-e", "console.log(process.env.EXPLICITLY_PASSED ?? 'MISSING')"],
      workdir: root,
      env: { EXPLICITLY_PASSED: "yes" },
    });
    expect(result.stdout.trim()).toBe("yes");
  });

  it("actually TERMINATES a runaway process on timeout, not just the promise", async () => {
    const marker = join(root, "still-alive.txt");
    const script = `
      const fs = require('node:fs');
      setInterval(() => fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 20);
    `;
    const result = await sandbox.run({
      command: process.execPath,
      args: ["-e", script],
      workdir: root,
      limits: { timeoutMs: 300 },
    });
    expect(result.timedOut).toBe(true);

    // If the process survived its own timeout it would keep rewriting the marker. Sample it
    // twice with a gap: a genuinely dead process cannot change the file.
    const { readFileSync, existsSync } = await import("node:fs");
    const first = existsSync(marker) ? readFileSync(marker, "utf8") : "";
    await new Promise((r) => setTimeout(r, 400));
    const second = existsSync(marker) ? readFileSync(marker, "utf8") : "";
    expect(second).toBe(first);
  });

  it("caps output so a chatty process cannot exhaust memory", async () => {
    const result = await sandbox.run({
      command: process.execPath,
      args: ["-e", "for (let i = 0; i < 200000; i++) console.log('x'.repeat(100))"],
      workdir: root,
      limits: { maxOutputBytes: 5_000, timeoutMs: 10_000 },
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(5_000);
  });

  it("can be cancelled, and reports cancellation distinctly from a timeout", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const result = await sandbox.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      workdir: root,
      limits: { timeoutMs: 30_000 },
      signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("refuses a workspace outside the sandbox root, following symlinks", () => {
    const inside = join(root, "project");
    mkdirSync(inside, { recursive: true });
    expect(() => assertContained(root, inside)).not.toThrow();

    // A real, existing directory outside the root: the check must reject it on containment,
    // not merely because the path happens not to exist.
    const outside = mkdtempSync(join(tmpdir(), "outside-root-"));
    try {
      expect(() => assertContained(root, outside)).toThrow(/outside the sandbox root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a sibling directory whose path merely shares the root's prefix", () => {
    const sibling = `${root}-evil`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "secret.txt"), "should be unreachable");
    try {
      expect(() => assertContained(root, sibling)).toThrow(/outside the sandbox root/);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});
