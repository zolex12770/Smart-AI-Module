import { readdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { PERMISSION_LEVEL_DEFAULTS, type ToolDefinition, type ToolInvocationContext } from "@ai-platform/shared";
import { resolveSandboxedPath } from "./sandbox-path.js";
import { projectWorkspace } from "./workspace.js";
import type { NativeToolEntry } from "./filesystem.js";

/**
 * Repository understanding for the coding agent — docs/26_DECISIONS.md ADR-062, product
 * brief §10.
 *
 * The ADR-047 audit recorded that FR-010 ("read and search an existing repository's files…
 * answer 'where is X defined'") was not met at all, because the only filesystem tools were
 * read/list/write/delete: there was no way to search. A model cannot navigate a codebase it
 * can only list one directory at a time.
 *
 * These are deliberately plain implementations over `node:fs` rather than a shell-out to
 * ripgrep: the sandbox forbids arbitrary commands, results must be bounded so a model cannot
 * flood its own context, and every path must pass through `resolveSandboxedPath`.
 */

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  "__pycache__",
  ".venv",
]);

const MAX_FILE_BYTES = 2_000_000;
const DEFAULT_MAX_RESULTS = 100;
/** Below the tool definition's own 30 s, so the tool reports its own failure first. */
const DEFAULT_SEARCH_TIMEOUT_MS = 20_000;

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

/**
 * Walks the tree under `root`, skipping build output and version-control directories.
 *
 * ADR-095: containment is re-checked for EVERY entry, not once for the root. Before that,
 * `resolveSandboxedPath` was applied to the search root and never to the entries the walk
 * produced, and the walk used `statSync`, which resolves symlinks — so one link the agent is
 * allowed to create inside its own workspace made the whole host readable, one `fs.search`
 * away. The check is the one ADR-088 already wrote for single-path access, reused rather than
 * reimplemented, so both paths share a single definition of "inside".
 */
export function* walkFiles(root: string, current = root): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(current);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry)) continue;
    const full = resolve(current, entry);
    try {
      // Throws when the entry's REAL path (symlinks resolved) leaves the root.
      resolveSandboxedPath(root, entry, current);
    } catch {
      continue;
    }
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      yield* walkFiles(root, full);
    } else if (stats.isFile() && stats.size <= MAX_FILE_BYTES) {
      yield full;
    }
  }
}

/**
 * Translates a glob to a regular expression. Supports `**`, `*`, `?` and `{a,b}` — the
 * subset that covers real usage, implemented explicitly so the semantics are inspectable.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches any number of directories, including none.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") out += "[^/]";
    else if (c === "{") out += "(?:";
    else if (c === "}") out += ")";
    else if (c === ",") out += "|";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

/**
 * Searches the workspace — and runs the model's regular expression in a WORKER (ADR-116).
 *
 * The split is deliberate. The walk stays here because it is what enforces containment
 * (`resolveSandboxedPath` per entry, symlinks resolved — ADR-088/ADR-095); the matching, which is
 * the only part that executes an attacker-influenced regular expression, happens in a thread that
 * can be killed. `^(a+)+$` against one 60-character line was measured blocking this process for
 * 117.7 s with zero event-loop ticks, so nothing else — including the registry's own 30 s timeout
 * — could run. The deadline here is real because `terminate()` stops a worker mid-match.
 */
export async function searchFiles(
  root: string,
  options: {
    pattern: string;
    isRegex?: boolean;
    glob?: string;
    maxResults?: number;
    caseSensitive?: boolean;
    /** Wall-clock ceiling for the matching pass. */
    timeoutMs?: number;
    /** Cancels the matching pass — the invocation's signal (a cancelled task, a node deadline). */
    signal?: AbortSignal;
  }
): Promise<SearchMatch[]> {
  const max = Math.min(options.maxResults ?? DEFAULT_MAX_RESULTS, 500);
  const globMatcher = options.glob ? globToRegExp(options.glob) : null;

  // Containment is applied here, once, by the same walk every other tool uses.
  const files: { absolute: string; relative: string }[] = [];
  for (const file of walkFiles(root)) {
    const rel = relative(root, file).split(sep).join("/");
    if (globMatcher && !globMatcher.test(rel)) continue;
    files.push({ absolute: file, relative: rel });
  }
  if (files.length === 0) return [];

  return runMatchWorker(
    {
      files,
      pattern: options.pattern,
      isRegex: Boolean(options.isRegex),
      caseSensitive: Boolean(options.caseSensitive),
      maxResults: max,
    },
    options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    options.signal
  );
}

/** Runs the matching pass in a worker, killing it if it outlives its deadline or is cancelled. */
function runMatchWorker(
  workerData: {
    files: { absolute: string; relative: string }[];
    pattern: string;
    isRegex: boolean;
    caseSensitive: boolean;
    maxResults: number;
  },
  timeoutMs: number,
  signal?: AbortSignal
): Promise<SearchMatch[]> {
  return new Promise((resolvePromise, reject) => {
    // Resolved against this module, so it works from `dist/` in production and from `src/` under
    // vitest; the build copies the file next to the compiled output.
    const worker = new Worker(new URL("./search-worker.mjs", import.meta.url), { workerData });
    let settled = false;
    const finish = (err?: Error, value?: SearchMatch[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      if (err) reject(err);
      else resolvePromise(value ?? []);
    };

    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `The search did not finish within ${timeoutMs}ms and was stopped. A simpler pattern, or one that is not a regular expression, will complete.`
          )
        ),
      timeoutMs
    );
    const onAbort = () => finish(new Error("The search was cancelled."));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    worker.once("message", (msg: { ok: boolean; result?: SearchMatch[]; error?: string }) => {
      if (msg.ok) finish(undefined, msg.result);
      else finish(new Error(msg.error ?? "The search failed."));
    });
    worker.once("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish(new Error(`The search worker exited with code ${code}.`));
    });
  });
}


export function globFiles(root: string, pattern: string, maxResults = DEFAULT_MAX_RESULTS): string[] {
  const matcher = globToRegExp(pattern);
  const out: string[] = [];
  for (const file of walkFiles(root)) {
    const rel = relative(root, file).split(sep).join("/");
    if (matcher.test(rel)) {
      out.push(rel);
      if (out.length >= Math.min(maxResults, 1000)) break;
    }
  }
  return out.sort();
}

function definition(
  id: string,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>
): ToolDefinition {
  const defaults = PERMISSION_LEVEL_DEFAULTS.read_only;
  return {
    id,
    name,
    description,
    origin: { kind: "native", serverId: null, serverVersion: null },
    inputSchema,
    outputSchema: null,
    permissionLevel: "read_only",
    riskLevel: defaults.riskLevel,
    requiresApproval: defaults.requiresApproval,
    timeoutMs: defaults.timeoutMs,
    retryPolicy: { maxAttempts: defaults.maxAttempts, backoff: "exponential", idempotencyRequired: false },
    enabled: true,
  };
}

export function createSearchTools(root: string): NativeToolEntry[] {
  /**
   * Every search resolves inside the CALLER'S PROJECT workspace — ADR-090, completed by
   * ADR-095.
   *
   * ADR-090 gave the filesystem and coding tools a per-project workspace, and these two were
   * missed: they kept `context.workspaceRoot ? resolveSandboxedPath(...) : root`, and the
   * composition root never injects a `workspaceRoot`, so in production the fallback was the
   * LIVE branch and both tools walked the deployment root — every tenant's workspace at once.
   * A read tool with no `WHERE project_id` is a cross-tenant disclosure even though it writes
   * nothing, and this one could be asked "where is X defined?" across all of them.
   *
   * `workspaceRoot` is honoured only when RELATIVE, matching `coding.ts`: it then names a
   * subdirectory within the project's own workspace. An absolute one is ignored rather than
   * resolved, because the only thing that ever passed one was the deployment root itself.
   */
  const resolveSearchRoot = (context: ToolInvocationContext): string => {
    const workspace = projectWorkspace(root, context);
    const scoped = context.workspaceRoot && !isAbsolute(context.workspaceRoot) ? context.workspaceRoot : null;
    return scoped ? resolveSandboxedPath(workspace, scoped) : workspace;
  };

  return [
    {
      definition: definition(
        "fs.search",
        "Search file contents",
        "Search the workspace for a literal string or regular expression. Returns matching file paths with line numbers, so you can then read only the files that matter. Use this to answer 'where is X defined?'.",
        {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Literal text, or a regular expression when isRegex is true." },
            isRegex: { type: "boolean", description: "Treat pattern as a JavaScript regular expression." },
            glob: { type: "string", description: "Restrict to paths matching this glob, e.g. src/**/*.ts" },
            caseSensitive: { type: "boolean" },
            maxResults: { type: "integer", minimum: 1, maximum: 500 },
          },
          required: ["pattern"],
          additionalProperties: false,
        }
      ),
      handler: async (args, context) => {
        try {
          const matches = await searchFiles(resolveSearchRoot(context), {
            pattern: String(args.pattern),
            isRegex: Boolean(args.isRegex),
            glob: args.glob === undefined ? undefined : String(args.glob),
            caseSensitive: Boolean(args.caseSensitive),
            maxResults: args.maxResults === undefined ? undefined : Number(args.maxResults),
            signal: context?.signal,
          });
          return { ok: true, output: { matchCount: matches.length, matches } };
        } catch (err) {
          // An invalid regular expression is the model's mistake to correct, not a crash.
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      definition: definition(
        "fs.glob",
        "Find files by path pattern",
        "List workspace files whose path matches a glob such as `src/**/*.test.ts`. Use this to discover structure before reading anything.",
        {
          type: "object",
          properties: {
            pattern: { type: "string" },
            maxResults: { type: "integer", minimum: 1, maximum: 1000 },
          },
          required: ["pattern"],
          additionalProperties: false,
        }
      ),
      handler: async (args, context) => {
        try {
          const files = globFiles(
            resolveSearchRoot(context),
            String(args.pattern),
            Number(args.maxResults ?? DEFAULT_MAX_RESULTS)
          );
          return { ok: true, output: { fileCount: files.length, files } };
        } catch (err) {
          // A refused scope is an answer to the caller, not a crashed tool call.
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}
