/**
 * Paragraph-aware fixed-size chunking with overlap — docs/09_RAG_ARCHITECTURE.md.
 * Splits on paragraph boundaries first (keeps related sentences together where
 * possible), then packs paragraphs into chunks up to `maxChars`, carrying a small
 * overlap into the next chunk so context isn't lost exactly at a boundary. Real,
 * working logic — no external dependency needed for this scope (plain .txt/.md
 * documents; PDF/DOCX parsing is not yet implemented, see PROJECT_STATUS.md).
 */
export function chunkText(text: string, maxChars = 500, overlapChars = 50): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) return [];

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars || current === "") {
      current = candidate;
    } else {
      chunks.push(current);
      const overlap = current.slice(Math.max(0, current.length - overlapChars));
      current = `${overlap}\n\n${paragraph}`;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}
