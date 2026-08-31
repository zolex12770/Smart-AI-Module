import { eq } from "drizzle-orm";
import type { DrizzleDb } from "../client.js";
import { memoryItems } from "../schema/index.js";

export type MemoryScope = "conversation" | "task" | "user" | "project" | "semantic";

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  ownerId: string;
  content: string;
  createdAt: Date;
}

/**
 * Real storage/retrieval/deletion for user-visible memory (docs/08_MEMORY_ARCHITECTURE.md,
 * FR-030/FR-032). Honest scope note: this does not *generate* summaries via LLM
 * reasoning — items are created verbatim by callers. Real summarization needs a real
 * model, same constraint as the planner/coding agent (docs/26_DECISIONS.md ADR-018/022).
 */
export interface MemoryItemRepository {
  create(input: { id: string; scope: MemoryScope; ownerId: string; content: string }): Promise<MemoryItem>;
  listByOwner(ownerId: string): Promise<MemoryItem[]>;
  delete(id: string): Promise<void>;
}

export class PgMemoryItemRepository implements MemoryItemRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: { id: string; scope: MemoryScope; ownerId: string; content: string }): Promise<MemoryItem> {
    const row = { ...input, createdAt: new Date() };
    await this.db.insert(memoryItems).values(row);
    return row;
  }

  async listByOwner(ownerId: string): Promise<MemoryItem[]> {
    return (await this.db.select().from(memoryItems).where(eq(memoryItems.ownerId, ownerId))) as MemoryItem[];
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(memoryItems).where(eq(memoryItems.id, id));
  }
}
