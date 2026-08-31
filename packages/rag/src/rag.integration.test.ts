import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, PgDocumentRepository, PgDocumentChunkRepository, type DrizzleDb } from "@ai-platform/database";
import { HashEmbeddingProvider } from "@ai-platform/embeddings";
import { ingestDocument } from "./ingest.js";
import { searchDocuments } from "./retrieve.js";

/**
 * Real end-to-end integration test — an actual in-memory PGlite Postgres instance
 * (docs/26_DECISIONS.md ADR-025), real migrations, a real file on disk, real chunking,
 * real feature-hashed embeddings, and a real pgvector `<=>` query. No mocks. This is the
 * automated counterpart to the manual curl-driven verification in PROJECT_STATUS.md.
 */
describe("RAG ingest + retrieve (real PGlite Postgres)", () => {
  let db: DrizzleDb;
  let sandboxRoot: string;

  beforeAll(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    sandboxRoot = mkdtempSync(join(tmpdir(), "rag-test-"));
    writeFileSync(
      join(sandboxRoot, "handbook.txt"),
      "Vacation Policy\n\nFull-time employees accrue 15 days of paid vacation per year.\n\n" +
        "Expense Reimbursement\n\nExpenses over $75 require an itemized receipt.\n"
    );
  });

  afterAll(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("ingests a real file, chunks it, embeds it, and stores it", async () => {
    const documentRepo = new PgDocumentRepository(db);
    const chunkRepo = new PgDocumentChunkRepository(db);
    const embeddings = new HashEmbeddingProvider();

    const document = await ingestDocument({ documentRepo, chunkRepo, embeddings, sandboxRoot }, "handbook.txt");

    expect(document.status).toBe("ready");
  });

  it("ranks the topically-relevant chunk first via a real pgvector cosine-distance query", async () => {
    const chunkRepo = new PgDocumentChunkRepository(db);
    const embeddings = new HashEmbeddingProvider();

    const results = await searchDocuments({ chunkRepo, embeddings }, "How many vacation days do I get?", 2);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("vacation");
    // Real ranking, not a fixed order: distances must actually be sorted ascending.
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
    }
  });
});
