import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { v4 as uuid } from "uuid";
import type { Document, DocumentChunkRepository, DocumentRepository } from "@ai-platform/database";
import { resolveSandboxedPath } from "@ai-platform/tools";
import type { EmbeddingProvider } from "@ai-platform/embeddings";
import { chunkText } from "./chunking.js";
import { extractDocxText } from "./parsers/docx.js";
import { extractPdfText } from "./parsers/pdf.js";

/**
 * Extension-based dispatch — real parsing for .pdf (packages/rag/src/parsers/pdf.ts, via
 * pdfjs-dist) and .docx (parsers/docx.ts, a hand-rolled ZIP+XML reader, no new dependency
 * — the same "real implementation over a new dependency" call as ADR-030's GIF encoder),
 * plain UTF-8 text for everything else (.txt/.md and unrecognized extensions alike, so a
 * text file with an unusual extension still ingests as it always has).
 */
async function extractText(safePath: string, extension: string): Promise<string> {
  if (extension === ".pdf") return extractPdfText(await readFile(safePath));
  if (extension === ".docx") return extractDocxText(await readFile(safePath));
  return readFile(safePath, "utf8");
}

export interface IngestDeps {
  documentRepo: DocumentRepository;
  chunkRepo: DocumentChunkRepository;
  embeddings: EmbeddingProvider;
  sandboxRoot: string;
}

/**
 * Split into two steps so ingestion can run as an async job (docs/25_IMPLEMENTATION_ROADMAP.md
 * Phase 7): `createPendingDocument` returns immediately with a real row an API caller can
 * poll, and `processDocumentIngestion` does the actual (potentially slow, for a large file)
 * chunk/embed/store work — designed to run inside a job worker, not inline in an HTTP
 * handler. `ingestDocument` composes both for the synchronous case (used directly by
 * rag.integration.test.ts without needing job infrastructure in the test).
 */
export async function createPendingDocument(
  documentRepo: DocumentRepository,
  relativePath: string
): Promise<Document> {
  const filename = relativePath.split(/[/\\]/).pop() ?? relativePath;
  return documentRepo.create({ id: uuid(), filename, sourcePath: relativePath });
}

/**
 * Real document ingestion (docs/09_RAG_ARCHITECTURE.md) — reads a file from the same
 * sandboxed workspace the native tools use, chunks it, embeds every chunk (real feature-
 * hashed vectors — docs/26_DECISIONS.md ADR-026), and persists the chunks, updating the
 * given document's status in place. Handles plain text/.md, real PDF text extraction, and
 * real DOCX text extraction (see extractText above); CSV/code-aware chunking (docs/09 §2's
 * remaining rows) are not yet implemented.
 */
export async function processDocumentIngestion(deps: IngestDeps, document: Document): Promise<void> {
  try {
    const safePath = resolveSandboxedPath(deps.sandboxRoot, document.sourcePath);
    const text = await extractText(safePath, extname(document.sourcePath).toLowerCase());
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      throw new Error(
        "Document produced zero chunks (empty file, or a scanned/image-only PDF with no extractable text layer — OCR is not implemented)."
      );
    }

    const embeddings = await deps.embeddings.embed(chunks);
    await deps.chunkRepo.createMany(
      chunks.map((content, i) => ({
        id: uuid(),
        documentId: document.id,
        chunkIndex: i,
        content,
        embedding: embeddings[i],
      }))
    );

    await deps.documentRepo.updateStatus(document.id, "ready");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.documentRepo.updateStatus(document.id, "failed", message);
    throw err;
  }
}

export async function ingestDocument(deps: IngestDeps, relativePath: string): Promise<Document> {
  const document = await createPendingDocument(deps.documentRepo, relativePath);
  try {
    await processDocumentIngestion(deps, document);
    return { ...document, status: "ready" };
  } catch (err) {
    return { ...document, status: "failed", errorMessage: err instanceof Error ? err.message : String(err) };
  }
}
