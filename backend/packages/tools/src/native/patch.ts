import { readFileSync, writeFileSync } from "node:fs";

/**
 * A real unified-diff applier — docs/26_DECISIONS.md ADR-062.
 *
 * The previous "coding agent" applied a single literal string replacement dictated by a
 * `FIX_NEEDED path=... find=... replace=...` directive that the failing test printed about
 * itself. That is not a coding agent: the fix was authored by the test, could not contain
 * whitespace, and could only touch one occurrence in one file. This module replaces it with
 * the representation models actually produce — a unified diff — applied with real hunk
 * matching.
 *
 * Deliberately hand-written rather than pulled from npm: applying a patch is the single most
 * destructive thing this platform does to a user's files, and the failure mode that matters
 * (a hunk that *almost* matches being applied to the wrong place) is a property of the
 * matching strategy, not of the parsing. Owning it means the strategy is explicit and
 * testable: exact match at the stated line, then a bounded search outward, then refusal.
 * Nothing is ever applied fuzzily, and a patch either applies completely or not at all.
 */

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each line prefixed with " " (context), "-" (removed) or "+" (added). */
  lines: string[];
}

export interface FilePatch {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
  /** True for a patch that creates the file (`--- /dev/null`). */
  isNewFile: boolean;
  isDeletedFile: boolean;
}

export class PatchError extends Error {}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(diff: string): FilePatch[] {
  const lines = diff.split(/\r\n|\n|\r/);
  const patches: FilePatch[] = [];
  let current: FilePatch | null = null;
  let hunk: Hunk | null = null;

  const closeHunk = () => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("--- ")) {
      closeHunk();
      const oldPath = stripPrefix(line.slice(4).trim());
      const nextLine = lines[i + 1] ?? "";
      if (!nextLine.startsWith("+++ ")) {
        throw new PatchError(`Malformed diff: a "---" line at ${i + 1} is not followed by "+++".`);
      }
      const newPath = stripPrefix(nextLine.slice(4).trim());
      i++;
      current = {
        oldPath,
        newPath,
        hunks: [],
        isNewFile: oldPath === "/dev/null",
        isDeletedFile: newPath === "/dev/null",
      };
      patches.push(current);
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header) {
      if (!current) throw new PatchError(`Malformed diff: a hunk at line ${i + 1} precedes any file header.`);
      closeHunk();
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      continue;
    }

    if (hunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
      hunk.lines.push(line);
      continue;
    }
    // "\ No newline at end of file" and diff/index/similarity headers are ignored.
  }
  closeHunk();

  if (patches.length === 0) throw new PatchError("The diff contained no file headers (expected `--- ` / `+++ `).");
  for (const patch of patches) {
    if (patch.hunks.length === 0 && !patch.isNewFile && !patch.isDeletedFile) {
      throw new PatchError(`The patch for "${patch.newPath}" contained no hunks.`);
    }
  }
  return patches;
}

function stripPrefix(path: string): string {
  // Strip a/ and b/ (git's convention) and any trailing tab-separated timestamp.
  const withoutTimestamp = path.split("\t")[0].trim();
  if (withoutTimestamp === "/dev/null") return withoutTimestamp;
  return withoutTimestamp.replace(/^[ab]\//, "");
}

export interface ApplyResult {
  content: string;
  hunksApplied: number;
  /** Line offsets where a hunk matched away from its stated position. */
  offsets: number[];
}

/**
 * Applies one file's hunks to its content. Throws rather than guessing: if a hunk's context
 * does not match exactly at its stated line or within `searchRadius` lines of it, the whole
 * patch is refused. A partially-applied patch is worse than a rejected one.
 */
export function applyPatchToContent(content: string, patch: FilePatch, searchRadius = 40): ApplyResult {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = content.endsWith("\n") || content.endsWith("\r\n") || content.length === 0;
  const lines = content.length === 0 ? [] : content.split(/\r\n|\n|\r/);
  if (hadTrailingNewline && lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const offsets: number[] = [];
  let drift = 0;

  for (const hunk of patch.hunks) {
    const expected = hunk.lines.filter((l) => l.startsWith(" ") || l.startsWith("-")).map((l) => l.slice(1));
    const replacement = hunk.lines.filter((l) => l.startsWith(" ") || l.startsWith("+")).map((l) => l.slice(1));

    // 1-based in the diff, 0-based here; `drift` accounts for earlier hunks changing length.
    const stated = hunk.oldStart - 1 + drift;
    const at = findMatch(lines, expected, stated, searchRadius);
    if (at === -1) {
      throw new PatchError(
        `Hunk @@ -${hunk.oldStart},${hunk.oldLines} @@ does not match "${patch.newPath}" at or near line ${hunk.oldStart}. ` +
          `The file has changed since the diff was produced; re-read it and generate a fresh patch.`
      );
    }
    if (at !== stated) offsets.push(at - stated);

    lines.splice(at, expected.length, ...replacement);
    drift += replacement.length - expected.length;
  }

  const joined = lines.join(eol);
  return {
    content: hadTrailingNewline && joined.length > 0 ? joined + eol : joined,
    hunksApplied: patch.hunks.length,
    offsets,
  };
}

/** Exact context match at the stated line, then an outward search. Never fuzzy. */
function findMatch(lines: string[], expected: string[], stated: number, radius: number): number {
  if (expected.length === 0) return Math.max(0, Math.min(stated, lines.length));
  const matchesAt = (start: number) =>
    start >= 0 &&
    start + expected.length <= lines.length &&
    expected.every((line, i) => lines[start + i] === line);

  if (matchesAt(stated)) return stated;
  for (let delta = 1; delta <= radius; delta++) {
    if (matchesAt(stated - delta)) return stated - delta;
    if (matchesAt(stated + delta)) return stated + delta;
  }
  return -1;
}

export interface AppliedFile {
  path: string;
  action: "modified" | "created" | "deleted";
  hunksApplied: number;
  offsets: number[];
}

/**
 * Applies a whole multi-file diff atomically: every file is read and patched in memory
 * first, and nothing is written unless every hunk in every file applied. A patch that half
 * succeeds leaves a repository in a state neither the model nor the user can reason about.
 */
export function applyUnifiedDiff(
  diff: string,
  resolvePath: (relativePath: string) => string,
  fs: { readFileSync: typeof readFileSync; writeFileSync: typeof writeFileSync; rmSync?: (p: string) => void } = {
    readFileSync,
    writeFileSync,
  }
): AppliedFile[] {
  const patches = parseUnifiedDiff(diff);
  const staged: Array<{ absolute: string; content: string | null; result: AppliedFile }> = [];

  for (const patch of patches) {
    const relative = patch.isDeletedFile ? patch.oldPath : patch.newPath;
    const absolute = resolvePath(relative);

    if (patch.isDeletedFile) {
      staged.push({ absolute, content: null, result: { path: relative, action: "deleted", hunksApplied: patch.hunks.length, offsets: [] } });
      continue;
    }

    let existing = "";
    if (!patch.isNewFile) {
      try {
        existing = fs.readFileSync(absolute, "utf8") as string;
      } catch {
        throw new PatchError(`Cannot patch "${relative}": the file does not exist. Use a /dev/null diff to create it.`);
      }
    }
    const applied = applyPatchToContent(existing, patch);

    /**
     * A diff that changes nothing is refused — docs/26_DECISIONS.md ADR-145.
     *
     * Observed in a real coding run: the model sent a hunk whose `-` and `+` lines were the same
     * text (`-module.exports = { sum };` / `+module.exports = { sum };`), leaving the actual bug
     * untouched. Every hunk matched, so the tool answered `hunksApplied: 1, action: "modified"` —
     * accurate, and useless. The model read it as "the fix is applied" and spent the rest of its
     * budget elsewhere while the file still held the original defect.
     *
     * Reporting work that did not happen is the failure mode this platform refuses everywhere
     * else, and it is worse here than a plain error: the caller is a model, and a false success
     * removes the one signal that would have made it look again.
     */
    if (!patch.isNewFile && applied.content === existing) {
      throw new PatchError(
        `The diff for "${relative}" applied cleanly but changed nothing — every hunk's "+" lines ` +
          `match its "-" lines, so the file is byte-for-byte identical. Check that the line you ` +
          `meant to change is the one the hunk actually replaces.`
      );
    }

    staged.push({
      absolute,
      content: applied.content,
      result: {
        path: relative,
        action: patch.isNewFile ? "created" : "modified",
        hunksApplied: applied.hunksApplied,
        offsets: applied.offsets,
      },
    });
  }

  // Every hunk matched — only now does anything touch disk.
  for (const item of staged) {
    if (item.content === null) fs.rmSync?.(item.absolute);
    else fs.writeFileSync(item.absolute, item.content, "utf8");
  }
  return staged.map((s) => s.result);
}
