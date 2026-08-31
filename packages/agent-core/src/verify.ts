import type { TaskNode } from "@ai-platform/shared";

export interface VerificationResult {
  pass: boolean;
  reason?: string;
}

/**
 * Grounded verification, not model self-assessment — docs/11_AGENT_LOOP.md principle 1.
 * Only `none`, `schema_check`, and `deterministic_compare` are implemented in this
 * increment. `test_suite` needs the coding agent's sandboxed command runner (Phase 5);
 * `model_judge`/`human` are deliberately last-resort per the docs and not wired up yet.
 * Encountering one of those throws rather than silently passing — a missing
 * verification method must never be mistaken for a passed one.
 */
export function verifyNodeOutput(node: TaskNode, output: Record<string, unknown>): VerificationResult {
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
      if (typeof spec.expectedSubstring === "string") {
        const field = (spec.field as string | undefined) ?? "content";
        const actual = String(output[field] ?? "");
        return actual.includes(spec.expectedSubstring)
          ? { pass: true }
          : { pass: false, reason: `Output field "${field}" did not contain expected substring.` };
      }
      return { pass: true };
    }

    case "test_suite":
    case "model_judge":
    case "human":
      throw new Error(
        `Verification method "${node.verificationMethod}" is not implemented yet (see PROJECT_STATUS.md) — ` +
          `refusing to silently treat it as passed.`
      );
  }
}
