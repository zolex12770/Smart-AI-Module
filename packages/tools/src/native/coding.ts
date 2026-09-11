import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { PERMISSION_LEVEL_DEFAULTS, ValidationError, type ToolDefinition } from "@ai-platform/shared";
import { applyUnifiedDiff, PatchError } from "./patch.js";
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
          "Create a file with `--- /dev/null`, delete one with `+++ /dev/null`.",
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
          const applied = applyUnifiedDiff(diff, (relativePath) => resolveIn(context, relativePath), {
            readFileSync,
            writeFileSync,
            rmSync: (p: string) => rmSync(p, { force: true }),
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
  ];
}
