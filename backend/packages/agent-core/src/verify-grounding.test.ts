import { describe, expect, it } from "vitest";
import type { TaskNode } from "@ai-platform/shared";
import { verifyNodeOutput, type VerificationContext } from "./verify.js";

/**
 * `grounding_check` as the agent's verifier applies it — no test covered this branch until the
 * autonomous-completion pass changed what `checkGrounding` returns.
 *
 * The rule under test: a node passes on a grounded answer, on an honest refusal and on an empty
 * one (the schema check owns that); it fails on every violation, including an answer that cites
 * nothing, which earlier revisions let through as "grounded".
 */
const node = (): TaskNode => ({
  id: "answer",
  parentId: null,
  rootTaskId: "task",
  type: "atomic",
  kind: "model_call",
  status: "running",
  dependsOn: ["retrieve"],
  input: {},
  output: null,
  toolId: null,
  modelProvider: null,
  retryPolicy: { maxAttempts: 1, backoff: "none", classifyFailureAs: null },
  timeoutMs: 1000,
  verificationMethod: "grounding_check",
  verificationSpec: { sourceNodeId: "retrieve" },
  approvalRequired: false,
  approvedBy: null,
  approvedAt: null,
  attemptCount: 0,
  errorMessage: null,
  createdAt: 0,
  updatedAt: 0,
});

const context = (retrieved: number): VerificationContext => ({
  dependencyOutput: (id) =>
    id === "retrieve"
      ? {
          results: Array.from({ length: retrieved }, () => ({})),
          citations: Array.from({ length: retrieved }, (_, i) => ({
            marker: `[${i + 1}]`,
            documentId: `d${i}`,
            filename: `f${i}.txt`,
            chunkIndex: 0,
          })),
        }
      : null,
});

const verify = (content: string, retrieved = 1) => verifyNodeOutput(node(), { content }, context(retrieved));

describe("verifyNodeOutput — grounding_check", () => {
  it("passes a substantive answer that cites an offered passage", async () => {
    expect(await verify("Engineers get 27 days of paid leave [1].")).toEqual({ pass: true });
  });

  it("passes an honest refusal, with or without a stray marker", async () => {
    expect((await verify("The provided documents do not contain the answer to this question.")).pass).toBe(true);
    expect((await verify("I don't know [1]")).pass).toBe(true);
    expect((await verify("The provided documents do not contain the answer.", 0)).pass).toBe(true);
  });

  it("fails an answer that cites nothing", async () => {
    const result = await verify("Engineers get 27 days of paid leave.");
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/cites none/);
  });

  it("fails a fabricated marker and a bare marker", async () => {
    expect((await verify("27 days [4].")).pass).toBe(false);
    expect((await verify("[1]")).pass).toBe(false);
  });

  it("fails a substantive answer when nothing was retrieved", async () => {
    expect((await verify("Engineers get 27 days.", 0)).pass).toBe(false);
  });
});
