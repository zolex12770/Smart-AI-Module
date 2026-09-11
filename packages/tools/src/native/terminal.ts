import { PERMISSION_LEVEL_DEFAULTS } from "@ai-platform/shared";
import { resolveSandboxedPath } from "./sandbox-path.js";
import type { NativeToolEntry } from "./filesystem.js";

/**
 * The execution surface this tool needs, named structurally.
 *
 * Structural rather than an import of `@ai-platform/security`'s `ExecutionSandbox` so that
 * `packages/tools` keeps no dependency on the security package — the composition root passes
 * the real sandbox in. There is deliberately NO default: a caller that supplies no sandbox gets
 * a compile error, not a quiet fallback to an unisolated `spawn`. That fallback is precisely the
 * bug this parameter exists to make impossible (ADR-077).
 */
export interface CommandSandbox {
  readonly isolation: "docker" | "process";
  run(request: {
    command: string;
    args: string[];
    workdir: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    cancelled: boolean;
    truncated: boolean;
  }>;
}

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
 * Arguments are passed as an array with `shell: false` all the way down — never string
 * concatenation into a shell command — so there is no shell-injection surface regardless
 * of what a model puts in `args`.
 *
 * THIS USED TO LEAK EVERY SECRET THE API PROCESS HELD (ADR-077).
 *
 * It called `spawn(command, args, { cwd, shell: false })` directly. Node passes the parent's
 * entire `process.env` to a child when no `env` is given, so a command authored by a MODEL —
 * which is the only kind this tool ever runs — could read `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 * `DATABASE_URL` and every session secret simply by printing them. Demonstrated, not theorised:
 * a probe run against this exact code path returned
 *
 *   stdout: "sk-ant-CANARY-12345 | postgres://u:p@host/db"
 *
 * The platform already had the correct machinery — `ExecutionSandbox` builds a minimal
 * environment from scratch and never inherits the parent's — and this tool simply did not use
 * it. That is the real defect: TWO execution paths existed, and the hardened one was not the one
 * wired into the tool registry. There is now one. Delegating also picks up, for free, everything
 * the ad-hoc spawn lacked: output caps, a real timeout, process-tree termination, and container
 * isolation when `SANDBOX_RUNTIME=docker`.
 */
const ALLOWED_COMMANDS = new Set(["node"]);

export function createTerminalTools(root: string, sandbox: CommandSandbox): NativeToolEntry[] {
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
          truncated: { type: "boolean" },
          isolation: { type: "string" },
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
    handler: async (args, context) => {
      const command = String(args.command ?? "");
      if (!ALLOWED_COMMANDS.has(command)) {
        return { ok: false, error: `Command "${command}" is not in the allow-list (${[...ALLOWED_COMMANDS].join(", ")}).` };
      }
      const cwd = resolveSandboxedPath(root, typeof args.cwd === "string" ? args.cwd : ".");
      const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];

      // docs/13_SECURITY_ARCHITECTURE.md §6/§11 — found the hard way (a real exploit run
      // against a live server, not a theoretical review): `node`'s own CLI parser treats a
      // single argv token like `--eval=<code>` as a flag, not a filename, so a plain
      // allow-list of the *command* alone does nothing to stop the *argument* from being
      // arbitrary code execution — `args: ["--eval=require('fs').readFileSync(...)"]`
      // genuinely read a file outside the sandbox in this exact code path before this fix.
      // A flag-shaped argument is never a legitimate use of this tool (its only real job is
      // `node <script-file>`), so any arg starting with "-" is rejected outright. Every
      // argument (not only the first) is additionally resolved through the same sandbox
      // boundary as `cwd`: today only `args[0]` is ever a real path (the planner only ever
      // sends one arg), but a plain string like a flag-free numeric or name argument still
      // resolves harmlessly under `cwd` when treated as a path, so validating all of them
      // uniformly costs nothing for legitimate callers while closing off a second-argument
      // path-escape for any future caller that passes more than one.
      for (const arg of cmdArgs) {
        if (arg.startsWith("-")) {
          return {
            ok: false,
            error: `Argument "${arg}" looks like a command-line flag, which this tool never legitimately needs — rejected.`,
          };
        }
        try {
          // Resolved relative to the already-sandboxed `cwd` — the same base Node itself
          // will use to resolve a path argument when it actually runs — not relative to
          // `root`, which would validate the wrong path for any non-root `cwd`.
          resolveSandboxedPath(root, arg, cwd);
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      // One execution path, and it is the hardened one (ADR-077). `env` is deliberately not
      // passed: the sandbox builds a minimal environment from scratch, so the parent's secrets
      // are absent by construction rather than by a filter someone has to keep updated.
      const result = await sandbox.run({
        command,
        args: cmdArgs,
        workdir: cwd,
        signal: context?.signal,
      });

      // A timeout or a cancellation is NOT a command that exited non-zero, and must not be
      // reported as one: a model told "exit code 1" concludes the tests failed and starts
      // "fixing" code that was never run. Both are tool failures, and they say which.
      if (result.timedOut) {
        return { ok: false, error: `Command "${command}" exceeded the sandbox time limit and was terminated.` };
      }
      if (result.cancelled) {
        return { ok: false, error: `Command "${command}" was cancelled before it finished.` };
      }

      return {
        ok: true,
        output: {
          exitCode: result.exitCode ?? -1,
          stdout: result.stdout,
          stderr: result.stderr,
          // Surfaced rather than hidden: a model reasoning about a truncated test log needs to
          // know the log is truncated, or it will draw confident conclusions from an ellipsis.
          truncated: result.truncated,
          isolation: sandbox.isolation,
        },
      };
    },
  };

  return [runCommandTool];
}
