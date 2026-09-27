import type { TaskNode } from "@ai-platform/shared";
import { checkGrounding, type RagCitation } from "@ai-platform/rag";

export interface VerificationResult {
  pass: boolean;
  reason?: string;
}

/**
 * What a verifier may consult besides the node's own output — docs/26_DECISIONS.md ADR-075.
 *
 * Verification used to see only the node and its output, which is enough for a shape check and
 * not enough for anything grounded: "is this answer supported by the passages that were
 * retrieved" is a question about a DIFFERENT node's output, and "do the tests pass" is a
 * question about the world. Both are now expressible.
 */
export interface VerificationContext {
  /** Output of an upstream node this node depends on, or null if it has none. */
  dependencyOutput(nodeId: string): Record<string, unknown> | null;
  /**
   * Runs the node's test command in the sandbox and reports the exit code. Supplied by the
   * composition root, which is the only place that knows where code is allowed to execute —
   * `backend` wires it to the same hardened `ExecutionSandbox` the agent's terminal tool uses.
   * Absent in a context with no sandbox, in which case `test_suite` FAILS rather than passes.
   */
  runTestCommand?(spec: TestSuiteSpec): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /**
   * Asks a model to judge the output against a rubric. Last-resort per docs/11_AGENT_LOOP.md —
   * a model judging a model is the weakest evidence this platform accepts, which is why it is
   * never a default and always names its rubric explicitly.
   *
   * NOT WIRED, and this says so rather than implying otherwise: `backend`'s composition root
   * deliberately passes no judge, on the grounds that enabling the weakest form of verification
   * by default makes it the easiest one to reach for. `model_judge` therefore always fails
   * there with "refusing to treat an unrunnable check as passed", and nothing in this
   * repository plans a node that uses it. Wiring it is a one-line change in that composition
   * root — an explicit decision, not an accident of omission.
   */
  judge?(spec: ModelJudgeSpec, output: Record<string, unknown>): Promise<{ pass: boolean; reason?: string }>;
}

export interface TestSuiteSpec {
  command: string;
  args?: string[];
  workspaceRoot?: string;
  timeoutMs?: number;
  /**
   * The tenant whose workspace the command runs in — set by the ENGINE from the task, never by
   * the plan (ADR-093).
   *
   * Without it the composition root resolved the command against the bare deployment sandbox
   * root, which after ADR-090 is the PARENT of every project's workspace: the test file could not
   * be found (the failure that exposed this), and worse, a command that did resolve would have
   * run with every other tenant's files in reach. It is not part of the plan because a plan is
   * data a model can influence, and the tenant is not negotiable.
   */
  projectId?: string;
}

export interface ModelJudgeSpec {
  rubric: string;
  field?: string;
}

/**
 * Grounded verification, not model self-assessment — docs/11_AGENT_LOOP.md principle 1.
 *
 * Every method is implemented here (ADR-075), but "implemented" is not the same as "available":
 * two of them need something this function cannot supply itself, and both are honest about it.
 * `test_suite` needs a sandboxed command runner, which `backend` wires to its real
 * `ExecutionSandbox`; `model_judge` needs a judging model, which `backend` deliberately does
 * NOT wire (see `VerificationContext.judge`), so that method always fails there. The rule the
 * three once-throwing methods were written around still holds and is what makes that safe: a
 * method whose context is unavailable FAILS the node rather than passing it, so an unrunnable
 * check can never be mistaken for a satisfied one.
 *
 * `human` is the one exception to "implemented", and deliberately so: a human verdict is not
 * something this function can compute. It reads the verdict the approval flow already
 * recorded, and refuses when there is none — which is the correct behaviour for a node that
 * claims human verification but never obtained it.
 */
export async function verifyNodeOutput(
  node: TaskNode,
  output: Record<string, unknown>,
  context?: VerificationContext
): Promise<VerificationResult> {
  switch (node.verificationMethod) {
    case "none":
      return { pass: true };

    case "schema_check": {
      const requiredKeys = (node.verificationSpec?.requiredKeys as string[] | undefined) ?? [];
      const missing = requiredKeys.filter((k) => output[k] === undefined || output[k] === null);
      return missing.length === 0
        ? { pass: true }
        : { pass: false, reason: `Missing required output key(s): ${missing.join(", ")}` };
    }

    case "deterministic_compare": {
      const spec = node.verificationSpec ?? {};
      const field = (spec.field as string | undefined) ?? "content";
      if (typeof spec.expectedSubstring === "string") {
        const actual = String(output[field] ?? "");
        return actual.includes(spec.expectedSubstring)
          ? { pass: true }
          : { pass: false, reason: `Output field "${field}" did not contain expected substring.` };
      }
      if ("equals" in spec) {
        const actual = output[field];
        return actual === spec.equals
          ? { pass: true }
          : {
              pass: false,
              reason: `Output field "${field}" was ${JSON.stringify(actual)}, expected ${JSON.stringify(spec.equals)}.`,
            };
      }
      return { pass: true };
    }

    /**
     * Is the answer supported by what retrieval actually returned? — ADR-075.
     *
     * Added because a REAL model, asked a question with zero retrieved passages, answered by
     * citing "Document 12, titled 'Payments Service Maintenance Procedures'". No such document
     * existed. The prompt already told it to use only the given context; prompts do not bind
     * models, so the harness checks the answer instead.
     */
    case "grounding_check": {
      const spec = node.verificationSpec ?? {};
      const sourceNodeId = spec.sourceNodeId as string | undefined;
      if (!sourceNodeId || !context) {
        return {
          pass: false,
          reason:
            "grounding_check requires `verificationSpec.sourceNodeId` and a verification context naming the retrieval node. Refusing to treat an unrunnable check as passed.",
        };
      }
      const retrieval = context.dependencyOutput(sourceNodeId);
      if (!retrieval) {
        return { pass: false, reason: `grounding_check could not read the output of node "${sourceNodeId}".` };
      }
      const citations = (retrieval.citations as RagCitation[] | undefined) ?? [];
      const results = (retrieval.results as unknown[] | undefined) ?? [];
      const field = (spec.field as string | undefined) ?? "content";
      const verdict = checkGrounding({
        answer: String(output[field] ?? ""),
        citations,
        retrievedCount: results.length,
      });
      // An honest refusal passes the node (it is the truthful answer when the passages are
      // silent), and so does an empty one (the schema check owns "no content"); neither is
      // `grounded`, which is reserved for an answer tied to a cited passage.
      return verdict.outcome === "violation" ? { pass: false, reason: verdict.reason } : { pass: true };
    }

    /**
     * The real thing: run the tests and read the exit code — ADR-075.
     *
     * This is what makes the coding agent's loop honest. Without it a "fix" was verified by a
     * shape check on the model's own report of what it did, which is the model grading itself.
     */
    case "test_suite": {
      const spec = node.verificationSpec as unknown as TestSuiteSpec | undefined;
      if (!spec?.command) {
        return { pass: false, reason: "test_suite requires `verificationSpec.command`." };
      }
      if (!context?.runTestCommand) {
        return {
          pass: false,
          reason:
            "test_suite needs a sandboxed command runner and this context has none. Refusing to treat an unrunnable check as passed.",
        };
      }
      const run = await context.runTestCommand(spec);
      if (run.exitCode === 0) return { pass: true };
      // The output is the evidence, and it is what the model needs in order to fix the code on
      // the next attempt — so it goes in the reason, truncated rather than dropped.
      const detail = `${run.stdout}\n${run.stderr}`.trim().slice(-2000);
      return { pass: false, reason: `Test command exited ${run.exitCode}.\n${detail}` };
    }

    case "model_judge": {
      const spec = node.verificationSpec as unknown as ModelJudgeSpec | undefined;
      if (!spec?.rubric) {
        return { pass: false, reason: "model_judge requires `verificationSpec.rubric`." };
      }
      if (!context?.judge) {
        return {
          pass: false,
          reason:
            "model_judge needs a judging model and this context has none. Refusing to treat an unrunnable check as passed.",
        };
      }
      const verdict = await context.judge(spec, output);
      return verdict.pass ? { pass: true } : { pass: false, reason: verdict.reason ?? "Model judge rejected the output." };
    }

    /**
     * A human verdict is read, never computed.
     *
     * The approval flow (`approve`/`reject`) is what records it, so this checks that a real
     * person actually signed off on THIS node rather than inventing a verdict on their behalf.
     * A node that claims human verification and never obtained it fails, which is the whole
     * point of asking for one.
     */
    case "human": {
      if (node.approvedAt) return { pass: true };
      return {
        pass: false,
        reason: "This node requires human verification and no approval has been recorded for it.",
      };
    }
  }
}
