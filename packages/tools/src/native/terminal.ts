import { spawn } from "node:child_process";
import { PERMISSION_LEVEL_DEFAULTS } from "@ai-platform/shared";
import { resolveSandboxedPath } from "./sandbox-path.js";
import type { NativeToolEntry } from "./filesystem.js";

/**
 * Sandboxed command execution — docs/13_SECURITY_ARCHITECTURE.md's command
 * allow/deny-listing requirement, docs/25_IMPLEMENTATION_ROADMAP.md Phase 5.
 *
 * Deliberately minimal allow-list for this increment (`node` only) — enough for the
 * real, verified "run tests, observe failure, fix, re-run" pipeline (PROJECT_STATUS.md).
 * Expanding to `npm`/`git` is straightforward future work once there's a concrete,
 * verified scenario that needs them; adding an unexercised allow-list entry now would
 * be untested attack surface, not a real capability.
 *
 * Uses `child_process.spawn` with `shell: false` and an argument array — never string
 * concatenation into a shell command — so there is no shell-injection surface regardless
 * of what a model puts in `args`.
 */
const ALLOWED_COMMANDS = new Set(["node"]);

export function createTerminalTools(root: string): NativeToolEntry[] {
  const defaults = PERMISSION_LEVEL_DEFAULTS.write_local;

  const runCommandTool: NativeToolEntry = {
    definition: {
      id: "terminal.run_command",
      name: "Run Command",
      description:
        `Runs an allow-listed command (currently: ${[...ALLOWED_COMMANDS].join(", ")}) with the given ` +
        "arguments inside the sandboxed workspace directory, and returns its exit code, stdout, and " +
        "stderr. A non-zero exit code is a normal, informative result (e.g. a failing test run) — it " +
        "does not by itself mean this tool call failed; only a rejected/disallowed command or a spawn " +
        "error does.",
      origin: { kind: "native", serverId: null, serverVersion: null },
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          exitCode: { type: "number" },
          stdout: { type: "string" },
          stderr: { type: "string" },
        },
      },
      permissionLevel: "write_local",
      riskLevel: defaults.riskLevel,
      requiresApproval: defaults.requiresApproval,
      timeoutMs: 30_000,
      // Never auto-retry running an arbitrary command — a flaky test or a command with
      // a real side effect could behave very differently the second time.
      retryPolicy: { maxAttempts: 1, backoff: "none", idempotencyRequired: false },
      enabled: true,
    },
    handler: async (args) => {
      const command = String(args.command ?? "");
      if (!ALLOWED_COMMANDS.has(command)) {
        return { ok: false, error: `Command "${command}" is not in the allow-list (${[...ALLOWED_COMMANDS].join(", ")}).` };
      }
      const cwd = resolveSandboxedPath(root, typeof args.cwd === "string" ? args.cwd : ".");
      const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];

      const result = await runProcess(command, cmdArgs, cwd);
      return { ok: true, output: result };
    },
  };

  return [runCommandTool];
}

function runProcess(
  command: string,
  args: string[],
  cwd: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}
