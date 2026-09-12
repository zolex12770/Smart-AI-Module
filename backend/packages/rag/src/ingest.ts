import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { v4 as uuid } from "uuid";
import type {
  Asset,
  AssetRepository,
  Document,
  DocumentChunkRepository,
  DocumentRepository,
  DocumentScanStatus,
  NewDocumentChunk,
} from "@ai-platform/database";
import { resolveSandboxedPath } from "@ai-platform/tools";
import type { EmbeddingService } from "@ai-platform/embeddings";
import { chunkText } from "./chunking.js";
import { extractDocxText } from "./parsers/docx.js";
import { extractPdfText } from "./parsers/pdf.js";

/**
 * Extension-based dispatch — real parsing for .pdf (backend/packages/rag/src/parsers/pdf.ts, via
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

/** The read side of backend/packages/media's AssetStore — declared structurally here so
 * backend/packages/rag does not take a dependency on backend/packages/media just for one method. */
export interface AssetBytesReader {
  read(asset: Asset): Promise<Buffer>;
}

export interface IngestDeps {
  documentRepo: DocumentRepository;
  chunkRepo: DocumentChunkRepository;
  /**
   * The embedding *service*, not a raw provider (docs/26_DECISIONS.md ADR-048): it
   * zero-pads every vector to the width of the `vector(1536)` column and carries the model
   * tag that has to be stored with each chunk, so retrieval can refuse to compare vectors
   * that were produced by two different models.
   */
  embeddings: EmbeddingService;
  sandboxRoot: string;
  /** Required to ingest an uploaded document (`document.assetId` set, ADR-041); the
   * sandbox-path flow never touches them, so existing callers/tests need not supply them. */
  assetRepo?: AssetRepository;
  assetStore?: AssetBytesReader;
}

/**
 * Everything needed to create a document row. `projectId` is the tenant boundary (ADR-049)
 * and is required in both creation paths: it is threaded from the caller's own authenticated
 * scope — the API route's `AuthContext`, or the job payload that carried it — and never
 * defaulted here, because a document that belongs to no project cannot be authorized on read.
 */
export interface CreatePendingDocumentInput {
  projectId: string;
  /** Sandbox-relative path. Its basename becomes the document's display filename. */
  relativePath: string;
  /** Null for a path-based ingest run by the platform itself rather than by a person. */
  uploadedByUserId?: string | null;
}

export interface CreatePendingUploadedDocumentInput {
  projectId: string;
  filename: string;
  assetId: string;
  scanStatus: DocumentScanStatus;
  uploadedByUserId?: string | null;
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
  input: CreatePendingDocumentInput
): Promise<Document> {
  const filename = input.relativePath.split(/[/\\]/).pop() ?? input.relativePath;
  return documentRepo.create({
    id: uuid(),
    projectId: input.projectId,
    uploadedByUserId: input.uploadedByUserId ?? null,
    filename,
    sourcePath: input.relativePath,
  });
}

/**
 * The upload flow's counterpart (docs/26_DECISIONS.md ADR-041): the bytes already live in
 * the AssetStore under a generated key (docs/13 §12 "rename on upload"); `filename` is
 * display-only and has already been reduced to a basename by the route — it is never used
 * to locate anything.
 */
export async function createPendingUploadedDocument(
  documentRepo: DocumentRepository,
  input: CreatePendingUploadedDocumentInput
): Promise<Document> {
  return documentRepo.create({
    id: uuid(),
    projectId: input.projectId,
    uploadedByUserId: input.uploadedByUserId ?? null,
    filename: input.filename,
    assetId: input.assetId,
    scanStatus: input.scanStatus,
  });
}

/** Loads a document's raw bytes from whichever of its two sources is set. */
async function loadDocumentBytes(deps: IngestDeps, document: Document): Promise<Buffer> {
  if (document.assetId) {
    if (!deps.assetRepo || !deps.assetStore) {
      throw new Error(`Document "${document.id}" is an upload (asset ${document.assetId}) but this ingestion worker has no asset store configured.`);
    }
    // Scoped to the document's own project (ADR-049). An asset reachable from this row is by
    // construction in the same tenant, so re-deriving the scope here cannot widen it — and
    // asking for it unscoped would be exactly the cross-tenant read the repository exists to
    // make impossible.
    const asset = await deps.assetRepo.get(document.projectId, document.assetId);
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
 *
 * The write is `replaceForDocument`, not `createMany`, on a first pass as much as on a
 * re-ingest (ADR-049): it drops whatever chunks an earlier pass left behind and writes the
 * new set *and* the parent document's `ready` status in ONE transaction. An untransactional
 * delete-then-insert leaves the document silently unsearchable in the gap — permanently, if
 * the process dies there — and lets a poller see `ready` next to a half-written index.
 *
 * Scope comes from `document.projectId`: the row was fetched under the caller's tenant scope,
 * so it *is* the caller's project, and nothing here invents one.
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

    // Each chunk records which model produced its vector and that model's true width before
    // zero-padding (ADR-048). Without the tag a later model switch would leave these rows
    // being compared against vectors from a different space — a distance with no meaning,
    // silently degrading every ranking instead of failing loudly.
    const embedded = await deps.embeddings.embed(chunks);
    const rows: NewDocumentChunk[] = chunks.map((content, i) => ({
      id: uuid(),
      chunkIndex: i,
      content,
      embedding: embedded[i].vector,
      embeddingModel: embedded[i].model,
      embeddingDims: embedded[i].dimensions,
    }));

    await deps.chunkRepo.replaceForDocument(document.id, document.projectId, rows, {
      status: "ready",
      // `documents.version` is the ingest generation: 1 means "created, not yet ingested",
      // and every completed pass increments it, so the row still answers "which pass wrote
      // the chunks that are in the index right now" after the fact.
      bumpVersion: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Deliberately does NOT drop the existing chunks: if a *re*-ingest fails, the previous
    // generation is still the best index this document has, and deleting it would make a
    // working document unsearchable because a later pass failed. `failed` is how an operator
    // learns the index is stale.
    await deps.documentRepo.updateStatus(document.projectId, document.id, "failed", message);
    throw err;
  }
}

export async function ingestDocument(deps: IngestDeps, input: CreatePendingDocumentInput): Promise<Document> {
  const document = await createPendingDocument(deps.documentRepo, input);
  try {
    await processDocumentIngestion(deps, document);
  } catch (err) {
    return { ...document, status: "failed", errorMessage: err instanceof Error ? err.message : String(err) };
  }
  // Read back rather than projecting the expected result: the status and the version bump
  // happened inside `replaceForDocument`'s transaction, so the stored row is the only
  // accurate answer. It can legitimately be gone — a concurrent soft delete — and then the
  // in-memory projection is still a truthful account of what this call did.
  return (await deps.documentRepo.get(input.projectId, document.id)) ?? { ...document, status: "ready" };
}
