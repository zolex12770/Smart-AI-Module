import { resolve, sep } from "node:path";

/**
 * Path-traversal protection (docs/13_SECURITY_ARCHITECTURE.md). Every native filesystem
 * tool call goes through this before touching disk — a requested path that would resolve
 * outside `root` (via `..`, an absolute path, or a symlink-free lexical escape) is rejected
 * rather than silently clamped, so a bug here fails closed, not open.
 *
 * `resolutionBase` (defaults to `root`) is what `requestedPath` is resolved *relative to* —
 * distinct from `root`, which is what containment is checked *against*. This matters when a
 * tool has already moved into a validated subdirectory (e.g. `terminal.run_command`'s
 * sandboxed `cwd`) and needs to validate a further path exactly the way the OS will actually
 * resolve it (relative to that `cwd`), not relative to the sandbox root itself — resolving
 * against the wrong base would let a `../`-bearing argument pass this check while still
 * escaping in practice once the real process resolves it against its real working directory.
 */
export function resolveSandboxedPath(root: string, requestedPath: string, resolutionBase: string = root): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(resolve(resolutionBase), requestedPath);

  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(rootWithSep)) {
    throw new Error(
      `Path "${requestedPath}" resolves outside the sandboxed root and was rejected.`
    );
  }
  return resolvedTarget;
}
