import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { PERMISSION_LEVEL_DEFAULTS, ValidationError, type ToolDefinition } from "@ai-platform/shared";
import { applyUnifiedDiff, PatchError } from "./patch.js";
import { describeMissingFile } from "./missing-file.js";
import { assertWritable } from "./read-only.js";
import { resolveSandboxedPath } from "./sandbox-path.js";
import { isAbsolute } from "node:path";
import { projectWorkspace } from "./workspace.js";
import type { ToolInvocationContext } from "@ai-platform/shared";
import type { NativeToolEntry } from "./filesystem.js";

/**
 * Code-editing tools for the coding agent — docs/26_DECISIONS.md ADR-062, product brief §10.
 *
 * WHAT THIS REPLACES, and why it matters: the previous implementation exposed
 * `code.parse_fix_directive` and `code.apply_literal_fix`, which between them matched a
 * `FIX_NEEDED path=... find=... replace=...` string that the failing test printed about
 * itself and performed one whitespace-free literal replacement. No model was consulted at
 * any point, so calling it an "autonomous coding agent" was not true (§37 forbids exactly
 * that claim). The fix was authored by the test, not by the agent.
 *
 * These tools take the opposite approach: they give a *model* the primitives to do real
 * work — read, search, patch, format, test — and let it decide what to change. The unified
 * diff is the representation models are trained to produce, and `applyUnifiedDiff` applies
 * it atomically across files with real hunk matching (see patch.ts).
 */

function toolDefinition(
  id: string,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  permissionLevel: "read_only" | "write_local"
): ToolDefinition {
  const defaults = PERMISSION_LEVEL_DEFAULTS[permissionLevel];
  return {
    id,
    name,
    description,
    origin: { kind: "native", serverId: null, serverVersion: null },
    inputSchema,
    outputSchema: null,
    permissionLevel,
    riskLevel: defaults.riskLevel,
    requiresApproval: defaults.requiresApproval,
    timeoutMs: defaults.timeoutMs,
    retryPolicy: { maxAttempts: 1, backoff: "none", idempotencyRequired: false },
    enabled: true,
  };
}

export function createCodingTools(root: string): NativeToolEntry[] {
  /**
   * Every coding-tool path resolves inside the CALLER'S PROJECT workspace (ADR-090), not the
   * shared deployment root — one tenant's agent must not be able to read or overwrite a file
   * another tenant's agent just wrote.
   *
   * `workspaceRoot`, when the engine supplies one, is a subdirectory WITHIN that project
   * workspace rather than an alternative to it: it lets a run scope itself to a checkout, and it
   * is validated through the same containment check so it cannot be used to climb out.
   */
  const resolveIn = (context: ToolInvocationContext, relativePath: string) => {
    const workspace = projectWorkspace(root, context);
    // `workspaceRoot` is honoured only when RELATIVE — it then names a subdirectory within the
    // project's workspace, letting a run scope itself to a checkout, validated through the same
    // containment check so it cannot climb out.
    //
    // An ABSOLUTE one is ignored. Before ADR-090 the composition root passed the deployment
    // sandbox root here, which is now the PARENT of the project workspace: re-resolving it would
    // be an escape attempt and every coding-tool call in production would be rejected. Ignoring
    // it is correct rather than lenient, because the project workspace it would have named is
    // exactly what `projectWorkspace` just computed.
    const scoped = context.workspaceRoot && !isAbsolute(context.workspaceRoot) ? context.workspaceRoot : null;
    const base = scoped ? resolveSandboxedPath(workspace, scoped) : workspace;
    return resolveSandboxedPath(workspace, relativePath, base);
  };

  return [
    {
      definition: toolDefinition(
        "code.apply_patch",
        "Apply a unified diff",
        [
          "Apply a unified diff to the workspace. This is how you edit code.",
          "Supply a standard `--- a/path` / `+++ b/path` diff with `@@` hunks; several files may be changed in one call.",
          "Every hunk line starts with exactly ONE of ' ' (context), '-' (removed) or '+' (added), followed by the line's text. Context and removed lines must match the file exactly; if the `@@` counts are wrong they are recomputed from the hunk.",
          "Create a NEW file with `--- /dev/null`; an existing file is changed with a diff against its current content, never re-created. This tool does NOT delete files — deleting one is a destructive action that needs human approval, so call `fs.delete_file` for that.",
          "The patch is applied atomically: if any hunk does not match, NOTHING is written and you get an error describing which hunk failed — read the file again and produce a fresh diff rather than retrying the same one.",
        ].join(" "),
        {
          type: "object",
          properties: {
            diff: { type: "string", description: "A unified diff. Paths are relative to the workspace root." },
          },
          required: ["diff"],
          additionalProperties: false,
        },
        "write_local"
      ),
      handler: async (args, context) => {
        const diff = String(args.diff ?? "");
        if (!diff.trim()) return { ok: false, error: "The diff was empty." };
        try {
          const applied = applyUnifiedDiff(diff, (relativePath) => {
            const absolute = resolveIn(context, relativePath);
            // Checked while the diff is staged, so a refused file means nothing is written.
            assertWritable(root, context, absolute);
            return absolute;
          }, {
            readFileSync,
            writeFileSync,
            existsSync,
            rmSync: (p: string) => rmSync(p, { force: true }),
            describeMissing: (absolute: string, relativePath: string) =>
              describeMissingFile(projectWorkspace(root, context), absolute, relativePath),
          });
          return {
            ok: true,
            output: {
              filesChanged: applied.length,
              files: applied,
              // Surfaced so the model learns the file had drifted and can re-read it.
              driftDetected: applied.some((f) => f.offsets.length > 0),
            },
          };
        } catch (err) {
          if (err instanceof PatchError || err instanceof ValidationError) {
            return { ok: false, error: err.message };
          }
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      definition: toolDefinition(
        "code.read_lines",
        "Read a numbered slice of a file",
        "Read part of a file with line numbers, which is what you need to construct a correct unified diff. Prefer this over reading a whole large file.",
        {
          type: "object",
          properties: {
            path: { type: "string" },
            startLine: { type: "integer", minimum: 1 },
            endLine: { type: "integer", minimum: 1 },
          },
          required: ["path"],
          additionalProperties: false,
        },
        "read_only"
      ),
      handler: async (args, context) => {
        try {
          const absolute = resolveIn(context, String(args.path));
          if (!existsSync(absolute)) {
            return { ok: false, error: describeMissingFile(projectWorkspace(root, context), absolute, String(args.path)) };
          }
          const lines = readFileSync(absolute, "utf8").split(/\r\n|\n|\r/);
          const start = Math.max(1, Number(args.startLine ?? 1));
          const end = Math.min(lines.length, Number(args.endLine ?? Math.min(lines.length, start + 399)));
          const slice = lines
            .slice(start - 1, end)
            .map((text, i) => `${start + i}\t${text}`)
            .join("\n");
          return {
            ok: true,
            output: { path: String(args.path), startLine: start, endLine: end, totalLines: lines.length, content: slice },
          };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      /**
       * An exact search-and-replace edit — found necessary by the autonomous-completion pass.
       *
       * With `code.apply_patch` as the only way to change a file, a real fix_failing_test run
       * (qwen2.5:7b) read the right file, knew the right change, and then sent five diffs whose
       * `@@` header counts disagreed with their bodies; each was correctly refused, and the run
       * ended at its turn limit with the bug still there. Counting diff lines is a known weakness
       * of language models, which is why coding agents commonly offer this shape alongside diffs:
       * quote the exact text, give its replacement.
       *
       * It is as strict as the patch tool where strictness protects the file: the old text must
       * occur EXACTLY ONCE (zero matches means the model is working from a stale or imagined
       * version; several means the edit is ambiguous), and an edit that changes nothing is
       * refused rather than reported as done (ADR-145's reasoning).
       */
      definition: toolDefinition(
        "code.replace_text",
        "Replace exact text in a file",
        [
          "Edit a file by replacing one exact, unique piece of its current text with new text.",
          "`oldText` must match the file character for character (including indentation) and occur exactly once — copy it from code.read_lines output WITHOUT the line numbers, and include a neighbouring line if the text alone is not unique.",
          "`newText` replaces it. For larger or multi-file changes use code.apply_patch.",
        ].join(" "),
        {
          type: "object",
          properties: {
            path: { type: "string", description: "Path relative to the workspace root." },
            oldText: { type: "string", minLength: 1, description: "The exact text to replace; must occur exactly once." },
            newText: { type: "string", description: "The replacement text." },
          },
          required: ["path", "oldText", "newText"],
          additionalProperties: false,
        },
        "write_local"
      ),
      handler: async (args, context) => {
        const path = String(args.path ?? "");
        const oldText = String(args.oldText ?? "");
        const newText = String(args.newText ?? "");
        if (!oldText) return { ok: false, error: "oldText was empty: quote the exact text to replace." };
        if (oldText === newText) {
          return { ok: false, error: "oldText and newText are identical, so this edit would change nothing." };
        }
        try {
          const absolute = resolveIn(context, path);
          if (!existsSync(absolute)) {
            return {
              ok: false,
              error:
                `${describeMissingFile(projectWorkspace(root, context), absolute, path)} ` +
                "To create a NEW file instead, use code.apply_patch with a --- /dev/null diff.",
            };
          }
          assertWritable(root, context, absolute);
          const content = readFileSync(absolute, "utf8");
          // Match against the file's own line endings, whatever the model sent.
          const eol = content.includes("\r\n") ? "\r\n" : "\n";
          const find = oldText.replace(/\r\n|\r|\n/g, eol);
          const replacement = newText.replace(/\r\n|\r|\n/g, eol);
          const first = content.indexOf(find);
          if (first === -1) {
            const near = findIgnoringIndentation(content, find, eol);
            if (near) {
              return {
                ok: false,
                error:
                  `oldText was not found in "${path}" exactly, but the file has the same text with different ` +
                  `indentation at line ${near.line}: ${JSON.stringify(near.text)}. Use that text, exactly as ` +
                  `shown, as oldText, and indent newText the same way.`,
              };
            }
            return {
              ok: false,
              error:
                `oldText was not found in "${path}". It must match the current file exactly, including ` +
                `indentation and without line numbers. Read the file again with code.read_lines and copy the text.`,
            };
          }
          const occurrences = content.split(find).length - 1;
          if (occurrences > 1) {
            return {
              ok: false,
              error: `oldText occurs ${occurrences} times in "${path}", so the edit is ambiguous. Include a neighbouring line to make it unique.`,
            };
          }
          const updated = content.slice(0, first) + replacement + content.slice(first + find.length);
          writeFileSync(absolute, updated, "utf8");
          const line = content.slice(0, first).split(eol).length;
          return { ok: true, output: { path, replacedAtLine: line, linesRemoved: find.split(eol).length, linesAdded: replacement.split(eol).length } };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  ];
}

/**
 * The file's own text for `find` when the two differ only in leading whitespace, and the match
 * is unique — DL-25. A diagnosis for the error message, never a match the edit is applied to:
 * qwen2.5:7b sent four spaces where the file has two, five times in a row, and "not found" gave
 * it nothing to correct. `code.apply_patch` already said "different indentation".
 */
function findIgnoringIndentation(content: string, find: string, eol: string): { line: number; text: string } | null {
  const wanted = find.split(eol).map((l) => l.trim());
  while (wanted.length > 0 && wanted[wanted.length - 1] === "") wanted.pop();
  if (wanted.length === 0 || wanted.every((l) => l === "")) return null;
  const lines = content.split(eol);
  const matches: number[] = [];
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    if (wanted.every((w, k) => lines[i + k].trim() === w)) matches.push(i);
  }
  if (matches.length !== 1) return null;
  const at = matches[0];
  return { line: at + 1, text: lines.slice(at, at + wanted.length).join("\n") };
}
