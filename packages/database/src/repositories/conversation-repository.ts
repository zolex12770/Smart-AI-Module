import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { DrizzleDb } from "../client.js";
import { conversations } from "../schema/index.js";

export interface Conversation {
  id: string;
  title: string | null;
  createdAt: Date;
}

/**
 * Interface application code depends on — never the Drizzle table directly.
 * This is what makes the SQLite -> Postgres swap in Phase 6 (docs/26_DECISIONS.md
 * ADR-006) a new implementation of this interface, not a rewrite of callers.
 */
export interface ConversationRepository {
  create(title?: string): Promise<Conversation>;
  get(id: string): Promise<Conversation | undefined>;
}

export class PgConversationRepository implements ConversationRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(title?: string): Promise<Conversation> {
    const row = { id: uuid(), title: title ?? null, createdAt: new Date() };
    await this.db.insert(conversations).values(row);
    return row;
  }

  async get(id: string): Promise<Conversation | undefined> {
    const [row] = await this.db.select().from(conversations).where(eq(conversations.id, id));
    return row;
  }
}
