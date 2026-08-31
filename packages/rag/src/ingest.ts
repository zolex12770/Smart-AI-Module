import { readFile } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import type { Document, DocumentChunkRepository, DocumentRepository } from "@ai-platform/database";
import { resolveSandboxedPath } from "@ai-platform/tools";
import type { EmbeddingProvider } from "@ai-platform/embeddings";
import { chunkText } from "./chunking.js";

export interface IngestDeps {
  documentRepo: DocumentRepository;
  chunkRepo: DocumentChunkRepository;
  embeddings: EmbeddingProvider;
  sandboxRoot: string;
}

/**
 * Real document ingestion (docs/09_RAG_ARCHITECTURE.md) — reads a file from the same
 * sandboxed workspace the native tools use, chunks it, embeds every chunk (real feature-
 * hashed vectors — docs/26_DECISIONS.md ADR-026), and persists both the document record
 * and its chunks. Currently handles plain text (.txt/.md); PDF/DOCX parsing is not yet
 * implemented (PROJECT_STATUS.md) — this ingests whatever text content is in the file
 * verbatim, so a binary file would ingest as garbled text rather than being rejected.
 */
export async function ingestDocument(deps: IngestDeps, relativePath: string): Promise<Document> {
  const safePath = resolveSandboxedPath(deps.sandboxRoot, relativePath);
  const filename = relativePath.split(/[/\\]/).pop() ?? relativePath;

  const document = await deps.documentRepo.create({ id: uuid(), filename, sourcePath: relativePath });

  try {
    const text = await readFile(safePath, "utf8");
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      throw new Error("Document produced zero chunks (empty file?).");
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
    return { ...document, status: "ready" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.documentRepo.updateStatus(document.id, "failed", message);
    return { ...document, status: "failed", errorMessage: message };
  }
}
