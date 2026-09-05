import { and, asc, eq, isNull } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { NotFoundError, type ChatRole, type TokenUsage, type ToolCall } from "@ai-platform/shared";
import type { DrizzleDb } from "../client.js";
import { conversations, messages } from "../schema/index.js";

export interface Message {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  /**
   * The tool calls an assistant turn asked for (ADR-047). Null on every other role — a
   * `role: "assistant"` row with no tool calls and one that was never persisted are the same
   * thing, so there is nothing to distinguish with an empty array.
   */
  toolCalls: ToolCall[] | null;
  /** Set on `role: "tool"` — which call this message answers. Null on every other role. */
  toolCallId: string | null;
  providerUsed: string | null;
  modelUsed: string | null;
  createdAt: Date;
}

export interface AddMessageInput {
  /**
   * `messages` has no `project_id` of its own — it inherits scope through its NOT NULL FK to
   * `conversations` (ADR-049). The project is still required here so the write can be
   * authorized in SQL against the parent rather than trusted from the caller.
   */
  projectId: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  providerUsed?: string;
  modelUsed?: string;
  usage?: TokenUsage;
}

export interface MessageRepository {
  /**
   * Appends a message, but only if `conversationId` really belongs to `projectId`. Throws
   * `NotFoundError` otherwise — the same error a genuinely unknown id produces, so a caller
   * cannot use this endpoint to discover which conversation ids exist in other projects.
   */
  add(input: AddMessageInput): Promise<Message>;
  /**
   * The full transcript, oldest first. The conversation's ownership is verified by the join
   * in this same statement: a conversation in another project (or a soft-deleted one) simply
   * produces no rows, so there is never a fetched-then-checked message list (ADR-049).
   */
  listByConversation(projectId: string, conversationId: string): Promise<Message[]>;
}

export class PgMessageRepository implements MessageRepository {
  constructor(private readonly db: DrizzleDb) {}

  async add(input: AddMessageInput): Promise<Message> {
    const now = new Date();
    const message: Message = {
      id: uuid(),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      toolCalls: input.toolCalls ?? null,
      toolCallId: input.toolCallId ?? null,
      providerUsed: input.providerUsed ?? null,
      modelUsed: input.modelUsed ?? null,
      createdAt: now,
    };

    // Two rows change together — the child row appears and the parent's activity clock
    // moves — so they go in one transaction. A partial apply would leave a conversation
    // whose `updated_at` disagrees with its own newest message.
    await this.db.transaction(async (tx) => {
      // Authorization and the `updated_at` bump are the same statement: the project check
      // lives in this UPDATE's WHERE, so a conversation in another project matches nothing
      // and `returning` comes back empty. Nothing is ever fetched and then compared.
      const [parent] = await tx
        .update(conversations)
        .set({ updatedAt: now })
        .where(
          and(
            eq(conversations.id, input.conversationId),
            eq(conversations.projectId, input.projectId),
            isNull(conversations.deletedAt)
          )
        )
        .returning({ id: conversations.id });

      if (!parent) {
        throw new NotFoundError(`Conversation "${input.conversationId}" not found.`);
      }

      await tx.insert(messages).values({
        ...message,
        inputTokens: input.usage?.inputTokens ?? null,
        outputTokens: input.usage?.outputTokens ?? null,
      });
    });

    return message;
  }

  async listByConversation(projectId: string, conversationId: string): Promise<Message[]> {
    const rows = await this.db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        role: messages.role,
        content: messages.content,
        toolCalls: messages.toolCalls,
        toolCallId: messages.toolCallId,
        providerUsed: messages.providerUsed,
        modelUsed: messages.modelUsed,
        createdAt: messages.createdAt,
      })
      .from(messages)
      // An inner join, not a subquery the planner may or may not push down: a message whose
      // conversation fails the project predicate is eliminated before any row is returned.
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(conversations.projectId, projectId),
          isNull(conversations.deletedAt)
        )
      )
      .orderBy(asc(messages.createdAt));

    return rows.map((row) => ({
      ...row,
      // `jsonb` is `unknown` at the type level because Postgres will hand back whatever was
      // written; the shape is guaranteed by `add` being the only writer (ADR-047).
      toolCalls: (row.toolCalls as ToolCall[] | null) ?? null,
    }));
  }
}
