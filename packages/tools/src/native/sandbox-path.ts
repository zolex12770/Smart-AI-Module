import { resolve, sep } from "node:path";

/**
 * Path-traversal protection (docs/13_SECURITY_ARCHITECTURE.md). Every native filesystem
 * tool call goes through this before touching disk — a requested path that would resolve
 * outside `root` (via `..`, an absolute path, or a symlink-free lexical escape) is rejected
 * rather than silently clamped, so a bug here fails closed, not open.
 */
export function resolveSandboxedPath(root: string, requestedPath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(resolvedRoot, requestedPath);

  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(rootWithSep)) {
    throw new Error(
      `Path "${requestedPath}" resolves outside the sandboxed root and was rejected.`
    );
  }
  return resolvedTarget;
}
