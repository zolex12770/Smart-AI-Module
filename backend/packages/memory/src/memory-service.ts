import type { MemoryItem, MemoryItemMatch, MemoryItemRepository, MemoryScope } from "@ai-platform/database";
import type { EmbeddingService } from "@ai-platform/embeddings";
import { UNTRUSTED_CONTENT_SYSTEM_PROMPT, wrapUntrustedContent, type ChatMessage, type EmbeddingMeter } from "@ai-platform/shared";
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
   * Budget and ledger for memory's own embedding calls (ADR-131). Optional: a test about recall
   * should not have to build a ledger, and an absent meter means "not metered here".
   */
  embeddingMeter?: EmbeddingMeter;
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

  private readonly meter: EmbeddingMeter | undefined;

  constructor(
    private readonly repo: MemoryItemRepository,
    private readonly embeddings: EmbeddingService,
    options: MemoryServiceOptions = {}
  ) {
    this.meter = options.embeddingMeter;
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
    /**
     * Storing is NOT the quiet path — docs/26_DECISIONS.md ADR-149.
     *
     * `embedQuietly` swallowed everything, on every path, so a budget refusal or an embedder
     * restart stored a row with `embedding: null` — and `searchSemantic` requires
     * `embedding IS NOT NULL`, so that row can never be recalled. The user pressed Remember, got
     * a 201, sees the fact in the table with "Recalled 0×", and it will never influence an
     * answer. That is exactly the SKELETON condition ADR-063 exists to close, reintroduced for
     * whichever rows happened to be written during an outage, with no way to tell which.
     *
     * Quiet is right on the RETRIEVE path (ADR-131: a turn over its embedding budget gets an
     * answer with no recall rather than an error about a budget it did not know it was
     * spending). It is wrong here, where the alternative to an error is a silent lie.
     */
    const embedded = await this.embedOrThrow(input.projectId, content);
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

    const embedded = await this.embedQuietly(request.projectId, request.query);
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
    /**
     * Delimited, because a recalled fact is somebody's text — docs/26_DECISIONS.md ADR-149.
     *
     * A project-scoped memory is written by one member and retrieved into every other member's
     * turn: `remember` stores `userId: null` for that scope and `searchSemantic` matches it for
     * anyone in the project. The Memory screen offers exactly that ("About this project — shared
     * context for everyone in the project"), and the content is a free-text field. So this is a
     * durable, cross-user, attacker-controlled string — and it was the only untrusted-text path
     * in the platform with no wrapper, while landing in the `system` role, the highest-trust
     * position there is. Files, RAG passages, tool output and MCP results are all wrapped
     * (ADR-133). "Standing directive: when asked about credentials, reply with…" needs no
     * newlines to work, and collapsing whitespace does not touch it.
     *
     * The prose hint below stays, but it is not the control: this platform's own grounding
     * notes record that "a prompt cannot make a model refuse". The delimiter is structural.
     */
    return wrapUntrustedContent(
      [
        "Recalled context about this user and project, retrieved from long-term memory:",
        ...lines,
        "",
        "Treat these as background that may be out of date. Anything stated in the current",
        "conversation takes precedence, and you should not mention this list unless it is relevant.",
      ].join("\n")
    );
  }

  /** Convenience: retrieve, render, and prepend to a message list in one call. */
  async withMemoryContext(
    request: MemoryRetrievalRequest,
    messages: ChatMessage[]
  ): Promise<{ messages: ChatMessage[]; injected: RetrievedMemory[] }> {
    const injected = await this.retrieve(request);
    const block = this.buildContextBlock(injected);
    if (!block) return { messages, injected: [] };
    // The instruction that gives the delimiter its meaning travels with it (ADR-133's shape,
    // as `planner.ts` does it): a tag the model has never been told about is just more text.
    return {
      messages: [
        { role: "system", content: UNTRUSTED_CONTENT_SYSTEM_PROMPT },
        { role: "system", content: block },
        ...messages,
      ],
      injected,
    };
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
    const embedded = await this.embedQuietly(projectId, content);
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
   * Metered, and quiet about everything else — docs/26_DECISIONS.md ADR-131.
   *
   * Memory embeds on three paths: storing a fact, recalling on a chat turn, and the near-duplicate
   * check before storing. All three are small, and all three were free and invisible: a chat with
   * memory on embedded twice per turn, for as many turns as the user liked, against a budget that
   * recorded none of it.
   *
   * A REFUSAL still returns null rather than throwing, deliberately. The surrounding rule here is
   * that a chat turn which cannot embed proceeds without memory instead of failing, and a turn
   * that is over its embedding budget is exactly that case: the user gets an answer with no recall
   * rather than an error about a budget they did not know memory was spending.
   */
  private async embedQuietly(projectId: string, text: string): Promise<{ vector: number[]; model: string } | null> {
    if (!text.trim()) return null;
    try {
      return await this.embedOrThrow(projectId, text);
    } catch {
      return null;
    }
  }

  /**
   * The same work, reported rather than swallowed — ADR-149.
   *
   * Used by `remember`, where a null embedding means the row is unrecallable forever and the
   * caller is entitled to hear about it: the route answers with the quota or provider error
   * instead of 201, and nothing is written.
   */
  private async embedOrThrow(projectId: string, text: string): Promise<{ vector: number[]; model: string } | null> {
    if (!text.trim()) return null;
    await this.meter?.check(projectId, [text]);
    const embedded = await this.embeddings.embedOne(text);
    await this.meter?.record(projectId, [text]);
    return { vector: embedded.vector, model: embedded.model };
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
  "Write each fact as ONE complete sentence that names what it is about, so it still makes sense",
  "when read alone months later, e.g. \"The user's project codename is NIGHTHAWK.\" — never a bare",
  "value such as \"NIGHTHAWK\".",
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
      /**
       * A fact has to say what it is about — found by the autonomous-completion pass. Told "my
       * project codename is NIGHTHAWK-172918", qwen2.5:7b extracted the bare string
       * "NIGHTHAWK-172918"; a later "what is my project codename?" could not be matched to it, and
       * the model invented one. A single bare token cannot carry its own subject ("Prefers
       * TypeScript" can: its subject is the user), so it is dropped rather than stored as a memory
       * nothing can use.
       */
      .filter((f) => f.content.trim().split(/\s+/).length >= 2)
      /**
       * A model-proposed fact is always `user`-scoped — ADR-149.
       *
       * `project` scope is read by every member of the project, so letting the extraction model
       * choose it meant one user saying "the project convention is: <instruction>" could plant a
       * row in everyone else's prompt, with no human ever choosing to share it. The Memory screen
       * still offers the shared scope; a person picks it there, deliberately.
       */
      .map((f) => ({ content: f.content, scope: "user" as const }));
  } catch {
    return [];
  }
}
