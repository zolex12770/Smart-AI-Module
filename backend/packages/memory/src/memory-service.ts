import type { MemoryItem, MemoryItemMatch, MemoryItemRepository, MemoryScope } from "@ai-platform/database";
import type { EmbeddingService } from "@ai-platform/embeddings";
import type { ChatMessage } from "@ai-platform/shared";
import { v4 as uuid } from "uuid";

/**
 * Memory that actually reaches the model — docs/26_DECISIONS.md ADR-063, docs/08_MEMORY_ARCHITECTURE.md.
 *
 * The ADR-047 audit rated memory a SKELETON for one specific reason: a repo-wide grep showed
 * the only readers of memory items were the three CRUD route handlers. Rows were stored,
 * listed and deleted; nothing was ever retrieved by relevance and nothing was ever put in
 * front of a model. A memory that never enters a prompt is a database table, not memory.
 *
 * This service closes that. It owns the whole loop:
 *
 *   store -> embed -> retrieve by relevance -> rank -> inject into context -> record use
 *
 * and, when a model is available, the extraction step that decides what was worth remembering
 * in the first place.
 *
 * Two design rules matter here:
 *
 * 1. **Retrieval is scoped before it is ranked.** Project, scope and user are SQL predicates
 *    (ADR-049), so one tenant's memory can never surface for another regardless of how
 *    similar the text is. Similarity decides *ordering within* what the caller may see.
 * 2. **A weak match is not a match.** Below the distance threshold nothing is injected. The
 *    failure mode of memory is not "missed a fact", it is "confidently injected an irrelevant
 *    one and the model believed it".
 */

export interface MemoryServiceOptions {
  /**
   * Cosine distance above which a match is discarded. Omit it and the service derives a
   * default from the embedding model, which is the only honest way to set it: the useful
   * range is a property of the embedder, not of memory.
   *
   * A learned semantic model puts related concepts genuinely close, so a tight threshold is
   * both possible and desirable. The deterministic lexical fallback cannot: measured on this
   * repository's own fixtures it scores clearly-relevant pairs at 0.67-0.80 and an unrelated
   * pair at 1.00, so a 0.55 cut-off would reject everything and memory would silently never
   * fire. The separation is real, it just sits higher up the scale.
   */
  maxDistance?: number;
  /** Ceiling on injected items, so memory cannot crowd out the actual conversation. */
  maxItems?: number;
  /** Ceiling on injected characters, for the same reason. */
  maxCharacters?: number;
  now?: () => Date;
}

export interface MemoryRetrievalRequest {
  projectId: string;
  userId: string;
  /** The text to find memories relevant to — normally the user's latest message. */
  query: string;
  /** Narrows `conversation`-scope memories to one thread. */
  conversationId?: string;
  taskId?: string;
  /** Which memory levels to open for this turn. */
  scopes?: MemoryScope[];
  limit?: number;
}

export interface RetrievedMemory {
  item: MemoryItem;
  distance: number | null;
  /** Why it was retrieved, so a UI (and a log) can explain an injected fact. */
  reason: "semantic" | "recent";
}

const DEFAULT_SCOPES: MemoryScope[] = ["user", "project", "semantic", "conversation"];

export class MemoryService {
  private readonly maxDistance: number;
  private readonly maxItems: number;
  private readonly maxCharacters: number;
  private readonly now: () => Date;

  constructor(
    private readonly repo: MemoryItemRepository,
    private readonly embeddings: EmbeddingService,
    options: MemoryServiceOptions = {}
  ) {
    // See MemoryServiceOptions.maxDistance: tight for a semantic model, looser for the
    // lexical fallback, because the two do not share a distance scale.
    this.maxDistance = options.maxDistance ?? (embeddings.isDeterministicFallback ? 0.85 : 0.55);
    this.maxItems = options.maxItems ?? 8;
    this.maxCharacters = options.maxCharacters ?? 2_000;
    this.now = options.now ?? (() => new Date());
  }

  /** Stores a memory, embedding it so it can later be retrieved by meaning rather than by id. */
  async remember(input: {
    projectId: string;
    userId: string | null;
    scope: MemoryScope;
    content: string;
    subjectId?: string | null;
    source?: "user" | "extracted" | "system";
    confidence?: number;
    provenance?: Record<string, unknown> | null;
  }): Promise<MemoryItem> {
    const content = input.content.trim();
    const embedded = await this.embedQuietly(content);
    return this.repo.create({
      id: uuid(),
      projectId: input.projectId,
      // A project-scoped memory applies to every member, so it deliberately carries no user.
      userId: input.scope === "project" ? null : input.userId,
      scope: input.scope,
      subjectId: input.subjectId ?? null,
      content,
      embedding: embedded?.vector ?? null,
      embeddingModel: embedded?.model ?? null,
      source: input.source ?? "user",
      confidence: input.confidence ?? 1,
      provenance: input.provenance ?? null,
    });
  }

  /**
   * The retrieval half of the loop. Semantic matches first; conversation/task memories are
   * additionally pulled by recency, because the most recent turn of a thread is relevant by
   * position rather than by similarity and would often fall below the distance threshold.
   */
  async retrieve(request: MemoryRetrievalRequest): Promise<RetrievedMemory[]> {
    const scopes = request.scopes ?? DEFAULT_SCOPES;
    const limit = request.limit ?? this.maxItems;
    const seen = new Set<string>();
    const out: RetrievedMemory[] = [];

    const embedded = await this.embedQuietly(request.query);
    if (embedded) {
      const matches: MemoryItemMatch[] = await this.repo.searchSemantic({
        projectId: request.projectId,
        userId: request.userId,
        queryEmbedding: embedded.vector,
        embeddingModel: embedded.model,
        scopes,
        limit,
        maxDistance: this.maxDistance,
        // Thread containment: only the conversation/task this turn belongs to. Without this
        // a memory recorded in one conversation could be recalled into another purely on
        // similarity, which is a cross-thread leak even though it stays within the tenant.
        subjectIds: [request.conversationId, request.taskId].filter((id): id is string => Boolean(id)),
      });
      for (const { distance, ...item } of matches) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push({ item, distance, reason: "semantic" });
      }
    }

    // Short-term levels: relevance is positional, not semantic.
    for (const [scope, subjectId] of [
      ["conversation", request.conversationId],
      ["task", request.taskId],
    ] as const) {
      if (!subjectId || !scopes.includes(scope)) continue;
      const recent = await this.repo.listRecent({
        projectId: request.projectId,
        userId: request.userId,
        scope,
        subjectId,
        limit: 3,
      });
      for (const item of recent) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push({ item, distance: null, reason: "recent" });
      }
    }

    const selected = out.slice(0, limit);
    // Feeds the recency/frequency signal that ranking will eventually use, and makes an
    // unused memory visible as unused rather than indistinguishable from a used one.
    if (selected.length > 0) {
      await this.repo.markUsed(selected.map((m) => m.item.id)).catch(() => undefined);
    }
    return selected;
  }

  /**
   * Renders retrieved memories as a system message. Returns null when there is nothing worth
   * injecting, so a caller never adds an empty "here is what you know" preamble.
   *
   * The wording is deliberate: the model is told these are *recalled* facts that may be stale
   * and must be overridden by the conversation, because a confidently-asserted stale memory is
   * the most damaging failure this subsystem has.
   */
  buildContextBlock(memories: RetrievedMemory[]): string | null {
    if (memories.length === 0) return null;
    const lines: string[] = [];
    let budget = this.maxCharacters;
    for (const { item } of memories) {
      const line = `- (${item.scope}) ${item.content.replace(/\s+/g, " ").trim()}`;
      if (line.length > budget) break;
      budget -= line.length;
      lines.push(line);
    }
    if (lines.length === 0) return null;
    return [
      "Recalled context about this user and project, retrieved from long-term memory:",
      ...lines,
      "",
      "Treat these as background that may be out of date. Anything stated in the current",
      "conversation takes precedence, and you should not mention this list unless it is relevant.",
    ].join("\n");
  }

  /** Convenience: retrieve, render, and prepend to a message list in one call. */
  async withMemoryContext(
    request: MemoryRetrievalRequest,
    messages: ChatMessage[]
  ): Promise<{ messages: ChatMessage[]; injected: RetrievedMemory[] }> {
    const injected = await this.retrieve(request);
    const block = this.buildContextBlock(injected);
    if (!block) return { messages, injected: [] };
    return { messages: [{ role: "system", content: block }, ...messages], injected };
  }

  /**
   * Records durable facts a model proposed from a finished exchange.
   *
   * Extraction itself is a model call and lives in the caller (it needs a router and a budget);
   * this method owns what happens to the results: trimming, de-duplication against what is
   * already known, and provenance. De-duplication is semantic rather than exact — "prefers
   * TypeScript" and "likes TypeScript" are the same fact, and storing both would let the same
   * claim crowd out the injection budget twice.
   */
  async recordExtracted(input: {
    projectId: string;
    userId: string;
    conversationId?: string;
    facts: Array<{ content: string; scope?: MemoryScope; confidence?: number }>;
  }): Promise<MemoryItem[]> {
    const stored: MemoryItem[] = [];
    for (const fact of input.facts) {
      const content = fact.content.trim();
      if (content.length < 8 || content.length > 500) continue;

      const duplicate = await this.findSimilar(input.projectId, input.userId, content);
      if (duplicate) {
        // A restatement of something already known is not new information. Supersede only
        // when the new phrasing is more specific; otherwise keep the original.
        if (content.length > duplicate.content.length * 1.3) {
          const replacement = await this.remember({
            projectId: input.projectId,
            userId: input.userId,
            scope: fact.scope ?? duplicate.scope,
            content,
            source: "extracted",
            confidence: fact.confidence ?? 0.7,
            provenance: { conversationId: input.conversationId ?? null, supersedes: duplicate.id },
          });
          await this.repo.supersede(input.projectId, duplicate.id, replacement.id);
          stored.push(replacement);
        }
        continue;
      }

      stored.push(
        await this.remember({
          projectId: input.projectId,
          userId: input.userId,
          scope: fact.scope ?? "user",
          content,
          source: "extracted",
          confidence: fact.confidence ?? 0.7,
          provenance: { conversationId: input.conversationId ?? null },
        })
      );
    }
    return stored;
  }

  private async findSimilar(projectId: string, userId: string, content: string): Promise<MemoryItem | null> {
    const embedded = await this.embedQuietly(content);
    if (!embedded) return null;
    const matches = await this.repo.searchSemantic({
      projectId,
      userId,
      queryEmbedding: embedded.vector,
      embeddingModel: embedded.model,
      scopes: ["user", "project", "semantic"],
      limit: 1,
      // Much tighter than retrieval: this asks "is this the SAME fact", not "is it relevant".
      // Scaled to the embedder for the same reason the retrieval threshold is.
      maxDistance: this.embeddings.isDeterministicFallback ? 0.25 : 0.15,
    });
    if (!matches[0]) return null;
    const { distance: _distance, ...item } = matches[0];
    return item;
  }

  /**
   * Embedding failures must never break the surrounding request. A chat turn that cannot embed
   * should proceed without memory rather than fail; the item is still stored, and remains
   * reachable by recency until it is re-embedded.
   */
  private async embedQuietly(text: string): Promise<{ vector: number[]; model: string } | null> {
    if (!text.trim()) return null;
    try {
      const embedded = await this.embeddings.embedOne(text);
      return { vector: embedded.vector, model: embedded.model };
    } catch {
      return null;
    }
  }
}

/**
 * The prompt used to decide what was worth remembering. Kept here so the wording lives beside
 * the code that consumes its output, and so a test can assert against the same string.
 *
 * It is deliberately conservative: the instruction is to return nothing at all unless a fact
 * is durable and user-specific, because the cost of a wrong memory is paid on every later turn
 * while the cost of a missed one is paid once.
 */
export const MEMORY_EXTRACTION_PROMPT = [
  "You are maintaining a long-term memory about a user and their project.",
  "From the exchange below, extract only DURABLE facts worth recalling in future, unrelated conversations:",
  "stable preferences, standing constraints, project conventions, and stated goals.",
  "",
  "Do NOT extract: anything specific to this one question, transient state, anything the",
  "assistant said, or anything you inferred rather than were told.",
  "",
  'Reply with JSON only: {"facts":[{"content":"...","scope":"user|project"}]}.',
  'If nothing is worth remembering, reply exactly {"facts":[]}.',
].join("\n");

/** Parses the extraction model's reply defensively — a malformed answer means "nothing". */
export function parseExtractedFacts(raw: string): Array<{ content: string; scope?: MemoryScope }> {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { facts?: Array<{ content?: unknown; scope?: unknown }> };
    if (!Array.isArray(parsed.facts)) return [];
    return parsed.facts
      .filter((f): f is { content: string; scope?: string } => typeof f?.content === "string")
      .map((f) => ({
        content: f.content,
        scope: f.scope === "project" ? ("project" as const) : ("user" as const),
      }));
  } catch {
    return [];
  }
}
