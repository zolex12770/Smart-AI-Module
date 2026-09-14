import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProcessSandbox, processSandboxArgs, supportsPermissionModel } from "./sandbox.js";

/**
 * Process isolation actually contains the child — docs/26_DECISIONS.md ADR-117.
 *
 * Before this, `ProcessSandbox` set a working directory and an environment and nothing else. An
 * audit proved the consequence through the real tools: write a script with `fs.write_file`, run it
 * with `terminal.run_command`, and it read a host file outside the root, wrote another beside it,
 * listed every tenant's workspace, and resolved DNS — with no human approval anywhere, in the
 * default local configuration.
 *
 * These run REAL children. The exploit is re-run here as a test: the same read, the same write,
 * the same directory listing, the same attempt to spawn a helper — each must now be refused by the
 * runtime while ordinary work inside the workspace still succeeds.
 */
describe("processSandboxArgs", () => {
  it("confines a node child to its workspace", () => {
    const args = processSandboxArgs("node", ["script.js"], "/srv/work/p1", "24.0.0");
    expect(args[0]).toBe("--permission");
    expect(args).toContain("--allow-fs-read=/srv/work/p1");
    expect(args).toContain("--allow-fs-write=/srv/work/p1/*");
    // The script's own arguments still follow, unchanged and last.
    expect(args[args.length - 1]).toBe("script.js");
  });

  it("uses the flag the running Node understands", () => {
    expect(processSandboxArgs("node", ["s.js"], "/w", "22.11.0")[0]).toBe("--experimental-permission");
    expect(processSandboxArgs("node", ["s.js"], "/w", "23.0.0")[0]).toBe("--permission");
    // A runtime with no permission model gets no flags, and `supportsPermissionModel` says so.
    expect(processSandboxArgs("node", ["s.js"], "/w", "18.19.0")).toEqual(["s.js"]);
    expect(supportsPermissionModel("18.19.0")).toBe(false);
    expect(supportsPermissionModel("22.11.0")).toBe(true);
  });

  it("recognises node whatever path or extension it is invoked by", () => {
    expect(processSandboxArgs("/usr/local/bin/node", ["s.js"], "/w", "24.0.0")[0]).toBe("--permission");
    expect(processSandboxArgs("C:\\Program Files\\nodejs\\node.exe", ["s.js"], "/w", "24.0.0")[0]).toBe("--permission");
  });

  it("leaves a non-node command untouched — the flags are Node's own", () => {
    expect(processSandboxArgs("python", ["x.py"], "/w", "24.0.0")).toEqual(["x.py"]);
  });
});

describe.skipIf(!supportsPermissionModel())("ProcessSandbox against a real child", () => {
  let root: string;
  let workspace: string;
  let outsideFile: string;

  const run = (script: string, name = "probe.js") => {
    writeFileSync(join(workspace, name), script);
    return new ProcessSandbox(root).run({ command: process.execPath, args: [name], workdir: workspace });
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sandbox-perm-"));
    workspace = join(root, "project-1");
    mkdirSync(workspace, { recursive: true });
    // A host file outside the sandbox root, standing in for .env or another tenant's data.
    outsideFile = join(root, "..", `host-secret-${Date.now()}.txt`);
    writeFileSync(resolve(outsideFile), "HOST-SECRET-CANARY");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(resolve(outsideFile), { force: true });
  });

  it("still runs ordinary work inside the workspace", async () => {
    const result = await run(`require("node:fs").writeFileSync("out.txt", "written");\nconsole.log("READ:", require("node:fs").readFileSync("out.txt", "utf8"));`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("READ: written");
  }, 60_000);

  it("refuses to read a host file outside the workspace", async () => {
    const result = await run(
      `try { console.log("LEAKED:", require("node:fs").readFileSync(${JSON.stringify(resolve(outsideFile))}, "utf8")); } catch (e) { console.log("DENIED:", e.code); }`
    );
    expect(result.stdout).not.toContain("HOST-SECRET-CANARY");
    expect(result.stdout).toContain("DENIED: ERR_ACCESS_DENIED");
  }, 60_000);

  it("refuses to write outside the workspace", async () => {
    const target = join(root, "planted.txt");
    const result = await run(
      `try { require("node:fs").writeFileSync(${JSON.stringify(target)}, "planted"); console.log("PLANTED"); } catch (e) { console.log("DENIED:", e.code); }`
    );
    expect(result.stdout).toContain("DENIED: ERR_ACCESS_DENIED");
    expect(result.stdout).not.toContain("PLANTED");
  }, 60_000);

  it("refuses to list the deployment root, where every other tenant's workspace lives", async () => {
    const result = await run(
      `try { console.log("TENANTS:", require("node:fs").readdirSync(${JSON.stringify(root)}).join(",")); } catch (e) { console.log("DENIED:", e.code); }`
    );
    expect(result.stdout).toContain("DENIED: ERR_ACCESS_DENIED");
    expect(result.stdout).not.toContain("project-1");
  }, 60_000);

  it("refuses to spawn a helper process that would not be confined", async () => {
    const result = await run(
      `try { require("node:child_process").execSync("node -e \\"1\\""); console.log("SPAWNED"); } catch (e) { console.log("DENIED:", e.code || e.message); }`
    );
    expect(result.stdout).not.toContain("SPAWNED");
    expect(result.stdout).toMatch(/DENIED/);
  }, 60_000);
});
