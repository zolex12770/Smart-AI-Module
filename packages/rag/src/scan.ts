import type { Asset, AssetRepository, DocumentRepository } from "@ai-platform/database";
import type { MalwareScanner } from "@ai-platform/scanning";

/** Structural slices of packages/media's AssetStore and packages/jobs' JobQueue — declared
 * here so packages/rag depends on neither package for two methods. */
export interface ScanAssetStore {
  read(asset: Asset): Promise<Buffer>;
  delete(asset: Asset): Promise<void>;
}
export interface JobEnqueuer {
  enqueue(queueName: string, payload: { documentId: string; requestId?: string }): Promise<unknown>;
}

export interface ScanDeps {
  documentRepo: DocumentRepository;
  assetRepo: AssetRepository;
  assetStore: ScanAssetStore;
  scanner: MalwareScanner;
  jobQueue: JobEnqueuer;
}

export type ScanOutcome = "clean" | "infected" | "already_handled";

/**
 * The `document.scan` job (docs/13_SECURITY_ARCHITECTURE.md §12, docs/26_DECISIONS.md
 * ADR-042) — sits between upload and ingestion. The "quarantine" is a status, not a bucket:
 * a `scanning` document's asset is never ingested (this job is the only thing that enqueues
 * `document.ingest` for an upload) and never served (the asset route's serve-gate), so the
 * bytes are inert until this job clears them.
 *
 * On a clean verdict → status `ingesting`, and the regular ingest job is enqueued.
 * On an infected verdict → status `rejected` FIRST (so the serve-gate blocks immediately, even
 * if the deletion below fails partway), the FK reference cleared, then the bytes and the
 * `assets` row deleted — the platform never keeps a known-bad file. If the scanner cannot be
 * reached or errors, `scanner.scan` throws: the document stays `scanning`, pg-boss retries
 * per the queue's policy, and a scan that could not run is never reported as clean.
 * Idempotent on retry: a document no longer `scanning` is left alone.
 */
export async function processDocumentScan(deps: ScanDeps, documentId: string, requestId?: string): Promise<ScanOutcome> {
  const document = await deps.documentRepo.get(documentId);
  if (!document) throw new Error(`document.scan job referenced unknown document "${documentId}".`);
  if (document.status !== "scanning") return "already_handled";
  if (!document.assetId) throw new Error(`Document "${documentId}" is marked scanning but has no asset to scan.`);

  const asset = await deps.assetRepo.get(document.assetId);
  if (!asset) throw new Error(`Document "${documentId}" references missing asset "${document.assetId}".`);

  const bytes = await deps.assetStore.read(asset);
  const verdict = await deps.scanner.scan(bytes);

  if (verdict.verdict === "clean") {
    await deps.documentRepo.updateScan(documentId, "clean", "ingesting");
    await deps.jobQueue.enqueue("document.ingest", { documentId, requestId });
    return "clean";
  }

  await deps.documentRepo.updateScan(
    documentId,
    "infected",
    "rejected",
    `Rejected by malware scan (${deps.scanner.name}): ${verdict.signature}. The uploaded file has been deleted.`
  );
  await deps.documentRepo.clearAsset(documentId);
  await deps.assetStore.delete(asset);
  return "infected";
}
