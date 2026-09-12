import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/**
 * Path-traversal protection (docs/13_SECURITY_ARCHITECTURE.md §11). Every native filesystem tool
 * call goes through this before touching disk — a requested path that would resolve outside
 * `root` is rejected rather than silently clamped, so a bug here fails closed, not open.
 *
 * `resolutionBase` (defaults to `root`) is what `requestedPath` is resolved *relative to* —
 * distinct from `root`, which is what containment is checked *against*. This matters when a tool
 * has already moved into a validated subdirectory (e.g. `terminal.run_command`'s sandboxed `cwd`)
 * and needs to validate a further path exactly the way the OS will actually resolve it (relative
 * to that `cwd`), not relative to the sandbox root itself — resolving against the wrong base would
 * let a `../`-bearing argument pass this check while still escaping in practice once the real
 * process resolves it against its real working directory.
 *
 * THIS USED TO BE LEXICAL ONLY, AND A SYMLINK WALKED STRAIGHT OUT OF THE SANDBOX (ADR-088).
 *
 * The previous implementation compared `path.resolve()` output as a string, and its own docstring
 * acknowledged it handled only "a symlink-free lexical escape" — while docs/13 §11 requires
 * "reject ... symlink escapes (resolve symlinks before the containment check)" and
 * `backend/packages/security/src/sandbox.ts`'s `assertContained` had been doing exactly that all along.
 * Two containment implementations, and the one the filesystem tools used was the weak one — the
 * same shape of defect as ADR-077's two execution paths.
 *
 * It was not theoretical. A probe created a symlink inside the workspace pointing at a directory
 * outside it and called `fs.read_file` through the real tool:
 *
 *     RESULT: {"ok":true,"output":{"content":"TOP SECRET HOST FILE CONTENTS", ...}}
 *
 * An agent can create that symlink itself with the write tools it already holds, or find one in a
 * repository it was asked to work on. Either way it reads or writes any file the API process can.
 *
 * WHY THE DEEPEST EXISTING ANCESTOR. `realpathSync` throws on a path that does not exist yet, and
 * this function must also validate the destination of a WRITE that creates a new file. So the walk
 * below resolves the deepest ancestor that does exist — which is where any symlink must live, since
 * a component that does not exist cannot be one — and re-appends the not-yet-existing tail.
 * Checking containment on that composite is exactly as strong as checking the final path, without
 * requiring it to exist.
 */
export function resolveSandboxedPath(root: string, requestedPath: string, resolutionBase: string = root): string {
  // The root itself is resolved through symlinks too. On macOS `/tmp` is a symlink to
  // `/private/tmp`, so a root under it would never match a realpath'd target and every legitimate
  // call would be rejected — failing closed, but uselessly.
  const resolvedRoot = realpathOrSelf(resolve(root));
  const lexicalTarget = resolve(resolve(resolutionBase), requestedPath);
  const realTarget = realpathOfDeepestExisting(lexicalTarget);

  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (realTarget !== resolvedRoot && !realTarget.startsWith(rootWithSep)) {
    // The message deliberately does not echo the resolved destination: it is a path outside the
    // sandbox, and telling the caller (a model, possibly following a prompt injection) where its
    // symlink actually pointed hands back information the sandbox exists to withhold.
    throw new Error(`Path "${requestedPath}" resolves outside the sandboxed root and was rejected.`);
  }

  // The LEXICAL path is returned, not the real one. Callers pass it back to `fs` operations, and a
  // legitimate symlink *inside* the sandbox should keep behaving like the link the caller named —
  // containment is what had to be checked against the real destination, not the path used to open.
  return lexicalTarget;
}

/**
 * `realpathSync` on the deepest ancestor of `target` that exists, with the remaining components
 * appended unresolved.
 *
 * A component that does not exist cannot be a symlink, so nothing is missed by leaving the tail
 * lexical — and `..` has already been collapsed by `path.resolve` before this runs.
 */
function realpathOfDeepestExisting(target: string): string {
  let existing = target;
  const missing: string[] = [];

  for (;;) {
    try {
      const real = realpathSync(existing);
      return missing.length === 0 ? real : resolve(real, ...missing.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) {
        // Walked to the filesystem root without finding anything that exists. Nothing can be a
        // symlink, so the lexical path is already the real one.
        return target;
      }
      missing.push(existing.slice(parent.length + 1));
      existing = parent;
    }
  }
}

/** `realpathSync`, or the input when the path does not exist — used for the root. */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
