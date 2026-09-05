import type { CreateTaskNodeInput, TaskType, ToolDefinition } from "@ai-platform/shared";
import { v4 as uuid } from "uuid";
import { UNTRUSTED_CONTENT_SYSTEM_PROMPT, wrapUntrustedContent } from "./trust-boundary.js";

export type ToolLookup = (toolId: string) => ToolDefinition | undefined;

/**
 * `approvalRequired` on a planned node is now ONLY the planner's own unconditional gate —
 * "this step needs a human whatever the tool says" — and no planned step currently needs
 * one, so every node below sets it false.
 *
 * It used to be `def.requiresApproval !== "never"`, which quietly destroyed three quarters
 * of docs/10_TOOL_AND_MCP_ARCHITECTURE.md §3.1's approval policy: `first_use` and
 * `risk_threshold` both collapsed into `always` the moment the plan was written. Neither is
 * answerable at plan time — one is a question about this project's history with the tool,
 * the other about the deployment's risk threshold — and a plan can outlive both answers.
 * So the boolean is gone and the dispatcher asks `ToolRegistry.approvalFor(toolId,
 * projectId)` at the moment of the call instead (see engine.ts `approvalDecision`, ADR-059).
 */
const PLANNER_LEVEL_APPROVAL_REQUIRED = false;

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
    case "fix_failing_test":
      return planFixFailingTest(input, lookupTool);
    case "answer_from_documents":
      return planAnswerFromDocuments(input, lookupTool);
    case "autonomous":
      return planAutonomous(input);
  }
}

/**
 * The open-ended plan — docs/26_DECISIONS.md ADR-064.
 *
 * It is deliberately a single node, and that is the whole point. Every other planner in this
 * file writes the steps in advance because it knows them in advance; here nobody does, so the
 * "plan" is one `reasoning` node and the sequence of actions is decided turn by turn by the
 * model inside it. The task graph keeps doing what it is good at — persistence, state,
 * approval, retries, crash recovery — and stops pretending to supply the intelligence.
 *
 * `verificationMethod: "none"` because the reasoning loop runs its own verification pass and
 * can self-correct; layering a schema check on top would only assert that a string is a string.
 */
function planAutonomous(input: Record<string, unknown>): CreateTaskNodeInput[] {
  const goal = String(input.goal ?? input.message ?? "").trim();
  if (!goal) {
    throw new Error('planTask: an "autonomous" task requires a non-empty `goal`.');
  }
  return [
    {
      id: uuid(),
      type: "atomic",
      kind: "reasoning",
      dependsOn: [],
      input: {
        goal,
        // Optional narrowing: which tools this run may use. Absent means "every tool the
        // caller's project has enabled", which the engine resolves at dispatch time.
        ...(Array.isArray(input.allowedTools) ? { allowedTools: input.allowedTools } : {}),
      },
      // Generous, because a multi-turn autonomous run is legitimately slower than one call;
      // the reasoning loop's own iteration and token ceilings are the real bound.
      timeoutMs: 10 * 60_000,
      verificationMethod: "none",
      verificationSpec: null,
      approvalRequired: false,
    },
  ];
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
      approvalRequired: PLANNER_LEVEL_APPROVAL_REQUIRED,
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
      approvalRequired: PLANNER_LEVEL_APPROVAL_REQUIRED,
      retryPolicy: retryPolicyForTool(readToolId, lookupTool),
    },
    {
      id: uuid(),
      type: "atomic",
      kind: "model_call",
      dependsOn: [readNodeId],
      input: {
        messages: [
          { role: "system", content: UNTRUSTED_CONTENT_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Here is the file content:\n\n${wrapUntrustedContent(`{{${readNodeId}.output.content}}`)}\n\nQuestion: ${question}`,
          },
        ],
      },
      timeoutMs: 30_000,
      verificationMethod: "schema_check",
      verificationSpec: { requiredKeys: ["content"] },
      approvalRequired: PLANNER_LEVEL_APPROVAL_REQUIRED,
      retryPolicy: { maxAttempts: 2, backoff: "fixed", classifyFailureAs: null },
    },
  ];
}

/**
 * Exists specifically to exercise the approval-gate mechanism end to end against a real
 * destructive tool (fs.delete_file) — see PROJECT_STATUS.md verification notes. The gate is
 * no longer baked into the plan: `fs.delete_file` declares `requiresApproval: "always"`, and
 * the dispatcher asks the registry for that verdict when it is about to make the call.
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
      approvalRequired: PLANNER_LEVEL_APPROVAL_REQUIRED,
      retryPolicy: retryPolicyForTool("fs.delete_file", lookupTool),
    },
  ];
}

/**
 * Real retrieval-augmented Q&A (docs/09_RAG_ARCHITECTURE.md): search real ingested
 * documents via pgvector, then have the model answer using the retrieved context. The
 * model is the mock provider unless a real key is configured (ADR-010) — the retrieval
 * half is genuinely real regardless (real embeddings, real pgvector search).
 */
function planAnswerFromDocuments(input: Record<string, unknown>, lookupTool: ToolLookup): CreateTaskNodeInput[] {
  const question = String(input.question ?? "");
  const searchNodeId = uuid();

  return [
    {
      id: searchNodeId,
      type: "atomic",
      kind: "tool_call",
      dependsOn: [],
      input: { query: question, topK: 3 },
      toolId: "rag.search_documents",
      timeoutMs: 15_000,
      verificationMethod: "schema_check",
      verificationSpec: { requiredKeys: ["context"] },
      approvalRequired: PLANNER_LEVEL_APPROVAL_REQUIRED,
      retryPolicy: retryPolicyForTool("rag.search_documents", lookupTool),
    },
    {
      id: uuid(),
      type: "atomic",
      kind: "model_call",
      dependsOn: [searchNodeId],
      input: {
        messages: [
          { role: "system", content: UNTRUSTED_CONTENT_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Answer the question using only the context below, and cite which numbered source you used.\n\nContext:\n${wrapUntrustedContent(`{{${searchNodeId}.output.context}}`)}\n\nQuestion: ${question}`,
          },
        ],
      },
      timeoutMs: 30_000,
      verificationMethod: "schema_check",
      verificationSpec: { requiredKeys: ["content"] },
      approvalRequired: PLANNER_LEVEL_APPROVAL_REQUIRED,
      retryPolicy: { maxAttempts: 2, backoff: "fixed", classifyFailureAs: null },
    },
  ];
}

/**
 * Real, narrow, deterministic "coding agent" pipeline — see the honest scope note in
 * packages/tools/src/native/coding.ts. Given a directory and a test file that prints a
 * `FIX_NEEDED path=... find=... replace=...` line on failure, this: runs the test,
 * parses the failure directive, applies the exact fix, and re-runs the test to confirm
 * it now passes — four real steps, no simulated ones.
 */
function planFixFailingTest(input: Record<string, unknown>, lookupTool: ToolLookup): CreateTaskNodeInput[] {
  const testDir = String(input.testDir ?? ".");
  const testFile = String(input.testFile ?? "");

  const runTest1 = uuid();
  const parseFix = uuid();
  const applyFix = uuid();

  return [
    {
      id: runTest1,
      type: "atomic",
      kind: "tool_call",
      dependsOn: [],
      input: { command: "node", args: [testFile], cwd: testDir },
      toolId: "terminal.run_command",
      timeoutMs: 30_000,
      verificationMethod: "schema_check",
      verificationSpec: { requiredKeys: ["exitCode", "stdout"] },
      approvalRequired: PLANNER_LEVEL_APPROVAL_REQUIRED,
      retryPolicy: retryPolicyForTool("terminal.run_command", lookupTool),
    },
    {
      id: parseFix,
      type: "atomic",
      kind: "tool_call",
      dependsOn: [runTest1],
      input: { text: `{{${runTest1}.output.stdout}}` },
      toolId: "code.parse_fix_directive",
      timeoutMs: 10_000,
      verificationMethod: "schema_check",
      verificationSpec: { requiredKeys: ["path", "find", "replace"] },
      approvalRequired: PLANNER_LEVEL_APPROVAL_REQUIRED,
      retryPolicy: retryPolicyForTool("code.parse_fix_directive", lookupTool),
    },
    {
      id: applyFix,
      type: "atomic",
      kind: "tool_call",
      dependsOn: [parseFix],
      input: {
        path: `{{${parseFix}.output.path}}`,
        find: `{{${parseFix}.output.find}}`,
        replace: `{{${parseFix}.output.replace}}`,
      },
      toolId: "code.apply_literal_fix",
      timeoutMs: 10_000,
      verificationMethod: "schema_check",
      verificationSpec: { requiredKeys: ["path"] },
      approvalRequired: PLANNER_LEVEL_APPROVAL_REQUIRED,
      retryPolicy: retryPolicyForTool("code.apply_literal_fix", lookupTool),
    },
    {
      id: uuid(),
      type: "atomic",
      kind: "tool_call",
      dependsOn: [applyFix],
      input: { command: "node", args: [testFile], cwd: testDir },
      toolId: "terminal.run_command",
      timeoutMs: 30_000,
      verificationMethod: "deterministic_compare",
      verificationSpec: { field: "exitCode", equals: 0 },
      approvalRequired: PLANNER_LEVEL_APPROVAL_REQUIRED,
      retryPolicy: retryPolicyForTool("terminal.run_command", lookupTool),
    },
  ];
}
