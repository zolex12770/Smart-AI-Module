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
 * Rule-based planning for the known task shapes.
 *
 * Honest scope note: docs/11_AGENT_LOOP.md's PLANNING state is designed for an LLM-driven
 * planner that reasons about arbitrary requests, and this is not that — it is a switch. What
 * it plans, though, is no longer uniformly a fixed recipe: `autonomous` (ADR-064) and
 * `fix_failing_test` both plan a single `reasoning` node and let the model decide the steps,
 * because for those two the steps genuinely are not knowable in advance. The rest stay
 * deterministic because they are cheap, predictable and well-tested, not because a recipe is
 * the ceiling.
 *
 * Swapping this for an LLM-driven planner later remains a planner.ts change only — nothing
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
 * `verificationMethod: "none"` because the reasoning loop runs its own verification pass and can
 * self-correct; layering a schema check on top would only assert that a string is a string.
 *
 * That sentence was false for as long as it existed — the loop's `verify` hook was never supplied
 * by anything, so the branch and the self-correction turn behind it were unreachable, and this
 * comment described a check nothing performed (ADR-133). The engine supplies it now.
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
            content: `Answer the question using ONLY the context below, and cite the numbered source you used, e.g. [1].
If the context does not contain the answer, reply exactly: "The provided documents do not contain the answer to this question." Never cite a source number that does not appear in the context, and never refer to a document that is not listed there.\n\nContext:\n${wrapUntrustedContent(`{{${searchNodeId}.output.context}}`)}\n\nQuestion: ${question}`,
          },
        ],
      },
      timeoutMs: 30_000,
      /**
       * Grounded, not merely shaped (ADR-075). `schema_check` here only proved a `content` key
       * existed, which a fabricated answer satisfies exactly as well as a real one — and a REAL
       * model, asked a question with zero retrieved passages, duly answered by citing
       * "Document 12, titled 'Payments Service Maintenance Procedures'". No such document
       * existed; there were no documents at all. The check now reads the retrieval node's
       * actual results and rejects an answer that cites a marker never offered, or that answers
       * substantively when nothing was retrieved.
       *
       * `maxAttempts: 3` rather than 2 because this rejection is recoverable: the retry
       * re-prompts, and a second sample often refuses correctly where the first invented.
       */
      verificationMethod: "grounding_check",
      verificationSpec: { field: "content", sourceNodeId: searchNodeId },
      approvalRequired: PLANNER_LEVEL_APPROVAL_REQUIRED,
      retryPolicy: { maxAttempts: 3, backoff: "fixed", classifyFailureAs: null },
    },
  ];
}

/**
 * The tools the coding loop cannot run without. Looked up through `requireTool` rather than
 * filtered silently: without a way to run the test, read the code, or change it there is no
 * loop at all, and letting the model discover that at turn one spends a real model call to
 * reach the same conclusion the planner could have reached for free.
 */
const CODING_AGENT_REQUIRED_TOOLS = ["terminal.run_command", "code.read_lines", "code.replace_text", "code.apply_patch"] as const;

/**
 * Navigation tools the loop is far better with and still correct without — they are how the
 * model finds the source a test exercises instead of guessing at filenames. Included only when
 * registered, because a deployment that has not registered `fs.search` should get a coding
 * agent that reads and patches, not a task type that refuses to plan.
 */
const CODING_AGENT_OPTIONAL_TOOLS = ["fs.read_file", "fs.list_directory", "fs.search", "fs.glob"] as const;

/**
 * The coding agent — a model-driven fix/verify loop, not a script.
 *
 * THIS PLANNER WAS DEAD, and had been since ADR-062. It planned nodes for
 * `code.parse_fix_directive` and `code.apply_literal_fix`; ADR-062 deleted both tools when it
 * replaced directive-matching with real patching, so `requireTool` threw `unknown tool` here,
 * the engine caught it, and every `fix_failing_test` task went straight to FAILED — the
 * platform's headline coding capability failing 100% of the time. Nothing noticed because the
 * planner tests pass a `lookupTool` that manufactures a definition for any id asked of it, so
 * the one thing this function needed from the real registry was the one thing no test supplied.
 * The regression test added with this change plans every member of `taskTypeSchema` against a
 * lookup backed by the REAL native tool ids, which is the check that would have caught it.
 *
 * The repair is deliberately NOT "re-point the old four-node recipe at `code.apply_patch`".
 * That recipe could only ever apply a fix the failing test had already spelled out for itself
 * in a `FIX_NEEDED path=... find=... replace=...` line — the fix was authored by the test, not
 * by the agent, which is exactly the fake ADR-062 removed. The brief asks for
 * FAIL -> the model analyses -> patch -> test -> analyse the failure -> patch -> PASS, and the
 * only thing in this repository that can decide what a patch should contain is a model. So
 * this plans the shape `planAutonomous` already proves out: one `reasoning` node whose goal
 * states the fix-verify loop and whose `allowedTools` narrows the model to the tools that loop
 * needs. Nothing downstream changes — approval, retries, persistence and crash recovery are the
 * same machinery the autonomous type already runs through.
 *
 * Verification is `test_suite`, NOT `schema_check`. The node's output is the model's own account
 * of what it did, and a model reporting that the tests pass is not evidence that they pass — it
 * is the model grading itself, which docs/11_AGENT_LOOP.md principle 1 forbids. The harness
 * re-runs the command and reads the exit code (verify.ts `test_suite`), so the task can only
 * reach COMPLETED if the test really is green. The consequence is intended: where the
 * composition root supplies no sandboxed command runner, this task FAILS with "refusing to treat
 * an unrunnable check as passed" rather than completing on the model's word.
 */
function planFixFailingTest(input: Record<string, unknown>, lookupTool: ToolLookup): CreateTaskNodeInput[] {
  const testDir = String(input.testDir ?? ".").trim() || ".";
  const testFile = String(input.testFile ?? "").trim();
  if (!testFile) {
    // Previously this defaulted to "", planning `node ""` — a task that could only ever fail,
    // with a failure message about argv rather than about the missing field.
    throw new Error('planTask: a "fix_failing_test" task requires a non-empty `testFile`.');
  }

  for (const toolId of CODING_AGENT_REQUIRED_TOOLS) requireTool(toolId, lookupTool);
  const allowedTools = [
    ...CODING_AGENT_REQUIRED_TOOLS,
    ...CODING_AGENT_OPTIONAL_TOOLS.filter((toolId) => lookupTool(toolId) !== undefined),
  ];

  /**
   * The goal carries the loop, because running the loop is the model's job. Two of its
   * instructions are load-bearing rather than decorative: "fix the source, not the test" closes
   * the cheapest route from red to green (editing the assertion), and "never report a success
   * you did not observe" is what makes giving up honest — `test_suite` verification catches a
   * false claim either way, but a model that reports its own failure produces a far more useful
   * failure reason than one caught lying about it.
   */
  const goal = [
    `A test in this workspace is failing. Fix the code so that it passes.`,
    ``,
    `The test is run as: node ${testFile}`,
    `Working directory, relative to the workspace root: ${testDir}`,
    ``,
    `Work in this loop, and do not stop before the test is green:`,
    `1. Run the test with terminal.run_command and read the ACTUAL failure output.`,
    `2. Locate the source the test exercises and read the relevant lines with code.read_lines`,
    `   before changing anything. Do not patch a file you have not read.`,
    `3. Fix the SOURCE, not the test. For a small change use code.replace_text: quote the exact`,
    `   current text (copied from code.read_lines, without the line numbers) and its replacement.`,
    `   For larger changes apply a unified diff with code.apply_patch. Never edit ${testFile}`,
    `   to agree with the code, and never weaken or delete an assertion.`,
    `4. Run the test again. If it still fails, read the new failure and return to step 2.`,
    ``,
    `When the test exits 0, reply with what was broken, what you changed, and the exit code of`,
    `the final run. If you cannot make it pass, say so plainly and say why — never report a`,
    `success you did not observe.`,
  ].join("\n");

  return [
    {
      id: uuid(),
      type: "atomic",
      kind: "reasoning",
      dependsOn: [],
      // `testDir`/`testFile` are echoed alongside the goal so an operator reading the persisted
      // row can see what the task was pointed at without parsing prose out of the prompt.
      input: { goal, allowedTools, testDir, testFile },
      // The same ceiling an autonomous run gets: a fix-verify loop legitimately spans many
      // turns, and the loop's own iteration and token limits are the real bound.
      timeoutMs: 10 * 60_000,
      verificationMethod: "test_suite",
      verificationSpec: { command: "node", args: [testFile], workspaceRoot: testDir, timeoutMs: 60_000 },
      approvalRequired: PLANNER_LEVEL_APPROVAL_REQUIRED,
    },
  ];
}
