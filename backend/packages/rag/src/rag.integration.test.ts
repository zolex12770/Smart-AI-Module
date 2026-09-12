import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v4 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  organizations,
  PgDocumentChunkRepository,
  PgDocumentRepository,
  projects,
  runMigrations,
  type Document,
  type PgliteDb,
} from "@ai-platform/database";
import { EmbeddingService, HashEmbeddingProvider } from "@ai-platform/embeddings";
import { ingestDocument, processDocumentIngestion, type IngestDeps } from "./ingest.js";
import { buildCitations, searchDocuments, type RetrieveDeps } from "./retrieve.js";

/**
 * Real end-to-end integration test — an actual in-memory PGlite Postgres instance
 * (docs/26_DECISIONS.md ADR-025), real migrations, real files on disk, real chunking, real
 * feature-hashed embeddings behind the real `EmbeddingService`, and a real pgvector `<=>`
 * query. No mocks. This is the automated counterpart to the manual curl-driven verification
 * in PROJECT_STATUS.md.
 *
 * Two projects are seeded rather than one, because after ADR-049 "did retrieval find the
 * right chunk" and "did retrieval stay inside the tenant" are the same question: a corpus
 * with only one project in it cannot fail the second half.
 */

/** A document identical in topic to project A's, so the ONLY thing that can keep it out of
 * A's results is the project filter — not a distance that would have excluded it anyway. */
const HANDBOOK =
  "Vacation Policy. Full-time employees accrue fifteen days of paid vacation per year, " +
  "accruing at a rate of one and one quarter vacation days for every full month worked. " +
  "Unused vacation days carry over into the following year up to a maximum of five days, " +
  "and any vacation balance above that maximum is forfeited on the thirty first of December. " +
  "Vacation requests are submitted to your manager at least two weeks before the vacation starts.\n\n" +
  "Expense Reimbursement. Any business expense over seventy five dollars requires an itemized " +
  "receipt attached to the expense report. Expense reports are approved by the finance team and " +
  "reimbursed with the next payroll run. Travel expenses, including flights, hotel nights and " +
  "taxi fares, must be booked through the corporate travel portal before the trip, otherwise the " +
  "expense report will be rejected and the expense will not be reimbursed at all.\n";

const VACATION_QUERY = "How many days of paid vacation do full-time employees accrue per year?";
/** Shares not one token with the corpus, so its cosine distance is exactly 1.0 — the "zero
 * similarity" query the audit found was still being answered with arbitrary top-K chunks. */
const UNRELATED_QUERY = "sourdough bread rye starter fermentation";

async function seedProject(db: PgliteDb, name: string): Promise<string> {
  const now = new Date();
  const organizationId = uuid();
  await db.insert(organizations).values({ id: organizationId, name: `${name} org`, createdAt: now, updatedAt: now });
  const id = uuid();
  await db.insert(projects).values({ id, organizationId, name, createdAt: now, updatedAt: now });
  return id;
}

describe("RAG ingest + retrieve (real PGlite Postgres)", () => {
  let db: PgliteDb;
  let sandboxRoot: string;
  let ingestDeps: IngestDeps;
  let retrieveDeps: RetrieveDeps;
  let projectA: string;
  let projectB: string;
  let documentA: Document;
  let documentB: Document;

  beforeAll(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    sandboxRoot = mkdtempSync(join(tmpdir(), "rag-test-"));
    writeFileSync(join(sandboxRoot, "handbook.txt"), HANDBOOK);
    writeFileSync(join(sandboxRoot, "partner-handbook.txt"), HANDBOOK);

    const documentRepo = new PgDocumentRepository(db);
    const chunkRepo = new PgDocumentChunkRepository(db);
    // The service, not the provider: it zero-pads the 256-wide hashed vector to the 1536-wide
    // column and supplies the model tag stored on every chunk (ADR-048).
    const embeddings = new EmbeddingService(new HashEmbeddingProvider());
    ingestDeps = { documentRepo, chunkRepo, embeddings, sandboxRoot };
    retrieveDeps = { chunkRepo, documentRepo, embeddings };

    projectA = await seedProject(db, "Project A");
    projectB = await seedProject(db, "Project B");
    documentA = await ingestDocument(ingestDeps, { projectId: projectA, relativePath: "handbook.txt" });
    documentB = await ingestDocument(ingestDeps, { projectId: projectB, relativePath: "partner-handbook.txt" });
  });

  afterAll(async () => {
    await db.$client.close();
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("ingests a real file, chunks it, embeds it, and stores it against its project", () => {
    expect(documentA.status).toBe("ready");
    expect(documentA.projectId).toBe(projectA);
    // `replaceForDocument` transitioned the row and bumped the ingest generation in the same
    // transaction, so a row created at version 1 is at 2 after one completed pass.
    expect(documentA.version).toBe(2);
  });

  it("ranks the topically-relevant chunk first via a real pgvector cosine-distance query", async () => {
    // Threshold relaxed on purpose: this test is about ORDER, and the default 0.6 admits only
    // the one strongly-matching chunk, which cannot demonstrate an ordering.
    const results = await searchDocuments(retrieveDeps, {
      projectId: projectA,
      query: VACATION_QUERY,
      topK: 5,
      maxDistance: 1.5,
    });

    expect(results.length).toBeGreaterThan(1);
    expect(results[0].content).toContain("vacation");
    // Real ranking, not a fixed order: distances must actually be sorted ascending.
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
    }
  });

  it("returns nothing at all for a semantically unrelated query, instead of arbitrary top-K chunks", async () => {
    const results = await searchDocuments(retrieveDeps, { projectId: projectA, query: UNRELATED_QUERY, topK: 5 });
    expect(results).toEqual([]);

    // ...and prove the threshold is what suppressed them, not an empty corpus: the very same
    // query with the ceiling lifted returns the same irrelevant chunks the audit complained
    // about, every one of them further away than the default 0.6.
    const unbounded = await searchDocuments(retrieveDeps, {
      projectId: projectA,
      query: UNRELATED_QUERY,
      topK: 5,
      maxDistance: 2,
    });
    expect(unbounded.length).toBeGreaterThan(0);
    for (const hit of unbounded) expect(hit.distance).toBeGreaterThan(0.6);
  });

  it("never retrieves a document belonging to another project, even one that matches perfectly", async () => {
    const fromA = await searchDocuments(retrieveDeps, { projectId: projectA, query: VACATION_QUERY, topK: 10 });
    const fromB = await searchDocuments(retrieveDeps, { projectId: projectB, query: VACATION_QUERY, topK: 10 });

    // Both corpora contain the same text, so both must match — anything else would make the
    // isolation assertions below pass for the wrong reason (an empty other side).
    expect(fromA.length).toBeGreaterThan(0);
    expect(fromB.length).toBeGreaterThan(0);
    expect(new Set(fromA.map((r) => r.documentId))).toEqual(new Set([documentA.id]));
    expect(new Set(fromB.map((r) => r.documentId))).toEqual(new Set([documentB.id]));
    expect(fromA.every((r) => r.filename === "handbook.txt")).toBe(true);
    expect(fromB.every((r) => r.filename === "partner-handbook.txt")).toBe(true);
  });

  it("returns a citation that resolves to a real document, not a bare positional marker", async () => {
    const results = await searchDocuments(retrieveDeps, { projectId: projectA, query: VACATION_QUERY, topK: 5 });
    expect(results.length).toBeGreaterThan(0);

    const citations = buildCitations(results);
    expect(citations[0]).toEqual({
      marker: "[1]",
      documentId: documentA.id,
      filename: "handbook.txt",
      chunkIndex: 0, // the vacation passage really is the document's first chunk
    });
    // The whole point: the marker's document id is one a caller can actually fetch back.
    const cited = await ingestDeps.documentRepo.get(projectA, citations[0].documentId);
    expect(cited?.filename).toBe("handbook.txt");
  });

  it("re-ingesting a document replaces its chunks transactionally instead of duplicating them", async () => {
    const chunksOf = async (document: Document) => {
      // maxDistance 2 is the whole cosine range, so this is "every chunk in the project" —
      // the same call the threshold tests use to prove the ceiling is configurable.
      const all = await searchDocuments(retrieveDeps, { projectId: document.projectId, query: "vacation expense", topK: 100, maxDistance: 2 });
      return all.filter((r) => r.documentId === document.id);
    };

    const before = await chunksOf(documentA);
    expect(before.length).toBeGreaterThan(0);

    const stored = (await ingestDeps.documentRepo.get(projectA, documentA.id))!;
    await processDocumentIngestion(ingestDeps, stored);

    const after = await chunksOf(documentA);
    expect(after.map((r) => r.chunkIndex).sort()).toEqual(before.map((r) => r.chunkIndex).sort());
    const reingested = (await ingestDeps.documentRepo.get(projectA, documentA.id))!;
    expect(reingested.status).toBe("ready");
    expect(reingested.version).toBe(3); // a second completed pass, not a second copy
  });

  it("stops retrieving a document once it is soft-deleted, even though its chunks remain", async () => {
    // Its own project, so this deletion cannot perturb the tests above whichever order they run in.
    const projectC = await seedProject(db, "Project C");
    writeFileSync(join(sandboxRoot, "temporary-handbook.txt"), HANDBOOK);
    const document = await ingestDocument(ingestDeps, { projectId: projectC, relativePath: "temporary-handbook.txt" });
    expect(await searchDocuments(retrieveDeps, { projectId: projectC, query: VACATION_QUERY, topK: 5 })).not.toEqual([]);

    expect(await ingestDeps.documentRepo.softDelete(projectC, document.id)).toBe(true);

    // `softDelete` leaves `document_chunks` alone by design (a derived index has no history
    // worth keeping, and the delete must not block on it), so retrieval is the layer that has
    // to honour it — otherwise a deleted document keeps being quoted back at the user.
    expect(await searchDocuments(retrieveDeps, { projectId: projectC, query: VACATION_QUERY, topK: 5 })).toEqual([]);
  });
});
