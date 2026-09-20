import { describe, expect, it } from "vitest";
import { chunkText } from "./chunking.js";

/**
 * The contract is the size bound — docs/26_DECISIONS.md ADR-149.
 *
 * These tests asserted that a multi-paragraph text produced more than one chunk and that every
 * paragraph appeared somewhere. Neither of those can fail for an oversized chunk, so a text with
 * no blank line in it — a PDF page, a single-spaced .md, a log, a CSV — became ONE chunk as large
 * as the file, and the suite stayed green: 200,000 characters produced `chunks: 1, max length:
 * 199,999` against a 500-character budget. The bound below is the assertion that was missing.
 */
const MAX = 500;
const OVERLAP = 50;
/** The packer carries an overlap plus a "\n\n" joiner into the next chunk. */
const CEILING = MAX + OVERLAP + 2;

describe("chunkText", () => {
  it("returns one chunk when the whole text fits under maxChars", () => {
    const chunks = chunkText("Just one short paragraph.", 500);
    expect(chunks).toEqual(["Just one short paragraph."]);
  });

  it("splits into multiple chunks when paragraphs exceed maxChars, keeping paragraphs intact", () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => `Paragraph number ${i} with some real content in it.`);
    const chunks = chunkText(paragraphs.join("\n\n"), 100, 10);
    expect(chunks.length).toBeGreaterThan(1);
    for (const p of paragraphs) {
      expect(chunks.some((c) => c.includes(p))).toBe(true);
    }
  });

  it("returns an empty array for empty/whitespace-only input", () => {
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("bounds a text with no blank line at all", () => {
    // The shape a PDF page has: the parser joins a page's items with single newlines and only
    // joins PAGES with a blank one, so one page is one paragraph.
    const text = Array.from({ length: 5_000 }, (_, i) => `line ${i} of a single-spaced document`).join("\n");
    const chunks = chunkText(text, MAX, OVERLAP);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CEILING);
  });

  it("bounds a run of text with no sentence break either", () => {
    // Past the sentence fallback and into the character cutoff: a 200,000-character token soup
    // is exactly what a minified file or a base64 blob in a document looks like.
    const chunks = chunkText("x".repeat(200_000), MAX, OVERLAP);

    expect(chunks.length).toBeGreaterThan(300);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CEILING);
  });

  it("splits an oversized paragraph on sentences before resorting to characters", () => {
    const sentence = `${"word ".repeat(40).trim()}.`; // ~200 chars
    const chunks = chunkText(Array.from({ length: 12 }, () => sentence).join(" "), MAX, OVERLAP);

    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CEILING);
    // Sentences are kept whole where they fit, rather than cut mid-word — that is the point of
    // trying sentences before the character window.
    expect(chunks.some((c) => c.includes(sentence))).toBe(true);
  });

  it("loses no content", () => {
    // A size bound met by dropping text would be worse than the overrun. The concatenation
    // carries the overlap, so the check is containment of every source line rather than equality.
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} carries a fact worth keeping`);
    const chunks = chunkText(lines.join("\n"), MAX, OVERLAP);
    const joined = chunks.join(" ");
    for (const line of lines) expect(joined).toContain(line);
  });
});
