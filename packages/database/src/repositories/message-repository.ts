import { asc, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { ChatRole, TokenUsage } from "@ai-platform/shared";
import type { DrizzleDb } from "../client.js";
import { messages } from "../schema/index.js";

export interface Message {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  providerUsed: string | null;
  modelUsed: string | null;
  createdAt: Date;
}

export interface AddMessageInput {
  conversationId: string;
  role: ChatRole;
  content: string;
  providerUsed?: string;
  modelUsed?: string;
  usage?: TokenUsage;
}

export interface MessageRepository {
  add(input: AddMessageInput): Promise<Message>;
  listByConversation(conversationId: string): Promise<Message[]>;
}

export class PgMessageRepository implements MessageRepository {
  constructor(private readonly db: DrizzleDb) {}

  async add(input: AddMessageInput): Promise<Message> {
    const row = {
      id: uuid(),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      providerUsed: input.providerUsed ?? null,
      modelUsed: input.modelUsed ?? null,
      inputTokens: input.usage?.inputTokens ?? null,
      outputTokens: input.usage?.outputTokens ?? null,
      createdAt: new Date(),
    };
    await this.db.insert(messages).values(row);
    return row;
  }

  async listByConversation(conversationId: string): Promise<Message[]> {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));
  }
}
