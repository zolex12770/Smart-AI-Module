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

  it("accepts an honest refusal when retrieval returned nothing", () => {
    // The correct behaviour must not be punished — failing the node for saying "I don't know"
    // would train the plan away from the only truthful answer available.
    for (const answer of [
      "The provided documents do not contain the answer to this question.",
      "I cannot answer that from the supplied context.",
      "No relevant passages were found, so there is no evidence for an answer.",
      "That information is not mentioned in the documents.",
    ]) {
      expect(checkGrounding({ answer, citations: [], retrievedCount: 0 }).grounded).toBe(true);
    }
  });

  it("treats an empty answer as someone else's problem", () => {
    // An empty string claims nothing and cites nothing. Reporting it as a grounding violation
    // would attribute the wrong cause; the schema check owns "there is no content".
    expect(checkGrounding({ answer: "   ", citations: [], retrievedCount: 0 }).grounded).toBe(true);
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

  it("accepts a grounded answer that cites nothing at all", () => {
    // Not citing is a quality problem, not a fabrication. Failing it here would conflate two
    // different faults and make the violation label useless.
    expect(
      checkGrounding({ answer: "The rollback is a single command.", citations: citations(1), retrievedCount: 1 })
        .grounded
    ).toBe(true);
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
