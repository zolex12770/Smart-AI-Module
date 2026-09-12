import { readZipEntry } from "./zip.js";

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const codePoint = entity[1] === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return XML_ENTITIES[entity] ?? match;
  });
}

/**
 * Extracts plain text from a DOCX file's `word/document.xml` — docs/09_RAG_ARCHITECTURE.md
 * §2's DOCX row (real structural parsing, not naive tag-stripping): walks the XML in
 * document order, only ever collecting text that actually lives inside a `<w:t>` run
 * (Word's real text-content element), and treats `</w:p>` as a paragraph boundary so the
 * output is still paragraph-shaped for `chunkText`'s existing paragraph-aware splitting.
 * `<w:tab/>` and `<w:br/>`/`<w:cr/>` become a literal tab/newline, matching how Word
 * actually represents them (they are NOT part of any `<w:t>` run). Deleted tracked-change
 * text lives in `<w:delText>`, not `<w:t>`, so it is correctly excluded without special-
 * casing — only accepted/final content is captured, per docs/09 §2's DOCX guidance.
 *
 * This is a real, working parser scoped to plain paragraph/run text — it does not attempt
 * docs/09's full "preserve heading levels and tables as Markdown" design (no `section_path`
 * metadata, table cells fold into ordinary paragraphs). A deliberate, honest MVP narrowing,
 * the same shape as ADR-030's video data-model scope decision.
 */
export function extractDocxText(buffer: Buffer): string {
  const xmlBuffer = readZipEntry(buffer, "word/document.xml");
  const xml = xmlBuffer.toString("utf8");

  const paragraphs: string[] = [];
  let current = "";
  let inTextRun = false;

  const tokenRegex = /<[^>]+>|[^<]+/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(xml)) !== null) {
    const token = match[0];
    if (!token.startsWith("<")) {
      if (inTextRun) current += decodeXmlEntities(token);
      continue;
    }

    if (/^<w:t(\s[^>]*)?>/.test(token)) {
      inTextRun = true;
    } else if (/^<w:t(\s[^>]*)?\/>/.test(token)) {
      // Self-closing <w:t/> — an explicitly empty text run, nothing to append.
    } else if (token.startsWith("</w:t>")) {
      inTextRun = false;
    } else if (/^<w:tab(\s[^>]*)?\/?>/.test(token)) {
      current += "\t";
    } else if (/^<w:(br|cr)(\s[^>]*)?\/?>/.test(token)) {
      current += "\n";
    } else if (token.startsWith("</w:p>")) {
      paragraphs.push(current);
      current = "";
    }
  }
  if (current.trim().length > 0) paragraphs.push(current);

  return paragraphs
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join("\n\n");
}
