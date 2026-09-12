import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, PgMemoryItemRepository, type PgliteDb } from "@ai-platform/database";
import { EmbeddingService, HashEmbeddingProvider } from "@ai-platform/embeddings";
import { organizations, projects, users } from "@ai-platform/database";
import { v4 as uuid } from "uuid";
import { MEMORY_EXTRACTION_PROMPT, MemoryService, parseExtractedFacts } from "./memory-service.js";

/**
 * ADR-063. The claim this file exists to prove is the one the ADR-047 audit said could not be
 * made: **memory influences what the model sees.** A stored row that never enters a prompt is
 * a database table, so the central test here asserts on the message array handed to the model,
 * not on the contents of the database.
 *
 * Everything runs against a real embedded Postgres with real pgvector and the real repository.
 */
describe("MemoryService", () => {
  let db: PgliteDb;
  let service: MemoryService;
  let projectId: string;
  let otherProjectId: string;
  let userId: string;
  let otherUserId: string;

  beforeEach(async () => {
    db = await createDb(":memory:");
    await runMigrations(db);

    const now = new Date();
    const orgId = uuid();
    userId = uuid();
    otherUserId = uuid();
    projectId = uuid();
    otherProjectId = uuid();

    await db.insert(organizations).values({ id: orgId, name: "Org", createdAt: now, updatedAt: now });
    await db.insert(users).values([
      { id: userId, email: "a@example.com", passwordHash: "x", displayName: "A", createdAt: now, updatedAt: now },
      { id: otherUserId, email: "b@example.com", passwordHash: "x", displayName: "B", createdAt: now, updatedAt: now },
    ]);
    await db.insert(projects).values([
      { id: projectId, organizationId: orgId, name: "P1", createdAt: now, updatedAt: now },
      { id: otherProjectId, organizationId: orgId, name: "P2", createdAt: now, updatedAt: now },
    ]);

    service = new MemoryService(new PgMemoryItemRepository(db), new EmbeddingService(new HashEmbeddingProvider()));
  });

  afterEach(async () => {
    await db.$client.close();
  });

  describe("the loop: store -> retrieve -> inject", () => {
    it("INJECTS a relevant memory into the messages sent to the model", async () => {
      await service.remember({
        projectId,
        userId,
        scope: "user",
        content: "The user deploys with Terraform and prefers Terraform over Pulumi.",
      });

      const before = [{ role: "user" as const, content: "Which terraform workspace should I deploy with?" }];
      const { messages, injected } = await service.withMemoryContext(
        { projectId, userId, query: before[0].content },
        before
      );

      // The observable effect: the model's input changed.
      expect(messages.length).toBe(before.length + 1);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain("Terraform");
      expect(injected).toHaveLength(1);
      // And the original conversation is untouched and still last.
      expect(messages.at(-1)).toEqual(before[0]);
    });

    it("injects NOTHING when no memory is relevant, rather than padding the prompt", async () => {
      await service.remember({
        projectId,
        userId,
        scope: "user",
        content: "The user deploys with Terraform and prefers Terraform over Pulumi.",
      });

      const before = [{ role: "user" as const, content: "What is a good recipe for sourdough bread?" }];
      const { messages, injected } = await service.withMemoryContext(
        { projectId, userId, query: before[0].content },
        before
      );

      expect(injected).toEqual([]);
      expect(messages).toEqual(before);
    });

    it("returns an empty context block rather than an empty preamble", () => {
      expect(service.buildContextBlock([])).toBeNull();
    });

    it("records that a retrieved memory was actually used", async () => {
      const item = await service.remember({
        projectId,
        userId,
        scope: "user",
        content: "The user writes documentation in Markdown with reference links.",
      });
      expect(item.useCount).toBe(0);

      await service.retrieve({ projectId, userId, query: "how should I write the markdown docs?" });

      const [row] = await new PgMemoryItemRepository(db).listRecent({ projectId, userId, limit: 10 });
      expect(row.useCount).toBeGreaterThan(0);
      expect(row.lastUsedAt).not.toBeNull();
    });
  });

  describe("isolation — a memory is never recalled across a boundary", () => {
    it("never retrieves another PROJECT's memory, however similar", async () => {
      await service.remember({
        projectId: otherProjectId,
        userId,
        scope: "user",
        content: "The user deploys with Terraform and prefers Terraform over Pulumi.",
      });

      const found = await service.retrieve({ projectId, userId, query: "terraform deployment preference" });
      expect(found).toEqual([]);
    });

    it("never retrieves another USER's user-scoped memory in a shared project", async () => {
      await service.remember({
        projectId,
        userId: otherUserId,
        scope: "user",
        content: "The user deploys with Terraform and prefers Terraform over Pulumi.",
      });

      const found = await service.retrieve({ projectId, userId, query: "terraform deployment preference" });
      expect(found).toEqual([]);
    });

    it("DOES share a project-scoped memory with every member", async () => {
      await service.remember({
        projectId,
        userId: otherUserId,
        scope: "project",
        content: "This project deploys with Terraform to Cloud Run.",
      });

      const found = await service.retrieve({ projectId, userId, query: "terraform deployment target" });
      expect(found).toHaveLength(1);
      expect(found[0].item.userId).toBeNull();
    });
  });

  describe("short-term memory", () => {
    it("pulls recent conversation memory by position even when similarity is weak", async () => {
      const conversationId = uuid();
      await service.remember({
        projectId,
        userId,
        scope: "conversation",
        subjectId: conversationId,
        content: "Earlier in this thread the user chose the blue variant.",
      });

      const found = await service.retrieve({
        projectId,
        userId,
        conversationId,
        query: "completely unrelated question about tax law",
      });
      expect(found).toHaveLength(1);
      expect(found[0].reason).toBe("recent");
    });

    it("does not leak one conversation's short-term memory into another", async () => {
      const a = uuid();
      const b = uuid();
      await service.remember({
        projectId,
        userId,
        scope: "conversation",
        subjectId: a,
        content: "In thread A the user chose the blue variant.",
      });
      const found = await service.retrieve({ projectId, userId, conversationId: b, query: "which variant?" });
      expect(found).toEqual([]);
    });
  });

  describe("extraction", () => {
    it("stores extracted facts with provenance and a lower confidence than user-stated ones", async () => {
      const stored = await service.recordExtracted({
        projectId,
        userId,
        conversationId: "conv-1",
        facts: [{ content: "The user's production database is PostgreSQL 16 on Cloud SQL." }],
      });

      expect(stored).toHaveLength(1);
      expect(stored[0].source).toBe("extracted");
      expect(stored[0].confidence).toBeLessThan(1);
      expect(stored[0].provenance).toMatchObject({ conversationId: "conv-1" });
    });

    it("does not store a restatement of something already known", async () => {
      const content = "The user's production database is PostgreSQL 16 on Cloud SQL.";
      await service.recordExtracted({ projectId, userId, facts: [{ content }] });
      const second = await service.recordExtracted({ projectId, userId, facts: [{ content }] });
      expect(second).toEqual([]);
    });

    it("rejects facts that are too short or implausibly long", async () => {
      const stored = await service.recordExtracted({
        projectId,
        userId,
        facts: [{ content: "yes" }, { content: "x".repeat(600) }],
      });
      expect(stored).toEqual([]);
    });
  });

  describe("parseExtractedFacts", () => {
    it("parses a well-formed reply", () => {
      expect(parseExtractedFacts('{"facts":[{"content":"Prefers TypeScript","scope":"user"}]}')).toEqual([
        { content: "Prefers TypeScript", scope: "user" },
      ]);
    });

    it("tolerates a model that wraps its JSON in prose or a code fence", () => {
      const raw = 'Sure!\n```json\n{"facts":[{"content":"Uses pnpm","scope":"project"}]}\n```';
      expect(parseExtractedFacts(raw)).toEqual([{ content: "Uses pnpm", scope: "project" }]);
    });

    it("treats malformed or empty output as nothing to remember, never as an error", () => {
      expect(parseExtractedFacts("I could not find anything.")).toEqual([]);
      expect(parseExtractedFacts('{"facts": "not an array"}')).toEqual([]);
      expect(parseExtractedFacts('{"facts":[]}')).toEqual([]);
      expect(parseExtractedFacts("{ broken json")).toEqual([]);
    });

    it("defaults an unrecognised scope to user rather than dropping the fact", () => {
      expect(parseExtractedFacts('{"facts":[{"content":"Something","scope":"nonsense"}]}')).toEqual([
        { content: "Something", scope: "user" },
      ]);
    });

    it("ships an extraction prompt that tells the model to return nothing when unsure", () => {
      expect(MEMORY_EXTRACTION_PROMPT).toContain('{"facts":[]}');
      expect(MEMORY_EXTRACTION_PROMPT).toMatch(/DURABLE/);
    });
  });
});
