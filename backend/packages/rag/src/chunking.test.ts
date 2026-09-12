import { describe, expect, it } from "vitest";
import { chunkText } from "./chunking.js";

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
});
