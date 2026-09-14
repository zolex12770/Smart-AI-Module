import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  runMigrations,
  organizations,
  projects,
  users,
  PgAssetRepository,
  PgDocumentChunkRepository,
  PgDocumentRepository,
  documentChunks,
  type PgliteDb,
} from "@ai-platform/database";
import { EmbeddingService } from "@ai-platform/embeddings";
import type { EmbeddingMeter } from "@ai-platform/shared";
import { projectWorkspace } from "@ai-platform/tools";
import { processDocumentIngestion } from "./ingest.js";
import { searchDocuments } from "./retrieve.js";

/**
 * Embedding spend is asked about and written down — docs/26_DECISIONS.md ADR-131.
 *
 * ADR-119 metered exactly one embedding call: the question asked at `POST /api/v1/rag/query`.
 * Three others were free and invisible, and the largest by a wide margin was document ingestion —
 * an entire document's chunks in one batch, re-run from the first chunk on every retry. So the
 * ledger could honestly report "embedding: 1 unit, 12 tokens" for a question while an ingestion
 * had just spent tens of thousands, and a project refused a single question for being over its
 * embedding limit could still ingest a hundred-page PDF.
 *
 * These assert the two halves that matter: the budget is consulted BEFORE the provider is called,
 * and what actually happened is recorded afterwards.
 */
const DETERMINISTIC = {
  name: "test-embedder",
  model: "test-1",
  isDeterministicFallback: false,
  embed: async (texts: string[]) => texts.map(() => Array.from({ length: 8 }, () => 0.1)),
};

describe("embedding spend is metered", () => {
  let db: PgliteDb;
  let root: string;
  const PROJECT = "project-meter";
  const USER = "user-meter";

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);
    root = mkdtempSync(join(tmpdir(), "meter-ingest-"));
    const now = new Date();
    await db.insert(organizations).values({ id: "org-m", name: "Org", createdAt: now, updatedAt: now });
    await db
      .insert(users)
      .values({ id: USER, email: "m@example.com", passwordHash: "x", displayName: "M", createdAt: now, updatedAt: now });
    await db.insert(projects).values({ id: PROJECT, organizationId: "org-m", name: "P", createdAt: now, updatedAt: now });
  });

  afterEach(async () => {
    await db.$client.close();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* windows may briefly hold a handle */
    }
  });

  const meter = (): EmbeddingMeter & { checks: string[][]; records: string[][] } => {
    const checks: string[][] = [];
    const records: string[][] = [];
    return {
      checks,
      records,
      check: vi.fn(async (_p: string, texts: string[]) => {
        checks.push(texts);
      }),
      record: vi.fn(async (_p: string, texts: string[]) => {
        records.push(texts);
      }),
    };
  };

  async function seedDocument(): Promise<{
    documentRepo: PgDocumentRepository;
    document: Awaited<ReturnType<PgDocumentRepository["get"]>>;
  }> {
    const documentRepo = new PgDocumentRepository(db);
    // The ingest reads the file from inside the project's own workspace beneath sandboxRoot.
    const workspace = projectWorkspace(root, { projectId: PROJECT });
    mkdirSync(workspace, { recursive: true });
    // Long enough to produce several chunks, so "priced on the real batch" means something.
    writeFileSync(join(workspace, "notes.txt"), "The harbour at dawn is quiet. ".repeat(400));

    const created = await documentRepo.create({
      id: "doc-1",
      projectId: PROJECT,
      filename: "notes.txt",
      sourcePath: "notes.txt",
      uploadedByUserId: USER,
    });
    return { documentRepo, document: created as never };
  }

  it("asks the budget before embedding a document, and records it afterwards", async () => {
    const { documentRepo, document } = await seedDocument();
    const m = meter();

    await processDocumentIngestion(
      {
        documentRepo,
        chunkRepo: new PgDocumentChunkRepository(db),
        embeddings: new EmbeddingService(DETERMINISTIC),
        embeddingMeter: m,
        sandboxRoot: root,
        assetRepo: new PgAssetRepository(db),
      },
      document!
    );

    expect(m.checks).toHaveLength(1);
    expect(m.records).toHaveLength(1);

    // Priced on the REAL batch: the texts handed to the meter are exactly the chunks that were
    // stored, so the charge cannot drift from the work regardless of how the chunker behaves.
    const stored = await db.select().from(documentChunks).where(eq(documentChunks.documentId, "doc-1"));
    expect(stored.length).toBeGreaterThan(0);
    expect(m.checks[0]!.length).toBe(stored.length);
    expect(m.records[0]!).toEqual(m.checks[0]!);
    expect(m.checks[0]!.join("")).toContain("harbour");
  });

  it("does not embed at all when the budget refuses", async () => {
    const { documentRepo, document } = await seedDocument();
    let embedCalls = 0;
    const embeddings = new EmbeddingService({
      ...DETERMINISTIC,
      embed: async (texts: string[]) => {
        embedCalls += 1;
        return texts.map(() => Array.from({ length: 8 }, () => 0.1));
      },
    });

    const refusing: EmbeddingMeter = {
      check: async () => {
        throw new Error("Daily embedding token limit would be exceeded.");
      },
      record: async () => undefined,
    };

    await expect(
      processDocumentIngestion(
        {
          documentRepo,
          chunkRepo: new PgDocumentChunkRepository(db),
          embeddings,
          embeddingMeter: refusing,
          sandboxRoot: root,
          assetRepo: new PgAssetRepository(db),
        },
        document!
      )
    ).rejects.toThrow(/embedding token limit/i);

    // The point of checking first: no provider call happened at all.
    expect(embedCalls).toBe(0);
  });

  it("meters a retrieval query when a meter is supplied, and not when it is not", async () => {
    const withMeter = meter();
    const deps = {
      chunkRepo: new PgDocumentChunkRepository(db),
      documentRepo: new PgDocumentRepository(db),
      embeddings: new EmbeddingService(DETERMINISTIC),
    };

    await searchDocuments({ ...deps, embeddingMeter: withMeter }, { projectId: PROJECT, query: "harbour", topK: 3 });
    expect(withMeter.checks).toHaveLength(1);
    expect(withMeter.records).toHaveLength(1);

    // The RAG route meters its own question, so it passes none here — one question, one charge.
    const withoutMeter = meter();
    await searchDocuments(deps, { projectId: PROJECT, query: "harbour", topK: 3 });
    expect(withoutMeter.checks).toHaveLength(0);
  });

  it("charges nothing for an empty query, because nothing is embedded", async () => {
    const m = meter();
    await searchDocuments(
      {
        chunkRepo: new PgDocumentChunkRepository(db),
        documentRepo: new PgDocumentRepository(db),
        embeddings: new EmbeddingService(DETERMINISTIC),
        embeddingMeter: m,
      },
      { projectId: PROJECT, query: "   ", topK: 3 }
    );
    expect(m.checks).toHaveLength(0);
    expect(m.records).toHaveLength(0);
  });
});
