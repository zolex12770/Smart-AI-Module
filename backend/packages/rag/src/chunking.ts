/**
 * Paragraph-aware fixed-size chunking with overlap — docs/09_RAG_ARCHITECTURE.md.
 * Splits on paragraph boundaries first (keeps related sentences together where
 * possible), then packs paragraphs into chunks up to `maxChars`, carrying a small
 * overlap into the next chunk so context isn't lost exactly at a boundary.
 *
 * §3 of that document specifies the boundary priority as "structural first
 * (heading/section/paragraph), then sentence, then hard character cutoff as last resort".
 * Only the first of the three was implemented — docs/26_DECISIONS.md ADR-149.
 */

/**
 * Splits one oversized paragraph, sentences first and characters as the last resort.
 *
 * The packer below could only ever emit whole paragraphs, and its `|| current === ""` arm
 * accepted one of ANY length. A text with no blank line — a PDF page (the parser joins a page's
 * items with single newlines and only pages with a blank one), a single-spaced .md, a log, a CSV
 * — therefore became ONE chunk, as large as the file. Measured before the fix: 200,000 characters
 * with no blank line produced `chunks: 1, max length: 199,999` against a 500-character budget.
 *
 * That is not a cosmetic overrun. The whole document collapses to a single vector, so ranking
 * inside it is impossible and the distance threshold in `retrieve` has nothing to work with; and
 * the same chunk is then handed to the model as "context". With the local feature-hashed embedder
 * it degrades silently, which is why it survived; against any real embedding model with a
 * per-input token limit, ingesting an ordinary single-spaced text file fails outright and the
 * document is marked `failed`.
 */
function splitOversized(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];

  // Sentence-ish boundaries: end punctuation followed by whitespace. Deliberately simple — this
  // is a fallback for text that has already defeated the structural split, and a parser that
  // understands abbreviations would still have to hand the remainder to the character cutoff.
  const sentences = paragraph.split(/(?<=[.!?])\s+/);

  const out: string[] = [];
  let current = "";
  const flush = () => {
    if (current) out.push(current);
    current = "";
  };

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      /**
       * The last resort: a sentence — or a run of text with no sentence break at all — that is
       * still too long is cut on a character window. Nothing below this can fail.
       *
       * The window prefers the last whitespace inside it, so a single-spaced document is cut
       * between lines rather than through a word. A hard cut is kept for the case that has no
       * whitespace to find (a minified file, a base64 blob), where there is nothing to preserve.
       */
      flush();
      let i = 0;
      while (i < sentence.length) {
        let end = Math.min(i + maxChars, sentence.length);
        if (end < sentence.length) {
          const window = sentence.slice(i, end);
          // A line break is preferred over a space: a single-spaced document should be cut
          // BETWEEN its lines, not through one. A space is the fallback for prose that has
          // neither a sentence end nor a newline in the whole window.
          const newline = window.lastIndexOf("\n");
          const space = window.lastIndexOf(" ");
          const lastBreak = newline > maxChars / 2 ? newline : space;
          // Only worth taking if it leaves a chunk worth having; otherwise cut on the window.
          if (lastBreak > maxChars / 2) end = i + lastBreak;
        }
        const piece = sentence.slice(i, end).trim();
        if (piece) out.push(piece);
        i = end;
        // Skip the separator the break landed on. It is whitespace, so nothing is lost.
        while (i < sentence.length && /\s/.test(sentence[i])) i++;
      }
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      flush();
      current = sentence;
    }
  }
  flush();
  return out;
}

export function chunkText(text: string, maxChars = 500, overlapChars = 50): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    // Every unit the packer sees now fits the budget on its own, so the `current === ""` arm
    // below can no longer admit an unbounded one.
    .flatMap((p) => splitOversized(p, maxChars));

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
