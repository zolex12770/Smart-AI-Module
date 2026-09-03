import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { v4 as uuid } from "uuid";
import type { Asset, AssetRepository, Document, DocumentChunkRepository, DocumentRepository } from "@ai-platform/database";
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
 * text file with an unusual extension still ingests as it always has). Takes bytes, not a
 * path, so the same code serves both the sandbox-path flow and the uploaded-asset flow
 * (docs/26_DECISIONS.md ADR-041).
 */
async function extractText(bytes: Buffer, extension: string): Promise<string> {
  if (extension === ".pdf") return extractPdfText(bytes);
  if (extension === ".docx") return extractDocxText(bytes);
  return bytes.toString("utf8");
}

/** The read side of packages/media's AssetStore — declared structurally here so
 * packages/rag does not take a dependency on packages/media just for one method. */
export interface AssetBytesReader {
  read(asset: Asset): Promise<Buffer>;
}

export interface IngestDeps {
  documentRepo: DocumentRepository;
  chunkRepo: DocumentChunkRepository;
  embeddings: EmbeddingProvider;
  sandboxRoot: string;
  /** Required to ingest an uploaded document (`document.assetId` set, ADR-041); the
   * sandbox-path flow never touches them, so existing callers/tests need not supply them. */
  assetRepo?: AssetRepository;
  assetStore?: AssetBytesReader;
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
 * The upload flow's counterpart (docs/26_DECISIONS.md ADR-041): the bytes already live in
 * the AssetStore under a generated key (docs/13 §12 "rename on upload"); `filename` is
 * display-only and has already been reduced to a basename by the route — it is never used
 * to locate anything.
 */
export async function createPendingUploadedDocument(
  documentRepo: DocumentRepository,
  input: { filename: string; assetId: string }
): Promise<Document> {
  return documentRepo.create({ id: uuid(), filename: input.filename, assetId: input.assetId });
}

/** Loads a document's raw bytes from whichever of its two sources is set. */
async function loadDocumentBytes(deps: IngestDeps, document: Document): Promise<Buffer> {
  if (document.assetId) {
    if (!deps.assetRepo || !deps.assetStore) {
      throw new Error(`Document "${document.id}" is an upload (asset ${document.assetId}) but this ingestion worker has no asset store configured.`);
    }
    const asset = await deps.assetRepo.get(document.assetId);
    if (!asset) throw new Error(`Document "${document.id}" references missing asset "${document.assetId}".`);
    return deps.assetStore.read(asset);
  }
  if (!document.sourcePath) {
    throw new Error(`Document "${document.id}" has neither a sourcePath nor an assetId.`);
  }
  return readFile(resolveSandboxedPath(deps.sandboxRoot, document.sourcePath));
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
    const bytes = await loadDocumentBytes(deps, document);
    // `filename` is the basename in both flows (the path flow derives it from sourcePath),
    // so it is the one extension source that works for uploads and sandbox paths alike.
    const text = await extractText(bytes, extname(document.filename).toLowerCase());
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
