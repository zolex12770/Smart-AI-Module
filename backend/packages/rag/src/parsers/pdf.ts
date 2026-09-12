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
 * Scanned/image-only PDFs correctly produce empty text (no OCR is attempted, per docs/27's
 * standing "scanned PDFs are the hardest case" note) — `processDocumentIngestion`'s existing
 * "zero chunks" check turns that into an honest ingestion failure, not a silently empty
 * success.
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
    return pageTexts.filter((p) => p.length > 0).join("\n\n");
  } finally {
    // destroy() lives on the loading task (this function's return value), not the resolved
    // PDFDocumentProxy — confirmed by reading pdfjs-dist's own source, not assumed.
    await loadingTask.destroy();
  }
}
