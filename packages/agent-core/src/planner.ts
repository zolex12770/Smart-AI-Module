import type { CreateTaskNodeInput, TaskType, ToolDefinition } from "@ai-platform/shared";
import { v4 as uuid } from "uuid";

export type ToolLookup = (toolId: string) => ToolDefinition | undefined;

/** A tool requires approval at plan time unless its registry entry says "never". */
function approvalRequiredFor(toolId: string, lookupTool: ToolLookup): boolean {
  return requireTool(toolId, lookupTool).requiresApproval !== "never";
}

function requireTool(toolId: string, lookupTool: ToolLookup) {
  const def = lookupTool(toolId);
  if (!def) throw new Error(`planTask: unknown tool "${toolId}" — is it registered?`);
  return def;
}

/** Node retry policy mirrors the tool's own declared defaults, not a generic fallback —
 * otherwise every node would silently get maxAttempts=1 regardless of what the tool
 * itself declares is safe to retry (docs/10_TOOL_AND_MCP_ARCHITECTURE.md §3.1 table). */
function retryPolicyForTool(toolId: string, lookupTool: ToolLookup) {
  const def = requireTool(toolId, lookupTool);
  return { maxAttempts: def.retryPolicy.maxAttempts, backoff: def.retryPolicy.backoff, classifyFailureAs: null };
}

/**
 * Deterministic, rule-based planning for two known task types.
 *
 * Honest scope note: docs/11_AGENT_LOOP.md's PLANNING state is designed for an
 * LLM-driven planner that reasons about arbitrary requests. Building that well needs a
 * real reasoning model (Phase 2, not yet wired to a real API key in this environment) —
 * a planner built against the mock provider would just be theater. This rule-based
 * planner is a genuine, honest stand-in that exercises the full state machine, task
 * graph, tool-calling, and persistence machinery for real, for two known request shapes.
 * Swapping this for an LLM-driven planner later is a planner.ts change only — nothing
 * downstream (dispatcher, verification, persistence) needs to change.
 */
export function planTask(
  taskType: TaskType,
  input: Record<string, unknown>,
  lookupTool: ToolLookup
): CreateTaskNodeInput[] {
  switch (taskType) {
    case "echo_chat":
      return planEchoChat(input);
    case "read_and_summarize":
      return planReadAndSummarize(input, lookupTool, "fs.read_file");
    case "mcp_read_and_summarize":
      // Same shape as read_and_summarize, but the read step goes through a real,
      // externally-running MCP server instead of our native tool — proves the whole
      // agent-core pipeline (approval gating, verification, persistence) works
      // identically regardless of tool origin, per docs/10 §3.3's design goal.
      return planReadAndSummarize(input, lookupTool, "mcp.reference-filesystem.read_text_file");
    case "delete_sandbox_file":
      return planDeleteSandboxFile(input, lookupTool);
  }
}

function planEchoChat(input: Record<string, unknown>): CreateTaskNodeInput[] {
  const message = String(input.message ?? "");
  return [
    {
      id: uuid(),
      type: "atomic",
      kind: "model_call",
      dependsOn: [],
      input: { messages: [{ role: "user", content: message }] },
      timeoutMs: 30_000,
      verificationMethod: "schema_check",
      verificationSpec: { requiredKeys: ["content"] },
      approvalRequired: false,
    },
  ];
}

function planReadAndSummarize(
  input: Record<string, unknown>,
  lookupTool: ToolLookup,
  readToolId: string
): CreateTaskNodeInput[] {
  const path = String(input.path ?? "");
  const question = String(input.question ?? "What does this file contain?");

  const readNodeId = uuid();

  return [
    {
      id: readNodeId,
      type: "atomic",
      kind: "tool_call",
      dependsOn: [],
      input: { path },
      toolId: readToolId,
      timeoutMs: 30_000,
      verificationMethod: "schema_check",
      verificationSpec: { requiredKeys: ["content"] },
      approvalRequired: approvalRequiredFor(readToolId, lookupTool),
      retryPolicy: retryPolicyForTool(readToolId, lookupTool),
    },
    {
      id: uuid(),
      type: "atomic",
      kind: "model_call",
      dependsOn: [readNodeId],
      input: {
        messages: [
          {
            role: "user",
            content: `Here is the file content:\n\n{{${readNodeId}.output.content}}\n\nQuestion: ${question}`,
          },
        ],
      },
      timeoutMs: 30_000,
      verificationMethod: "schema_check",
      verificationSpec: { requiredKeys: ["content"] },
      approvalRequired: false,
      retryPolicy: { maxAttempts: 2, backoff: "fixed", classifyFailureAs: null },
    },
  ];
}

/**
 * Exists specifically to exercise the approval-gate mechanism end to end against a real
 * destructive tool (fs.delete_file) — see PROJECT_STATUS.md verification notes.
 */
function planDeleteSandboxFile(input: Record<string, unknown>, lookupTool: ToolLookup): CreateTaskNodeInput[] {
  const path = String(input.path ?? "");
  return [
    {
      id: uuid(),
      type: "atomic",
      kind: "tool_call",
      dependsOn: [],
      input: { path },
      toolId: "fs.delete_file",
      timeoutMs: 30_000,
      verificationMethod: "schema_check",
      verificationSpec: { requiredKeys: ["path"] },
      approvalRequired: approvalRequiredFor("fs.delete_file", lookupTool),
      retryPolicy: retryPolicyForTool("fs.delete_file", lookupTool),
    },
  ];
}
