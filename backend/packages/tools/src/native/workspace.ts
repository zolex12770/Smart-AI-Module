import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ToolInvocationContext } from "@ai-platform/shared";

/**
 * The agent workspace for ONE project — docs/26_DECISIONS.md ADR-090.
 *
 * WHAT WAS SHARED. `SANDBOX_ROOT` is a single directory (`./data/sandbox` by default) and every
 * native filesystem tool was constructed with it and then ignored the invocation context
 * entirely. So every tenant's agent read and wrote the same directory: project A's agent could
 * read a file project B's agent had just written, overwrite it, or delete it — simply by naming
 * it. `ToolInvocationContext.projectId` was threaded all the way to the handlers and never used.
 *
 * That is the one place in the platform where the `project_id` predicate that IS the
 * authorization model (ADR-049) had no equivalent. Every repository takes a project and puts it
 * in the SQL `WHERE`; the filesystem had no `WHERE` at all.
 *
 * Containment still runs on top of this (ADR-088 resolves symlinks before checking), and it
 * checks against the DEPLOYMENT root rather than the project's subdirectory. That is deliberate
 * and worth stating: this function decides which directory a tool operates in, and
 * `resolveSandboxedPath` decides what may not be escaped. Narrowing containment to the project
 * directory as well would be stricter still, and is a separate change — the escape that matters
 * today is leaving the deployment root entirely.
 */

/**
 * A project id is going into a filesystem path, so it is validated rather than trusted.
 *
 * Ids are UUIDs minted by this platform's own database, so in practice this never rejects
 * anything — which is exactly why it is here. The day something else supplies one (an import, a
 * migration, a future external id), `../` in that field would be a path traversal that the
 * containment check might not catch, because the traversal would be in the ROOT rather than in
 * the requested path.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function projectWorkspace(deploymentRoot: string, context: Pick<ToolInvocationContext, "projectId">): string {
  const projectId = context.projectId;
  if (!projectId || !SAFE_ID.test(projectId)) {
    throw new Error("Tool invocation has no usable project scope, so no workspace could be resolved.");
  }

  const dir = join(deploymentRoot, projectId);
  // Created on demand rather than at boot: the set of projects is not known when the tools are
  // constructed, and a read of a directory that has never been written to should report an empty
  // workspace rather than ENOENT.
  mkdirSync(dir, { recursive: true });
  return dir;
}
