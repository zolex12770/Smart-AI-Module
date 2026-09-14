import { lstatSync, readlinkSync, realpathSync } from "node:fs";
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
 * A component that does not exist cannot be a symlink — but a DANGLING one is not that case, and
 * assuming it was is how this leaked (ADR-125). `realpathSync` throws ENOENT on a link whose
 * target is missing exactly as it does on a name that was never there, so the old catch filed the
 * link under "does not exist", re-appended its own basename to the resolved parent, and produced
 * a composite comfortably inside the root. Containment passed; the OS then followed the link
 * wherever it actually pointed. An agent can create such a link with the write tools it already
 * holds, so this was a self-service escape.
 *
 * A dangling link is now followed by hand — which is what `realpathSync` would have done had the
 * target existed — and containment is checked against where it leads. A link pointing at a file
 * that does not exist YET but sits inside the root stays legal, because creating a file through a
 * symlink is ordinary and the check is about destination, not existence.
 */
function realpathOfDeepestExisting(target: string): string {
  let existing = target;
  const missing: string[] = [];
  let hops = 0;

  for (;;) {
    try {
      const real = realpathSync(existing);
      return missing.length === 0 ? real : resolve(real, ...missing.reverse());
    } catch {
      const link = readLinkOrUndefined(existing);
      if (link !== undefined) {
        // A symlink chain can be circular, and following one forever is a hang inside a
        // security check. The OS gives up too (ELOOP); so does this, by rejecting.
        if (++hops > MAX_SYMLINK_HOPS) {
          throw new Error(`Path "${target}" resolves through too many symbolic links and was rejected.`);
        }
        // Relative link targets resolve against the link's OWN directory, not the cwd.
        existing = resolve(dirname(existing), link);
        continue;
      }

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

/** Linux gives up at 40; the sandbox has no legitimate need for a chain remotely that long. */
const MAX_SYMLINK_HOPS = 40;

/**
 * The link's target if `path` is a symbolic link, otherwise undefined.
 *
 * `lstatSync` is what distinguishes "this name is a link whose target is missing" from "this name
 * is not there at all" — `realpathSync` reports both as ENOENT, and the difference is the whole
 * defect this guards.
 */
function readLinkOrUndefined(path: string): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined;
    return readlinkSync(path);
  } catch {
    return undefined;
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
