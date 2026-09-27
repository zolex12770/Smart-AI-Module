import { describe, expect, it } from "vitest";
import { checkGrounding, extractCitationMarkers } from "./grounding.js";
import type { RagCitation } from "./retrieve.js";

/**
 * docs/26_DECISIONS.md ADR-075.
 *
 * The case that motivated this file is the first test below, and it is not hypothetical: a real
 * qwen2.5 model, asked a question over a corpus where retrieval returned nothing, answered
 *
 *   "The rollback procedure ... is mentioned in Document 12, which is titled 'Payments Service
 *    Maintenance Procedures.'"
 *
 * There was no Document 12 and there were no documents. The prompt had already instructed it to
 * use only the given context. That is the lesson these tests encode: a prompt is a request, not
 * a constraint, so the harness verifies the answer rather than trusting the instruction.
 */
const citations = (n: number): RagCitation[] =>
  Array.from({ length: n }, (_, i) => ({
    marker: `[${i + 1}]`,
    documentId: `doc-${i}`,
    filename: `file-${i}.txt`,
    chunkIndex: 0,
  }));

describe("checkGrounding — no evidence at all", () => {
  it("rejects a substantive answer when retrieval returned nothing", () => {
    const result = checkGrounding({
      answer:
        "The rollback procedure is mentioned in Document 12, which is titled 'Payments Service Maintenance Procedures'.",
      citations: [],
      retrievedCount: 0,
    });
    expect(result.grounded).toBe(false);
    expect(result.violation).toBe("answered_without_evidence");
  });

  it("accepts an honest refusal when retrieval returned nothing — as a refusal, not as grounded", () => {
    // The correct behaviour must not be punished — failing the node for saying "I don't know"
    // would train the plan away from the only truthful answer available. But nothing was
    // evidenced, so it is never `grounded`.
    for (const answer of [
      "The provided documents do not contain the answer to this question.",
      "I cannot answer that from the supplied context.",
      "No relevant passages were found, so there is no evidence for an answer.",
      "That information is not mentioned in the documents.",
    ]) {
      const result = checkGrounding({ answer, citations: [], retrievedCount: 0 });
      expect(result.outcome).toBe("refused");
      expect(result.grounded).toBe(false);
      expect(result.violation).toBeUndefined();
    }
  });

  it("treats an empty answer as someone else's problem", () => {
    // An empty string claims nothing and cites nothing. Reporting it as a grounding violation
    // would attribute the wrong cause; the schema check owns "there is no content".
    const result = checkGrounding({ answer: "   ", citations: [], retrievedCount: 0 });
    expect(result.outcome).toBe("empty");
    expect(result.grounded).toBe(false);
    expect(result.violation).toBeUndefined();
  });
});

describe("checkGrounding — fabricated citations", () => {
  it("rejects a marker that was never offered", () => {
    const result = checkGrounding({
      answer: "According to [3], the rollback is a one-liner.",
      citations: citations(2),
      retrievedCount: 2,
    });
    expect(result.grounded).toBe(false);
    expect(result.violation).toBe("fabricated_citation");
    expect(result.invalidMarkers).toEqual(["[3]"]);
    // The reason has to name both what was cited and what was available, or an operator reading
    // a failed node learns nothing actionable.
    expect(result.reason).toContain("[3]");
    expect(result.reason).toContain("[1]");
  });

  it("accepts markers that were offered", () => {
    expect(
      checkGrounding({
        answer: "Run opsctl rollback [1] and then verify /healthz [2].",
        citations: citations(2),
        retrievedCount: 2,
      }).grounded
    ).toBe(true);
  });

  it("does NOT call an answer that cites nothing grounded — it has its own violation", () => {
    // Earlier revisions accepted this. An answer that names no passage cannot be tied to one;
    // it is labelled separately so a caller can tell it from fabrication.
    const result = checkGrounding({ answer: "The rollback is a single command.", citations: citations(1), retrievedCount: 1 });
    expect(result.grounded).toBe(false);
    expect(result.outcome).toBe("violation");
    expect(result.violation).toBe("uncited_answer");
  });

  it("reports every fabricated marker, not just the first", () => {
    const result = checkGrounding({
      answer: "See [2], [5] and [9].",
      citations: citations(2),
      retrievedCount: 2,
    });
    expect(result.invalidMarkers).toEqual(["[5]", "[9]"]);
  });
});

/**
 * ADR-161 — the third failure, and the one only a real model found.
 *
 * The fifth audit's acceptance run asked the live endpoint "How many days of paid leave does an
 * engineer get?" over a handbook whose text says 27. Retrieval was correct: one passage, cosine
 * distance 0.208. qwen2.5:7b's complete answer was:
 *
 *   [1]
 *
 * Both existing rules passed it — evidence was retrieved, and `[1]` was a real marker — so the
 * endpoint returned `grounded: true` and a UI rendering `answer` showed its user the string
 * "[1]". The flag is the platform's assurance that the caller holds an evidenced answer, and
 * there was no answer at all.
 */
describe("checkGrounding — a citation with nothing attached to it", () => {
  it("rejects an answer that is only a citation marker", () => {
    const result = checkGrounding({ answer: "[1]", citations: citations(2), retrievedCount: 2 });
    expect(result.grounded).toBe(false);
    expect(result.violation).toBe("citation_without_answer");
  });

  it("rejects several markers with no prose between them", () => {
    expect(checkGrounding({ answer: "[1] [2].", citations: citations(2), retrievedCount: 2 }).grounded).toBe(false);
  });

  it("accepts a short answer — brevity is not the defect, absence is", () => {
    // The distinction the check has to get right: "27 days. [1]" is a complete answer to a
    // question about a number, and a rule that demanded a sentence would reject it.
    const result = checkGrounding({ answer: "27 days. [1]", citations: citations(2), retrievedCount: 2 });
    expect(result.grounded).toBe(true);
    expect(result.violation).toBeUndefined();
  });

  it("accepts one bare word with a citation", () => {
    expect(checkGrounding({ answer: "Wednesday [1]", citations: citations(1), retrievedCount: 1 }).grounded).toBe(true);
  });

  it("still calls a bare FABRICATED marker a fabricated citation", () => {
    // Order matters: "[9]" is both. Naming the stronger fault is what is useful to whoever
    // reads the violation, so the fabrication rule must win.
    const result = checkGrounding({ answer: "[9]", citations: citations(2), retrievedCount: 2 });
    expect(result.violation).toBe("fabricated_citation");
  });

  it("leaves an answer with no markers at all to the uncited rule, not this one", () => {
    // No marker means nothing to strip; this rule must not fire on prose that simply did not
    // cite — that is `uncited_answer`, a different fault.
    expect(checkGrounding({ answer: "Engineers get 27 days.", citations: citations(1), retrievedCount: 1 }).violation).toBe(
      "uncited_answer"
    );
  });
});

/**
 * Found by the autonomous-completion pass against a REAL model: asked about a policy the
 * handbook does not contain, qwen2.5:7b answered "The provided documents do not contain the
 * answer to this question. [1]" and the endpoint reported `grounded: true` with [1] as its source.
 */
describe("checkGrounding — a refusal that carries a citation", () => {
  it("is a refusal, never grounded, whatever marker it carries", () => {
    for (const answer of [
      "The provided documents do not contain the answer to this question. [1]",
      "I don't know [1]",
      "I do not know. [1][2]",
      "The passages do not contain that information [2].",
    ]) {
      const result = checkGrounding({ answer, citations: citations(2), retrievedCount: 2 });
      expect(result, answer).toMatchObject({ grounded: false, outcome: "refused" });
    }
  });

  it("is a refusal even when the marker it carries was never offered", () => {
    expect(checkGrounding({ answer: "I don't know [7]", citations: citations(1), retrievedCount: 1 }).outcome).toBe("refused");
  });

  it("does not mistake a grounded answer that mentions a gap for a refusal", () => {
    // The refusal phrase is only a refusal when it leads: this answers first, then notes a gap.
    const result = checkGrounding({
      answer: "Engineers receive 27 days of paid leave per year [1]. Carry-over is not mentioned.",
      citations: citations(1),
      retrievedCount: 1,
    });
    expect(result).toEqual({ grounded: true, outcome: "grounded" });
  });
});

describe("checkGrounding — the one grounded shape", () => {
  it("is a substantive answer citing only offered markers", () => {
    expect(checkGrounding({ answer: "27 days per calendar year [1].", citations: citations(1), retrievedCount: 1 })).toEqual({
      grounded: true,
      outcome: "grounded",
    });
  });
});

describe("extractCitationMarkers", () => {
  it("finds bracketed integers and de-duplicates them", () => {
    expect(extractCitationMarkers("As [1] says, and again [1], plus [2].").sort()).toEqual(["[1]", "[2]"]);
  });

  it("ignores prose that merely mentions a document number", () => {
    // Deliberately NOT matched. Widening the pattern to catch "Document 12" would make every
    // answer containing a bracketed number — an array index, a code snippet — a violation. The
    // no-evidence rule is what catches that phrasing, and it caught the real one.
    expect(extractCitationMarkers("According to Document 12 and section 4.")).toEqual([]);
  });

  it("ignores non-numeric brackets", () => {
    expect(extractCitationMarkers("An array literal [x] and a range [a-z].")).toEqual([]);
  });
});
