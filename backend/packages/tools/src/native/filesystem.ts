import { readFile, writeFile, unlink, readdir, stat } from "node:fs/promises";
import type { ToolDefinition, ToolHandler } from "@ai-platform/shared";
import { PERMISSION_LEVEL_DEFAULTS } from "@ai-platform/shared";
import { resolveSandboxedPath } from "./sandbox-path.js";
import { projectWorkspace } from "./workspace.js";

export interface NativeToolEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

const now = () => new Date().toISOString();

/**
 * Native filesystem tools, sandboxed to `root` (docs/10_TOOL_AND_MCP_ARCHITECTURE.md §3.1,
 * docs/13_SECURITY_ARCHITECTURE.md). `fs.delete_file` is deliberately `destructive` /
 * `requiresApproval: "always"` — it exists specifically to exercise and prove the
 * approval-gate mechanism in packages/agent-core, not because agents should casually
 * delete things. All four tools only ever touch paths inside `root`.
 */
export function createFilesystemTools(root: string): NativeToolEntry[] {
  const readOnly = PERMISSION_LEVEL_DEFAULTS.read_only;
  const writeLocal = PERMISSION_LEVEL_DEFAULTS.write_local;
  const destructive = PERMISSION_LEVEL_DEFAULTS.destructive;

  const readFileTool: NativeToolEntry = {
    definition: {
      id: "fs.read_file",
      name: "Read File",
      description:
        "Reads the full UTF-8 text content of a file inside the sandboxed workspace directory. " +
        "Use this to inspect a file's contents before summarizing or reasoning about it. " +
        "Do NOT use this for binary files. Path is relative to the sandbox root.",
      origin: { kind: "native", serverId: null, serverVersion: null },
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { content: { type: "string" } } },
      permissionLevel: "read_only",
      riskLevel: readOnly.riskLevel,
      requiresApproval: readOnly.requiresApproval,
      timeoutMs: readOnly.timeoutMs,
      retryPolicy: { maxAttempts: readOnly.maxAttempts, backoff: "fixed", idempotencyRequired: false },
      enabled: true,
    },
    handler: async (args, context) => {
      const path = String(args.path ?? "");
      const safePath = resolveSandboxedPath(projectWorkspace(root, context), path);
      const content = await readFile(safePath, "utf8");
      return { ok: true, output: { content, path } };
    },
  };

  const listDirTool: NativeToolEntry = {
    definition: {
      id: "fs.list_directory",
      name: "List Directory",
      description:
        "Lists file and directory names directly inside a directory in the sandboxed " +
        "workspace. Use this to discover what files exist before reading one. Path is " +
        "relative to the sandbox root; use \".\" for the root itself.",
      origin: { kind: "native", serverId: null, serverVersion: null },
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { entries: { type: "array" } } },
      permissionLevel: "read_only",
      riskLevel: readOnly.riskLevel,
      requiresApproval: readOnly.requiresApproval,
      timeoutMs: readOnly.timeoutMs,
      retryPolicy: { maxAttempts: readOnly.maxAttempts, backoff: "fixed", idempotencyRequired: false },
      enabled: true,
    },
    handler: async (args, context) => {
      const path = String(args.path ?? ".");
      const safePath = resolveSandboxedPath(projectWorkspace(root, context), path);
      const names = await readdir(safePath);
      const entries = await Promise.all(
        names.map(async (name) => {
          const s = await stat(`${safePath}/${name}`);
          return { name, isDirectory: s.isDirectory() };
        })
      );
      return { ok: true, output: { entries } };
    },
  };

  const writeFileTool: NativeToolEntry = {
    definition: {
      id: "fs.write_file",
      name: "Write File",
      description:
        "Writes UTF-8 text content to a file inside the sandboxed workspace directory, " +
        "creating or overwriting it. Reversible by us (the file lives in our own scratch " +
        "workspace), so it does not require approval by default.",
      origin: { kind: "native", serverId: null, serverVersion: null },
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { path: { type: "string" } } },
      permissionLevel: "write_local",
      riskLevel: writeLocal.riskLevel,
      requiresApproval: writeLocal.requiresApproval,
      timeoutMs: writeLocal.timeoutMs,
      retryPolicy: { maxAttempts: writeLocal.maxAttempts, backoff: "none", idempotencyRequired: false },
      enabled: true,
    },
    handler: async (args, context) => {
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      const safePath = resolveSandboxedPath(projectWorkspace(root, context), path);
      await writeFile(safePath, content, "utf8");
      return { ok: true, output: { path, writtenAt: now() } };
    },
  };

  const deleteFileTool: NativeToolEntry = {
    definition: {
      id: "fs.delete_file",
      name: "Delete File",
      description:
        "Permanently deletes a file inside the sandboxed workspace directory. Hard to " +
        "reverse — always requires explicit human approval before executing, regardless " +
        "of task-level approval settings.",
      origin: { kind: "native", serverId: null, serverVersion: null },
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { path: { type: "string" } } },
      permissionLevel: "destructive",
      riskLevel: destructive.riskLevel,
      requiresApproval: destructive.requiresApproval,
      timeoutMs: destructive.timeoutMs,
      retryPolicy: { maxAttempts: destructive.maxAttempts, backoff: "none", idempotencyRequired: true },
      enabled: true,
    },
    handler: async (args, context) => {
      const path = String(args.path ?? "");
      const safePath = resolveSandboxedPath(projectWorkspace(root, context), path);
      await unlink(safePath);
      return { ok: true, output: { path, deletedAt: now() } };
    },
  };

  return [readFileTool, listDirTool, writeFileTool, deleteFileTool];
}
