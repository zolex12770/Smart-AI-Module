import type { RagCitation } from "./retrieve.js";

/**
 * Grounding checks for a model's answer — docs/26_DECISIONS.md ADR-075.
 *
 * WHY THIS EXISTS. `buildRagContext` already returns a sentence when nothing matched, with a
 * comment explaining that an empty string "would leave the model to fill the silence, which is
 * how 'no relevant documents' turns into an invented answer". That reasoning was right and the
 * mitigation was not enough. Running the pipeline against a REAL model (qwen2.5 via a local
 * runtime) produced exactly the failure it was meant to prevent: asked a question with zero
 * retrieved passages, the model answered
 *
 *   "The rollback procedure ... is mentioned in Document 12, which is titled 'Payments Service
 *    Maintenance Procedures.' According to Document 12, ..."
 *
 * There is no Document 12. There were no documents at all. A prompt cannot make a model refuse;
 * only the harness can, so the harness checks the answer instead of trusting it.
 *
 * Two distinct failures are caught here, and they need different treatment:
 *
 *  - **Answering with no evidence at all.** Deterministic and absolute: if retrieval returned
 *    nothing, no answer can be grounded, so any substantive answer is ungrounded by definition.
 *  - **Citing a marker that was never offered.** `[3]` when only `[1]` and `[2]` exist is a
 *    fabricated source, and a citation that cannot be resolved is not a citation
 *    (docs/09_RAG_ARCHITECTURE.md §6).
 *  - **Citing without answering.** ADR-161, found in the fifth audit's real acceptance run:
 *    asked "How many days of paid leave does an engineer get?" over a handbook that says 27,
 *    qwen2.5:7b replied with the complete text `[1]`. Retrieval was right (distance 0.208), the
 *    marker was real, so both rules above passed and the endpoint reported `grounded: true` —
 *    the platform's own assurance that the caller was handed an evidenced answer — for a string
 *    containing no answer. A citation is a pointer attached to a claim; with the claim removed
 *    there is nothing for the evidence to support, which makes this a grounding failure in
 *    exactly the sense the other two are, not a formatting quibble.
 *
 * What this deliberately does NOT do is judge whether the answer is *faithful* to the passage
 * it cites. That needs a second model and is a different, weaker kind of check; these two are
 * mechanical, cheap and certain.
 */

export interface GroundingCheckInput {
  /** The model's answer text. */
  answer: string;
  /** The citations that were actually offered to the model, from `buildCitations`. */
  citations: readonly RagCitation[];
  /** How many passages retrieval returned. Zero means nothing can be grounded. */
  retrievedCount: number;
}

export interface GroundingResult {
  grounded: boolean;
  /** Machine-readable so a caller can branch; the message is for humans. */
  violation?: "answered_without_evidence" | "fabricated_citation" | "citation_without_answer";
  reason?: string;
  /** Markers the model wrote that were never offered to it. */
  invalidMarkers?: string[];
}

/**
 * Bracketed integer markers the model wrote, e.g. `[1]`, `[12]`.
 *
 * Only this exact shape counts. Prose that happens to mention "document 12" is not a citation
 * and is handled by the no-evidence rule instead — widening this pattern to catch it would make
 * every answer containing a number in brackets (a code snippet, an array index) a violation.
 */
const MARKER_PATTERN = /\[(\d+)\]/g;

export function extractCitationMarkers(answer: string): string[] {
  const found = new Set<string>();
  for (const match of answer.matchAll(MARKER_PATTERN)) {
    found.add(`[${match[1]}]`);
  }
  return [...found];
}

/**
 * Phrases that indicate the model correctly declined rather than invented something.
 *
 * A refusal must be allowed through when there is no evidence — the honest answer to an
 * unanswerable question is "I cannot answer that from these documents", and failing the node
 * for producing it would turn correct behaviour into an error. Matching is on the lowercased
 * answer and deliberately generous: a false "this is a refusal" costs nothing (the answer had
 * no citations to fabricate anyway), while a false "this is fabrication" would reject a good
 * answer.
 */
const REFUSAL_MARKERS = [
  "no document",
  "no documents",
  "no relevant",
  "no passages",
  "no information",
  "not contain",
  "does not contain",
  "doesn't contain",
  "cannot answer",
  "can't answer",
  "cannot be answered",
  "unable to answer",
  "no evidence",
  "not enough information",
  "insufficient information",
  "no context",
  "not available in the",
  "not found in the",
  "not mentioned",
  "no matching",
];

function looksLikeRefusal(answer: string): boolean {
  const lower = answer.toLowerCase();
  return REFUSAL_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Is this answer grounded in what retrieval actually returned?
 *
 * Called by the harness AFTER the model responds — see `verifyNodeOutput`'s `grounding_check`
 * (ADR-075). A failure is a real node failure, so the retry machinery gets a chance to produce
 * a grounded answer instead, and a persistently ungrounded one fails the task rather than
 * returning fiction to the caller.
 */
export function checkGrounding(input: GroundingCheckInput): GroundingResult {
  const answer = input.answer.trim();

  // An empty answer cites nothing and claims nothing. Let the schema check own that case;
  // reporting it as a grounding violation would attribute the wrong cause.
  if (answer === "") return { grounded: true };

  if (input.retrievedCount === 0) {
    if (looksLikeRefusal(answer)) return { grounded: true };
    return {
      grounded: false,
      violation: "answered_without_evidence",
      reason:
        "Retrieval returned no passages, so no answer can be grounded — the model answered substantively instead of saying it could not.",
    };
  }

  const offered = new Set(input.citations.map((c) => c.marker));
  const markers = extractCitationMarkers(answer);
  const invalid = markers.filter((marker) => !offered.has(marker));
  if (invalid.length > 0) {
    return {
      grounded: false,
      violation: "fabricated_citation",
      invalidMarkers: invalid,
      reason: `Answer cited ${invalid.join(", ")}, which ${
        invalid.length === 1 ? "was" : "were"
      } never offered. Valid markers: ${[...offered].join(", ") || "(none)"}.`,
    };
  }

  /**
   * Markers, and nothing else — ADR-161. Checked last, after the markers have been shown to be
   * real ones: "[9]" alone is a fabricated citation first and an empty answer second, and
   * naming the stronger fault is more useful to whoever reads the violation.
   *
   * Only bracketed markers and punctuation are stripped. A one-word answer ("27.") survives,
   * and must: brevity is not the defect, absence is.
   */
  if (markers.length > 0 && stripMarkersAndPunctuation(answer) === "") {
    return {
      grounded: false,
      violation: "citation_without_answer",
      reason: `Answer was ${markers.join(", ")} and nothing else — a citation with no claim attached to it, so there is no answer to be grounded.`,
    };
  }

  return { grounded: true };
}

/** What is left of an answer once its citation markers and punctuation are removed. */
function stripMarkersAndPunctuation(answer: string): string {
  return answer
    // A fresh literal rather than MARKER_PATTERN: that one is `/g` and shared, and `replace`
    // mutating its `lastIndex` under `extractCitationMarkers` is a bug waiting to be written.
    .replace(/\[\d+\]/g, " ")
    .replace(/[\s.,;:!?'"()[\]\-–—]/g, "")
    .trim();
}
