import { resolve } from "node:path";
import type { ToolInvocationContext } from "@ai-platform/shared";
import { resolveSandboxedPath } from "./sandbox-path.js";
import { projectWorkspace } from "./workspace.js";

/**
 * Paths a run may read but not change — the autonomous-completion pass.
 *
 * `fix_failing_test` tells the model "fix the source, not the test", and a real run
 * (qwen2.5:7b) went straight for `sum.test.cjs` anyway; the edit failed only because its text
 * carried line numbers. An instruction the model may ignore is not a guarantee, so the task's
 * test is handed to the tools as read-only and every write path checks it here.
 */
export class ReadOnlyPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyPathError";
  }
}

export function assertWritable(root: string, context: ToolInvocationContext, absolute: string): void {
  const paths = context.readOnlyPaths ?? [];
  if (paths.length === 0) return;
  const workspace = projectWorkspace(root, context);
  const target = resolve(absolute);
  for (const relative of paths) {
    let guarded: string;
    try {
      guarded = resolve(resolveSandboxedPath(workspace, relative));
    } catch {
      continue; // a protected path that cannot exist inside the workspace protects nothing
    }
    if (guarded === target) {
      throw new ReadOnlyPathError(
        `"${relative}" is read-only for this task: it is the test the task has to make pass. ` +
          `Change the source code it exercises instead — never edit the test to agree with the code.`
      );
    }
  }
}
