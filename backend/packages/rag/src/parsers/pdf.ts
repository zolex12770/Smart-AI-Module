import { fileURLToPath } from "node:url";
// The main `pdfjs-dist` export assumes Web Crypto/`Uint8Array.prototype.toHex` and throws
// under plain Node — the package's own runtime warning says so. The `legacy` build is the
// one pdfjs-dist itself documents for Node.js environments.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const PDFJS_DIST_ROOT = fileURLToPath(new URL(".", import.meta.resolve("pdfjs-dist/package.json")));

/**
 * Extracts plain text from a PDF using Mozilla's PDF.js (`pdfjs-dist`) — a real, actively
 * maintained, pure-JS parser (zero runtime dependencies; the only native-binary package in
 * its dependency tree, `@napi-rs/canvas`, is peer-optional and only used for rendering pages
 * to bitmap images, which we never do). Chosen over `pdf-parse` v2, which hard-depends on
 * that same native canvas package for every install. docs/09_RAG_ARCHITECTURE.md §2's PDF
 * row asks for layout-aware extraction (columns, tables-as-Markdown); this implementation is
 * a deliberately narrower MVP — reading order follows PDF.js's own text-item stream, and
 * tables/columns are not detected or restructured — the same honest-narrowing shape as
 * ADR-030's video scope decision.
 *
 * For scanned / image-only PDFs with no digital font stream:
 * If the PDF contains pages (`doc.numPages > 0`) but has zero extractable digital font text,
 * we synthesize a structural metadata descriptor chunk so ingestion gracefully indexes
 * the document rather than throwing an unhandled zero-chunks crash.
 */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: `${PDFJS_DIST_ROOT}standard_fonts/`,
    cMapUrl: `${PDFJS_DIST_ROOT}cmaps/`,
    cMapPacked: true,
    useSystemFonts: false,
  });

  try {
    const doc = await loadingTask.promise;
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        pageText += item.str;
        pageText += item.hasEOL ? "\n" : "";
      }
      pageTexts.push(pageText.trim());
    }
    const extracted = pageTexts.filter((p) => p.length > 0).join("\n\n");
    if (extracted.trim().length > 0) {
      return extracted;
    }

    // Graceful handling for scanned / raster-only PDFs:
    // If pages exist but have zero digital font stream text, synthesize a structural
    // descriptor chunk with page count and document metadata so ingestion can succeed
    // without an unhandled zero-chunk failure.
    if (doc.numPages > 0) {
      let title = "";
      let author = "";
      let subject = "";
      try {
        const metadata = await doc.getMetadata();
        const info = (metadata?.info as Record<string, unknown>) || {};
        title = typeof info?.Title === "string" ? info.Title.trim() : "";
        author = typeof info?.Author === "string" ? info.Author.trim() : "";
        subject = typeof info?.Subject === "string" ? info.Subject.trim() : "";
      } catch {
        // metadata extraction best-effort
      }

      const metaParts: string[] = [];
      if (title) metaParts.push(`Title: ${title}`);
      if (author) metaParts.push(`Author: ${author}`);
      if (subject) metaParts.push(`Subject: ${subject}`);
      const metaInfoStr = metaParts.length > 0 ? ` (${metaParts.join(", ")})` : "";

      return `[Document: Scanned/Raster PDF — ${doc.numPages} page(s)${metaInfoStr}. Note: This document consists of image-based or rasterized pages without an embedded digital font stream. Metadata-only descriptor indexed; OCR required for full textual extraction.]`;
    }

    return "";
  } finally {
    // destroy() lives on the loading task (this function's return value), not the resolved
    // PDFDocumentProxy — confirmed by reading pdfjs-dist's own source, not assumed.
    await loadingTask.destroy();
  }
}
