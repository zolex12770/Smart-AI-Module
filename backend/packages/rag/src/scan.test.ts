import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v4 as uuid } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  organizations,
  PgAssetRepository,
  PgDocumentRepository,
  projects,
  runMigrations,
  type PgliteDb,
} from "@ai-platform/database";
import { LocalAssetStore } from "@ai-platform/media";
import type { MalwareScanner, ScanVerdict } from "@ai-platform/scanning";
import { createPendingUploadedDocument } from "./ingest.js";
import { processDocumentScan } from "./scan.js";

/**
 * The scan JOB's branching (clean → ingest enqueued; infected → rejected + bytes and row
 * deleted; retry idempotency; and, since ADR-049, tenant scope) against a real in-memory
 * PGlite Postgres and the real LocalAssetStore on a real temp directory. The scanner is the
 * one dependency stood in for here, by a hand-written double that returns a scripted verdict
 * — because THIS test is about what the job does with a verdict, and the scanner itself is
 * tested for real (against a real clamd process) in backend/packages/scanning. The live check in
 * ADR-042 runs the whole chain with the real scanner.
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
  const enqueued: Array<{ queue: string; projectId: string; documentId: string }> = [];
  return {
    enqueued,
    enqueue: async (queue: string, payload: { projectId: string; documentId: string }) =>
      void enqueued.push({ queue, projectId: payload.projectId, documentId: payload.documentId }),
  };
}

async function seedProject(db: PgliteDb, name: string): Promise<string> {
  const now = new Date();
  const organizationId = uuid();
  await db.insert(organizations).values({ id: organizationId, name: `${name} org`, createdAt: now, updatedAt: now });
  const id = uuid();
  await db.insert(projects).values({ id, organizationId, name, createdAt: now, updatedAt: now });
  return id;
}

describe("processDocumentScan (real PGlite + real LocalAssetStore)", () => {
  let db: PgliteDb;
  let dir: string;
  let documents: PgDocumentRepository;
  let assets: PgAssetRepository;
  let store: LocalAssetStore;
  let projectId: string;

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    dir = mkdtempSync(join(tmpdir(), "scan-test-"));
    documents = new PgDocumentRepository(db);
    assets = new PgAssetRepository(db);
    store = new LocalAssetStore(dir, assets);
    projectId = await seedProject(db, "Scanned Uploads");
  });

  afterEach(async () => {
    await db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function uploadedDoc(content: string) {
    const assetId = await store.store(projectId, Buffer.from(content), "text/plain", "txt", "document");
    const doc = await createPendingUploadedDocument(documents, { projectId, filename: "f.txt", assetId, scanStatus: "pending" });
    expect(doc.status).toBe("scanning");
    return { doc, assetId };
  }

  it("clean → status ingesting, scanStatus clean, and exactly one project-scoped document.ingest job enqueued", async () => {
    const { doc, assetId } = await uploadedDoc("harmless");
    const queue = recordingQueue();

    const outcome = await processDocumentScan({ documentRepo: documents, assetRepo: assets, assetStore: store, scanner: scriptedScanner({ verdict: "clean" }), jobQueue: queue }, projectId, doc.id);

    expect(outcome).toBe("clean");
    const after = (await documents.get(projectId, doc.id))!;
    expect(after.status).toBe("ingesting");
    expect(after.scanStatus).toBe("clean");
    expect(after.assetId).toBe(assetId); // kept — ingestion needs it
    // The tenant scope travels in the payload: the ingest worker has no request context to
    // recover it from, and an unscoped read on the other side is the IDOR this closes.
    expect(queue.enqueued).toEqual([{ queue: "document.ingest", projectId, documentId: doc.id }]);
    expect(await assets.get(projectId, assetId)).toBeDefined();
  });

  it("infected → status rejected with the signature named, NO ingest enqueued, bytes AND assets row deleted, FK cleared", async () => {
    const { doc, assetId } = await uploadedDoc("pretend-malware");
    const asset = (await assets.get(projectId, assetId))!;
    expect(existsSync(asset.storagePath)).toBe(true);
    const queue = recordingQueue();

    const outcome = await processDocumentScan(
      { documentRepo: documents, assetRepo: assets, assetStore: store, scanner: scriptedScanner({ verdict: "infected", signature: "Eicar-Test-Signature" }), jobQueue: queue },
      projectId,
      doc.id
    );

    expect(outcome).toBe("infected");
    const after = (await documents.get(projectId, doc.id))!;
    expect(after.status).toBe("rejected");
    expect(after.scanStatus).toBe("infected");
    expect(after.errorMessage).toMatch(/Eicar-Test-Signature/);
    expect(after.assetId).toBeNull();
    expect(queue.enqueued).toEqual([]);
    expect(await assets.get(projectId, assetId)).toBeUndefined();
    expect(existsSync(asset.storagePath)).toBe(false);
  });

  it("a scanner failure leaves the document scanning (never clean) and propagates so the job retries", async () => {
    const { doc } = await uploadedDoc("unknown");
    const failing: MalwareScanner = { name: "down", scan: async () => { throw new Error("clamd unreachable"); }, ping: async () => false };
    const queue = recordingQueue();

    await expect(processDocumentScan({ documentRepo: documents, assetRepo: assets, assetStore: store, scanner: failing, jobQueue: queue }, projectId, doc.id)).rejects.toThrow(/unreachable/);

    const after = (await documents.get(projectId, doc.id))!;
    expect(after.status).toBe("scanning");
    expect(after.scanStatus).toBe("pending");
    expect(queue.enqueued).toEqual([]);
  });

  it("is idempotent on retry: a document already past scanning is left alone and not re-scanned", async () => {
    const { doc } = await uploadedDoc("harmless");
    const scanner = scriptedScanner({ verdict: "clean" });
    const queue = recordingQueue();
    const deps = { documentRepo: documents, assetRepo: assets, assetStore: store, scanner, jobQueue: queue };

    await processDocumentScan(deps, projectId, doc.id);
    const second = await processDocumentScan(deps, projectId, doc.id);

    expect(second).toBe("already_handled");
    expect(scanner.calls).toBe(1);
    expect(queue.enqueued).toHaveLength(1); // not enqueued twice
  });

  it("a job carrying another project's scope cannot reach the document, let alone delete its bytes", async () => {
    const { doc, assetId } = await uploadedDoc("harmless");
    const otherProject = await seedProject(db, "Somebody Else");
    const scanner = scriptedScanner({ verdict: "infected", signature: "Eicar-Test-Signature" });
    const queue = recordingQueue();

    // Indistinguishable from a genuinely unknown id, on purpose: a distinguishable "exists but
    // forbidden" would be an existence oracle over another tenant's documents.
    await expect(
      processDocumentScan({ documentRepo: documents, assetRepo: assets, assetStore: store, scanner, jobQueue: queue }, otherProject, doc.id)
    ).rejects.toThrow(/unknown document/);

    expect(scanner.calls).toBe(0);
    const after = (await documents.get(projectId, doc.id))!;
    expect(after.status).toBe("scanning"); // untouched — no verdict was recorded against it
    expect(await assets.get(projectId, assetId)).toBeDefined();
  });
});
