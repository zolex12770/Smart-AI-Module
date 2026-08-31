# Memory Architecture

This document designs multi-level memory for our agent platform: what the agent remembers about conversations, users, projects, tasks, and tools, how raw history gets promoted to durable facts, how memory is retrieved, and what controls the user has over it. §6 draws the explicit boundary against `09_RAG_ARCHITECTURE.md`.

Tags: **PUBLICLY DOCUMENTED** / **INFERRED** / **ASSUMED** / **UNKNOWN** apply to claims about specific commercial products' internals.

---

## 1. Why Multiple Memory Levels, Not One Store

A single flat "memory" table conflates things with very different lifetimes, scopes, and failure costs: a fact true only for one conversation (what file we're currently editing) should not have the same durability or visibility as a fact true about the user forever (they prefer TypeScript over JavaScript). Treating them uniformly produces two failure modes seen repeatedly in production memory systems: **stale facts that should have expired** (a project that ended six months ago still influencing suggestions) and **facts that should have been remembered but weren't** (a user's stated constraint from three sessions ago, lost because it was only ever in raw conversation history and that conversation aged out). Separating memory into levels with distinct promotion/expiry rules is how both failure modes get addressed independently rather than traded off against each other.

## 2. The Six Levels

| Level | Scope | Typical lifetime | Example content |
|---|---|---|---|
| **Conversation memory** | Single chat thread | Duration of the thread, or until compacted | The last N turns verbatim; the running topic |
| **Task memory** | Single task/task-graph execution (see `11_AGENT_LOOP.md`) | Duration of the task, persisted for resumability, archived after completion | Plan steps, intermediate tool results, current task state |
| **Tool memory** | A specific tool's usage history for this user/org | Rolling window, or until superseded | "Last time this API returned a 429, backing off worked"; cached auth state; per-tool usage patterns that inform retry/timeout tuning |
| **User memory** | One user, across all their conversations/projects | Long-term, user-controlled | Stated preferences, working style, recurring context ("I work primarily in Python") |
| **Project memory** | One project/workspace, shared by anyone with access to it | Long-term, tied to project lifecycle | Architecture decisions, conventions, "we decided not to use library X because Y" |
| **Semantic / long-term memory** | Cross-cutting, derived facts promoted from any of the above | Long-term, until explicitly invalidated or superseded | Distilled, embeddable facts retrievable by similarity rather than recency — the substrate the other levels get promoted into once they're durable and general enough |

Conversation and task memory are **short-term / working memory** — they live in or near the active context window and decay naturally as the thread or task ends. User, project, and semantic memory are **long-term memory** — they persist indefinitely and are retrieved on demand rather than always being in context. Tool memory sits in between: it's operationally long-lived but narrow in scope (this tool, not general knowledge about the user).

## 3. Summarization Strategies for Long Conversations

Three approaches, in increasing sophistication, map onto three real tradeoffs (documented across 2025–2026 practitioner writeups on context-window management):

1. **Sliding window truncation** — keep only the last N turns, drop the rest. Simplest, cheapest, but "fundamentally a brute-force approach that inevitably leads to loss of long-term context" — anything outside the window is gone with no recovery path.
2. **Flat summarization** — once a conversation nears a size threshold, replace the older portion with a single LLM-generated summary, keep recent turns verbatim. Better retention than pure truncation, but carries an "abstraction hazard": a single summarization pass can flatten away a specific detail (an exact number, a exact constraint) that later turns out to matter, with no way to recover it since the raw text is gone.
3. **Rolling/hierarchical (tiered) summarization** — the pattern we adopt. As a conversation grows, older content is compressed progressively rather than in one lossy pass: recent turns stay verbatim; the next tier back becomes a per-topic summary; older tiers get summarized-again into a "summary of summaries." One documented production implementation compresses older messages into a summary once a conversation crosses roughly 80% of the model's usable context budget, always keeping the most recent turns verbatim — and combining this with relevance-based retrieval and structured memory extraction was reported to cut average tokens per request by roughly 64% (from ~18,000 to ~6,500) in one case study, without a corresponding drop in answer quality, because the *right* older content stays reachable via retrieval instead of being kept verbatim just in case.

**Design decision for our platform**: implement tiered rolling summarization as the default conversation-memory compaction strategy, matching Anthropic's documented "compaction" pattern (`02_AI_AGENT_RESEARCH.md` §2.1) — summarize when nearing a context threshold, explicitly instructing the summarizer to preserve decisions, constraints, and open questions while discarding resolved tool chatter and redundant exchanges. Critically: **the pre-summarization raw transcript is archived, not discarded** — summarization compacts what goes into the *active* context window; it does not delete the underlying record, so a later "what exactly did I say about X" query (whether from the user or from a semantic-memory promotion step) can still go back to source. This is the same distinction RAG draws between an index and the source document (`09_RAG_ARCHITECTURE.md` §7) applied to conversation history.

## 4. Promotion: When Raw History Becomes a Durable Fact

Not everything said in a conversation deserves to become long-term (user/project/semantic) memory — most of it is transient task detail. The promotion decision needs an explicit rule, not "the model decides to remember things whenever it feels like it," because under-promotion loses genuinely useful context and over-promotion pollutes long-term memory with noise that then gets retrieved into unrelated future conversations.

**Promotion triggers** (ASSUMED design, informed by documented patterns from ChatGPT's and Claude's memory features, §5):

- **Explicit user instruction** ("remember that I prefer X," "don't suggest Y again") — always promoted immediately, at the appropriate level (user vs. project, inferred from context or asked if ambiguous), and given priority over any conflicting inferred fact.
- **Stated, stable preference or constraint** inferred from natural conversation (a coding style, a tech stack, a recurring goal) — promoted to user/project memory, but only after being asserted consistently rather than off one mention, and tagged with a confidence/provenance marker distinguishing "the user told me directly" from "I inferred this from behavior."
- **Task-level decisions with future relevance** (an architectural choice, a naming convention adopted for a project) — promoted to project memory when the task completes, not while still in flux, so an abandoned mid-task idea doesn't get promoted just because it was discussed.
- **Corrections** — if the user contradicts a previously promoted fact, the old fact is not silently overwritten in place; it is superseded with a timestamp and provenance trail (see §5 user controls) so "why does it think X" is always answerable and reversible, mirroring the "correct it in one place, it's correct everywhere" UX Claude's memory feature documents.

**What should NOT be promoted**: anything the user marked or treated as one-off/hypothetical ("what if I used X instead"), anything from a Temporary/incognito-equivalent session (see §5), and raw tool output/intermediate task state — that belongs in task memory (archived, not promoted) unless a *derived conclusion* from it is itself worth keeping.

## 5. How Production Systems Approach This (Documented Examples)

**ChatGPT memory** (OpenAI) — **PUBLICLY DOCUMENTED**: two explicit mechanisms — "saved memories" (facts the user directly told it to remember, or the model chose to save, functioning like auto-maintained custom instructions and always included in context unless disabled) and "chat history" (softer, inferred personalization signal drawn from past chats, not guaranteed to surface any specific detail). Users can disable either mechanism independently, and "Temporary Chats" use neither existing memory nor create new memory. OpenAI has also documented ongoing refinement of *how* memories are formed and reconciled over time (their "Dreaming" work on offline memory consolidation), suggesting memory promotion itself is treated as a tunable process, not a fixed rule, even at that scale.

**Claude memory** (Anthropic) — **PUBLICLY DOCUMENTED**: memory is added incrementally *during* a conversation rather than only via an end-of-conversation summarization pass ("mention your deadline moved and the next conversation already knows, without saying 'remember this'"), stored as discrete, user-visible, user-editable files organized by topic, with **project-scoped memory kept separate from other projects and general chat** — directly matching the project-level distinction in our design (§2). A separate, explicitly different mechanism is Claude's **memory tool** for the agent/API surface: a client-side tool where the agent reads/writes files under a `/memories` directory that the *host application* — not Anthropic — actually stores and executes against; this is architecturally the closest public analog to what we propose in §2's task/tool memory (the host owns the storage and the trust boundary, the model just requests reads/writes). **PUBLICLY DOCUMENTED.**

**MemGPT / Letta** — **PUBLICLY DOCUMENTED** (project's own docs) — the most directly relevant published architecture, structured explicitly as an OS-memory-hierarchy analogy:
- **Core memory**: small, always-in-context editable blocks (e.g., a "user" block, a "persona"/task-state block) — analogous to RAM. The agent itself can call tools (`core_memory_append`, `core_memory_replace`) to edit these.
- **Archival memory**: long-term storage for facts that don't need to be in-context at all times (e.g., "a company handbook") — analogous to disk — backed in Letta's reference implementation by Postgres + pgvector, retrieved via similarity search (`archival_memory_search`) through a server-side endpoint that does not itself invoke the LLM.
- **Recall memory / conversation search**: a `conversation_search` tool lets the agent query its own past conversation history directly, distinct from both core and archival memory.

This maps closely onto our design: MemGPT's "core memory" ≈ our conversation + active task memory; "archival memory" ≈ our semantic/long-term memory (and is *literally* pgvector-backed, which validates the shared-infrastructure argument made in `09_RAG_ARCHITECTURE.md` §5.3 — memory and RAG can reasonably share a vector store even though they are logically distinct subsystems); "recall memory" ≈ our conversation-memory archive described in §3.

## 6. Embedding-Based Retrieval of Memory

Long-term memory (user, project, semantic levels) should be retrievable by semantic similarity, not just by exact key lookup, for the same reason RAG uses vector search over document chunks (`09_RAG_ARCHITECTURE.md` §5): a relevant memory ("user dislikes verbose responses") should surface for a query that doesn't share exact keywords with how it was originally phrased. Concretely:

- Each promoted memory fact is stored as a short, atomic, embeddable text unit — not a long narrative block — following the same "small, self-describing chunk" principle as RAG chunking (`09_RAG_ARCHITECTURE.md` §3), because a memory fact bundled with five unrelated facts in one blob degrades retrieval precision the same way an oversized document chunk does.
- Retrieval at the start of a turn (or task) queries the relevant memory levels (user + active project, generally not other users'/projects' memory) via hybrid search (embedding similarity + recency/frequency-of-use signal) and injects only the top-K most relevant facts — mirroring Anthropic's "just-in-time retrieval" context-engineering principle (`02_AI_AGENT_RESEARCH.md` §2.1): don't pre-load a user's entire memory store into every system prompt, pull what's relevant to *this* turn.
- Memory retrieval and RAG retrieval can share the same underlying vector index infrastructure (as MemGPT/Letta's pgvector-backed archival memory demonstrates is a proven pattern) but must remain **logically separate indexes/namespaces** with separate access-control scoping — a memory fact about User A must never be retrievable into a conversation with User B, which is a stronger and simpler isolation requirement than typical document-level RAG permissions and should be enforced structurally (separate namespace/partition keyed by user/project id), not just by a metadata filter that could be misconfigured.

## 7. User-Facing Memory Controls

Every documented consumer memory feature (ChatGPT, Claude) converges on the same minimum bar, which we treat as a requirement, not an aspiration:

- **View**: a user can see a list of discrete, human-readable memory items (not a raw database dump) — Claude's "Topics" file-per-memory-item model and ChatGPT's "saved memories" list are both documented implementations of this.
- **Edit**: a user can correct a specific memory item in place, and that correction propagates to all future retrieval of it — not just to future conversations that happen to re-derive the fact.
- **Delete**: a user can delete an individual memory item, or clear a whole level (e.g., all project memory for one project, or all memory for their account) — deletion should be a hard delete of the retrievable/embedded copy, not a soft "hidden but still influencing retrieval" flag.
- **Disable**: a user can turn off memory formation entirely, or per-level (e.g., allow project memory but disable cross-project user memory), and must have a "temporary/incognito" mode that guarantees neither reading from nor writing to any memory level for that session — matching ChatGPT's Temporary Chat behavior.
- **Provenance visibility**: for any memory item, the user should be able to see *why* the agent believes it (explicit statement vs. inferred, and roughly when/where) — this is what makes correction trustworthy rather than a black box, and is a natural extension of the supersede-with-provenance design in §4.

These controls are a genuine product/compliance requirement, not just good UX: memory that silently accumulates and cannot be inspected or deleted is functionally an undisclosed profile, which is the kind of thing data-protection regimes (and reasonable users) object to regardless of platform.

## 8. Memory vs. RAG — Explicit Boundary (Summary)

Full comparison lives in `09_RAG_ARCHITECTURE.md` §7; the essential distinction restated from the memory side:

- **RAG answers**: "what do the documents say?" — the source of truth is external content the agent doesn't own or generate; RAG's job is indexing and retrieving *someone else's* content faithfully.
- **Memory answers**: "what has the agent itself learned about this user/project through interaction?" — the memory store *is* the source of truth; there is no separate original to fall out of sync with, only the promotion/correction process described in §4.
- They **interact** at context-assembly time (a single turn may draw on both) and can **share infrastructure** (a vector index, as MemGPT/Letta's pgvector-backed archival memory shows) but must remain **separate logical subsystems** with separate access-control models, separate promotion/decay rules, and separate user-facing controls — collapsing them into one undifferentiated "context store" is the design mistake this document and `09_RAG_ARCHITECTURE.md` are both structured to avoid.

---

## Sources

- OpenAI Help Center, "Memory FAQ" — https://help.openai.com/en/articles/8590148-memory-faq
- OpenAI, "Memory and new controls for ChatGPT" — https://openai.com/index/memory-and-new-controls-for-chatgpt/
- OpenAI, "Dreaming: Better memory for a more helpful ChatGPT" — https://openai.com/index/chatgpt-memory-dreaming/
- Claude/Anthropic, "Claude's memory works everywhere, and you decide what's in it" — https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it
- Anthropic, "Memory tool" (Claude Platform Docs) — https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Letta, "Agent Memory: How to Build Agents That Learn and Remember" — https://www.letta.com/blog/agent-memory/
- Letta Docs, "MemGPT Agents (Legacy)" — https://docs.letta.com/guides/legacy/memgpt_agents_legacy
- dev.to (adamo_software), "How we handle LLM context window limits without losing conversation quality" — https://dev.to/adamo_software/how-we-handle-llm-context-window-limits-without-losing-conversation-quality-1eh5
- Anthropic, "Effective Context Engineering for AI Agents" (cross-referenced from `02_AI_AGENT_RESEARCH.md`) — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
