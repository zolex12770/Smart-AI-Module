import { readFile, writeFile } from "node:fs/promises";
import { PERMISSION_LEVEL_DEFAULTS } from "@ai-platform/shared";
import { resolveSandboxedPath } from "./sandbox-path.js";
import type { NativeToolEntry } from "./filesystem.js";

/**
 * Deterministic coding-fix tools — docs/25_IMPLEMENTATION_ROADMAP.md Phase 5.
 *
 * Honest scope note (mirrors docs/26_DECISIONS.md ADR-018's reasoning for the planner):
 * genuinely reasoning about an arbitrary test failure and writing a correct fix needs a
 * real LLM — the mock provider (no real API key configured, ADR-010) cannot do that, and
 * building a "coding agent" that pretends to via canned text would be theater. These two
 * tools instead do something real and narrow: parse a *structured, self-describing*
 * failure signal a test prints (`FIX_NEEDED path=... find=... replace=...`) and apply the
 * exact literal correction it names. This proves the full pipeline — sandboxed command
 * execution, real failure observation, a real file mutation, and a real re-verification —
 * for a genuine (if narrow) automated-fix class, without faking creative reasoning.
 * Swapping in an LLM that reads arbitrary failure output and proposes a real diff is
 * future work once Phase 2 supplies a real model.
 */
const FIX_DIRECTIVE = /FIX_NEEDED path=(\S+) find=(\S+) replace=(\S+)/;

export function createCodingTools(root: string): NativeToolEntry[] {
  const readOnly = PERMISSION_LEVEL_DEFAULTS.read_only;
  const writeLocal = PERMISSION_LEVEL_DEFAULTS.write_local;

  const parseFixDirectiveTool: NativeToolEntry = {
    definition: {
      id: "code.parse_fix_directive",
      name: "Parse Fix Directive",
      description:
        "Scans text (e.g. captured stdout from a test run) for a line matching " +
        '"FIX_NEEDED path=<file> find=<old> replace=<new>" and extracts the three fields. ' +
        "Fails cleanly (does not fabricate a fix) if no such line is present — e.g. because " +
        "the test already passed or failed for an unrelated reason this tool doesn't understand.",
      origin: { kind: "native", serverId: null, serverVersion: null },
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
      },
      permissionLevel: "read_only",
      riskLevel: readOnly.riskLevel,
      requiresApproval: readOnly.requiresApproval,
      timeoutMs: readOnly.timeoutMs,
      retryPolicy: { maxAttempts: 1, backoff: "none", idempotencyRequired: false },
      enabled: true,
    },
    handler: async (args) => {
      const text = String(args.text ?? "");
      const match = FIX_DIRECTIVE.exec(text);
      if (!match) {
        return { ok: false, error: "No FIX_NEEDED directive found in the given text — nothing to fix." };
      }
      const [, path, find, replace] = match;
      return { ok: true, output: { path, find, replace } };
    },
  };

  const applyLiteralFixTool: NativeToolEntry = {
    definition: {
      id: "code.apply_literal_fix",
      name: "Apply Literal Fix",
      description:
        "Replaces the first exact occurrence of `find` with `replace` in the given file, " +
        "inside the sandboxed workspace. Fails cleanly if `find` is not present in the file " +
        "(never silently no-ops) so a stale or wrong directive doesn't look like a fix.",
      origin: { kind: "native", serverId: null, serverVersion: null },
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
        required: ["path", "find", "replace"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { path: { type: "string" } } },
      permissionLevel: "write_local",
      riskLevel: writeLocal.riskLevel,
      requiresApproval: writeLocal.requiresApproval,
      timeoutMs: writeLocal.timeoutMs,
      retryPolicy: { maxAttempts: 1, backoff: "none", idempotencyRequired: false },
      enabled: true,
    },
    handler: async (args) => {
      const path = String(args.path ?? "");
      const find = String(args.find ?? "");
      const replace = String(args.replace ?? "");
      const safePath = resolveSandboxedPath(root, path);
      const content = await readFile(safePath, "utf8");
      if (!content.includes(find)) {
        return { ok: false, error: `"${find}" was not found in ${path} — refusing to apply a no-op fix.` };
      }
      await writeFile(safePath, content.replace(find, replace), "utf8");
      return { ok: true, output: { path } };
    },
  };

  return [parseFixDirectiveTool, applyLiteralFixTool];
}
