import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, PgAssetRepository, PgDocumentRepository, runMigrations, type PgliteDb } from "@ai-platform/database";
import { LocalAssetStore } from "@ai-platform/media";
import type { MalwareScanner, ScanVerdict } from "@ai-platform/scanning";
import { createPendingUploadedDocument } from "./ingest.js";
import { processDocumentScan } from "./scan.js";

/**
 * The scan JOB's branching (clean → ingest enqueued; infected → rejected + bytes and row
 * deleted; retry idempotency) against a real in-memory PGlite Postgres and the real
 * LocalAssetStore on a real temp directory. The scanner is the one dependency stood in for
 * here, by a hand-written double that returns a scripted verdict — because THIS test is
 * about what the job does with a verdict, and the scanner itself is tested for real (against
 * a real clamd process) in packages/scanning. The live check in ADR-042 runs the whole chain
 * with the real scanner.
 */
function scriptedScanner(verdict: ScanVerdict): MalwareScanner & { calls: number } {
  return {
    name: "scripted-scanner",
    calls: 0,
    async scan() {
      this.calls++;
      return verdict;
    },
    async ping() {
      return true;
    },
  };
}

function recordingQueue() {
  const enqueued: Array<{ queue: string; documentId: string }> = [];
  return { enqueued, enqueue: async (queue: string, payload: { documentId: string }) => void enqueued.push({ queue, documentId: payload.documentId }) };
}

describe("processDocumentScan (real PGlite + real LocalAssetStore)", () => {
  let db: PgliteDb;
  let dir: string;
  let documents: PgDocumentRepository;
  let assets: PgAssetRepository;
  let store: LocalAssetStore;

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    dir = mkdtempSync(join(tmpdir(), "scan-test-"));
    documents = new PgDocumentRepository(db);
    assets = new PgAssetRepository(db);
    store = new LocalAssetStore(dir, assets);
  });

  afterEach(async () => {
    await db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function uploadedDoc(content: string) {
    const assetId = await store.store(Buffer.from(content), "text/plain", "txt", "document");
    const doc = await createPendingUploadedDocument(documents, { filename: "f.txt", assetId, scanStatus: "pending" });
    expect(doc.status).toBe("scanning");
    return { doc, assetId };
  }

  it("clean → status ingesting, scanStatus clean, and exactly one document.ingest job enqueued", async () => {
    const { doc, assetId } = await uploadedDoc("harmless");
    const queue = recordingQueue();

    const outcome = await processDocumentScan({ documentRepo: documents, assetRepo: assets, assetStore: store, scanner: scriptedScanner({ verdict: "clean" }), jobQueue: queue }, doc.id);

    expect(outcome).toBe("clean");
    const after = (await documents.get(doc.id))!;
    expect(after.status).toBe("ingesting");
    expect(after.scanStatus).toBe("clean");
    expect(after.assetId).toBe(assetId); // kept — ingestion needs it
    expect(queue.enqueued).toEqual([{ queue: "document.ingest", documentId: doc.id }]);
    expect(await assets.get(assetId)).toBeDefined();
  });

  it("infected → status rejected with the signature named, NO ingest enqueued, bytes AND assets row deleted, FK cleared", async () => {
    const { doc, assetId } = await uploadedDoc("pretend-malware");
    const asset = (await assets.get(assetId))!;
    expect(existsSync(asset.storagePath)).toBe(true);
    const queue = recordingQueue();

    const outcome = await processDocumentScan(
      { documentRepo: documents, assetRepo: assets, assetStore: store, scanner: scriptedScanner({ verdict: "infected", signature: "Eicar-Test-Signature" }), jobQueue: queue },
      doc.id
    );

    expect(outcome).toBe("infected");
    const after = (await documents.get(doc.id))!;
    expect(after.status).toBe("rejected");
    expect(after.scanStatus).toBe("infected");
    expect(after.errorMessage).toMatch(/Eicar-Test-Signature/);
    expect(after.assetId).toBeNull();
    expect(queue.enqueued).toEqual([]);
    expect(await assets.get(assetId)).toBeUndefined();
    expect(existsSync(asset.storagePath)).toBe(false);
  });

  it("a scanner failure leaves the document scanning (never clean) and propagates so the job retries", async () => {
    const { doc } = await uploadedDoc("unknown");
    const failing: MalwareScanner = { name: "down", scan: async () => { throw new Error("clamd unreachable"); }, ping: async () => false };
    const queue = recordingQueue();

    await expect(processDocumentScan({ documentRepo: documents, assetRepo: assets, assetStore: store, scanner: failing, jobQueue: queue }, doc.id)).rejects.toThrow(/unreachable/);

    const after = (await documents.get(doc.id))!;
    expect(after.status).toBe("scanning");
    expect(after.scanStatus).toBe("pending");
    expect(queue.enqueued).toEqual([]);
  });

  it("is idempotent on retry: a document already past scanning is left alone and not re-scanned", async () => {
    const { doc } = await uploadedDoc("harmless");
    const scanner = scriptedScanner({ verdict: "clean" });
    const queue = recordingQueue();
    const deps = { documentRepo: documents, assetRepo: assets, assetStore: store, scanner, jobQueue: queue };

    await processDocumentScan(deps, doc.id);
    const second = await processDocumentScan(deps, doc.id);

    expect(second).toBe("already_handled");
    expect(scanner.calls).toBe(1);
    expect(queue.enqueued).toHaveLength(1); // not enqueued twice
  });
});
