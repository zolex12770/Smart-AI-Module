# RAG Architecture

This document designs the retrieval-augmented generation (RAG) pipeline for our platform: how external documents get parsed, chunked, embedded, indexed, retrieved, reranked, and cited. RAG here means grounding the agent's answers in **external content the user or organization brings in** (documents, wikis, codebases, web pages) — this is distinct from `08_MEMORY_ARCHITECTURE.md`, which covers the agent's own accumulated conversational/task state. §7 makes that boundary explicit.

Tags: **PUBLICLY DOCUMENTED** / **INFERRED** / **ASSUMED** / **UNKNOWN** apply to claims about specific commercial products.

---

## 1. Pipeline Overview

```
Source Document → Parse → Clean → Chunk → Extract Metadata → Embed → Index
                                                                          │
User Query → Query Embed ──────┬─────────────────────────────────────────┤
                                ├──► Hybrid Retrieval (BM25 + Vector) ────┤
                                │                                        ▼
                                │                                  Candidate Set
                                │                                        │
                                │                                        ▼
                                └──► Rerank (cross-encoder) ──► Top-K Context
                                                                        │
                                                                        ▼
                                                          Context Assembly + Citations
                                                                        │
                                                                        ▼
                                                                  LLM Generation
```

Every stage introduces its own error mode (bad parse → bad chunk → bad embedding → bad retrieval → bad citation), so the design below treats each as independently testable rather than one monolithic "RAG system."

## 2. Parsing and Cleaning by Source Type

| Source type | Parsing approach | Key pitfalls |
|---|---|---|
| **PDF** | Layout-aware extraction (not naive text dump) — detect columns, tables, headers/footers, page numbers so text isn't interleaved out of order. Table extraction should preserve row/column structure (e.g., emit as Markdown tables) rather than flattening to word-soup. | Financial/scanned PDFs are the hardest case: 2026 benchmark work on PDF parsing for financial QA shows parser choice and table-handling strategy materially change downstream RAG accuracy — page-level chunking specifically "wins for paginated financial PDFs" because it keeps a table intact with its surrounding caption/context. |
| **DOCX** | Use the document's own structural markup (headings, lists, tables) to preserve section hierarchy — don't flatten to plain text before chunking, since heading levels are valuable chunk-boundary and metadata signal. | Tracked changes/comments should be stripped or explicitly flagged, not silently included as if they were final content. |
| **Markdown** | Parse the AST (headings, code fences, tables) rather than treating it as plain text — heading hierarchy becomes a natural chunk boundary and metadata field (`section_path`). | Code fences inside Markdown should be tagged with their language and, where large, chunked with the code-specific strategy below rather than the prose strategy. |
| **CSV / tabular** | Do not chunk by raw character count — chunk by logical row groups, and always carry the header row (or a synthesized schema description) into every chunk so a chunk is self-describing out of context. Consider row-to-sentence templating for narrow tables ("On 2026-03-01, revenue was $X in region Y") to make rows embeddable/retrievable as natural language. | A chunk of 50 raw CSV rows with no header is nearly useless to both keyword and vector search. |
| **Code** | Chunk along syntactic boundaries (function/class/method) using a parser (tree-sitter is the de facto standard — this is exactly what Aider's repo-map feature uses to build a ranked, symbol-aware view of a codebase, see `03_EXISTING_AGENT_ARCHITECTURES.md`), not fixed character windows that can split a function mid-body. | Cross-file references (a function calling another file's function) are lost by pure per-file chunking; a call-graph or import-graph metadata layer (as in Aider's PageRank-style repo map) recovers some of this. |
| **Web content** | Strip navigation/boilerplate/ads before chunking (readability-style main-content extraction); preserve the canonical URL and retrieved-at timestamp as metadata for citation and staleness tracking. | Web content changes — without a retrieved-at timestamp, a citation can silently point to content that no longer exists at that URL. |

## 3. Chunking Strategy

**Default recommendation: recursive character/structure-aware splitting, not semantic chunking, as the baseline.** This is a real, somewhat counterintuitive 2025–2026 empirical finding worth stating plainly: benchmark comparisons across realistic document sets found recursive/structural chunking (splitting on a hierarchy of natural boundaries — paragraph, then sentence, then character, as a fallback) matched or beat embedding-similarity-based "semantic chunking" on end-to-end retrieval accuracy, while being far cheaper to compute (no embedding calls needed at chunk-boundary-decision time). Semantic chunking's computational overhead was "not justified by results" in that comparison.

**Recommended defaults** (ASSUMED — a starting configuration, tunable per corpus):

| Parameter | Default | Notes |
|---|---|---|
| Chunk size | ~512 tokens | Adjust down (~256) for short-answer/FAQ-style corpora, up (~1024) for long-form legal/technical/narrative documents where mid-thought splits hurt more |
| Overlap | 10–20% of chunk size | Prevents a fact from being split exactly at a chunk boundary and unretrievable from either side |
| Boundary priority | Structural first (heading/section/paragraph), then sentence, then hard character cutoff as last resort | Never split mid-sentence or mid-table-row if a structural boundary is available within budget |
| Escalation triggers | Move to **semantic chunking** if retrieval precision is the measured bottleneck on a specific corpus; move to **hierarchical chunking** (small child chunks + larger parent context returned together) if the LLM is receiving technically-correct-but-insufficient context; consider **late chunking** (embed the full document first, derive chunk vectors from token-level embeddings afterward) specifically when cross-reference-heavy documents are breaking naive chunking | These are corpus-specific escalations, not blanket upgrades — each adds cost and complexity that should be justified by a measured problem, mirroring the "start simple" principle in `02_AI_AGENT_RESEARCH.md` §1.4 |

Every chunk should carry: source document id, chunk index/position, section path (heading hierarchy where applicable), source type, retrieved/created/modified timestamps, and access-control metadata (which users/orgs may see this chunk) — the last one is a hard requirement the moment RAG spans more than one tenant or permission level, since a vector index has no native concept of row-level security and this must be enforced in the retrieval filter, not bolted on after.

## 4. Embedding Models

There is no single "best" embedding model — the right choice depends on budget, latency, domain, and whether self-hosting is viable. Current landscape (2026):

| Model family | Type | Notes |
|---|---|---|
| **OpenAI text-embedding-3-large / -small** | Proprietary API | Strong general-purpose baseline, simple integration, widely supported by vector-DB tooling. `-small` is materially cheaper with a modest quality tradeoff versus `-large`. |
| **Voyage AI (voyage-3.5, domain-tuned variants)** | Proprietary API | Reports leading benchmark scores among proprietary options on general MTEB-style evaluation, and specifically markets **domain-tuned variants for code, legal, and finance** — worth evaluating directly against `text-embedding-3-large` on our own corpus rather than assuming the general benchmark ranking transfers. |
| **Google Gemini embeddings** | Proprietary API | Reasonable choice if the rest of the stack is already Gemini-centric (single-vendor billing/latency profile), competitive but not universally top-ranked on general benchmarks. |
| **BGE (BAAI General Embedding), BGE-M3** | Open-source, self-hostable | BGE-M3 specifically is called out as a strong open-source option for **multilingual** retrieval. Self-hosting cost is dramatically lower per-request than any API option at meaningful volume, at the cost of running and maintaining inference infrastructure. |
| **E5 / other open-source families** | Open-source, self-hostable | Comparable tier to BGE; choice between them should be an empirical MTEB-subset or in-domain eval, not a default pick. |

**Rough cost shape** (illustrative, from 2026 comparative writeups — treat exact numbers as directionally indicative, not vendor quotes): embedding 1M short (~100-token) documents runs roughly $200 for `text-embedding-3-small`, ~$1,000–1,300 for Voyage/`text-embedding-3-large` tier models, versus low tens of dollars in pure compute for a self-hosted BGE model — the commonly cited self-hosting break-even is in the range of 5–10M embedding requests/month, below which API convenience usually wins on total cost of engineering time.

**Recommendation for our platform**: default to a proprietary API model (OpenAI `text-embedding-3-small` or Voyage, selected by an internal eval against representative documents from our target use cases) for v1 — it removes an entire class of infra to run and keeps embedding-model choice decoupled from generation-model choice (a core tenet of model-agnosticism). Design the embedding-model as a pluggable interface from day one (an "embedding provider" abstraction with model id + dimensionality stored per index) so a move to a self-hosted BGE-family model at scale, or a swap to a domain-tuned model for a specific corpus (e.g., a code-specific embedding model for a codebase-RAG feature), is a configuration change, not a rearchitecture. **Never hardcode a specific embedding dimensionality into the schema** — different models produce different vector widths, and supporting more than one model/index concurrently (e.g., during a migration) is a real, not hypothetical, requirement.

## 5. Vector Index / Hybrid Search

### 5.1 Why Hybrid (BM25 + Vector), Not Vector-Only

Pure vector search misses exact-match cases that keyword search handles trivially — an error code, a product SKU, a person's name, a quoted phrase — because embedding similarity is a semantic, not lexical, signal. Pure BM25 misses paraphrase/synonym matches. 2025–2026 benchmark work (e.g., WANDS e-commerce benchmark) reports a hybrid setup reaching materially higher NDCG (~0.75) than either BM25 alone (~0.70) or vector alone (~0.70) — roughly a 7% lift from combining them, which is a large, reproducible effect, not a marginal one.

The standard fusion approach is **Reciprocal Rank Fusion (RRF)**: run BM25 and vector search in parallel (each returning a ranked top-N, typically 50–500 candidates depending on downstream reranking budget), then combine by rank position rather than raw score — this sidesteps the real practical problem that BM25 scores and cosine-similarity scores live on incomparable scales and cannot be linearly blended without ad hoc normalization. A static blend weight between the two signals is a documented anti-pattern ("a lazy default that hurts both cases") — at minimum, detect query characteristics (does it contain an identifier, a quoted string, a code pattern?) and bias toward keyword search for those, semantic search otherwise.

### 5.2 Reranking

Hybrid retrieval produces a candidate shortlist; a **cross-encoder reranker** — which jointly encodes the query and each candidate (rather than encoding them independently, as embedding models do) — re-scores that shortlist for a second, more precise relevance pass before the top few results go to the LLM. This two-stage design (cheap broad recall, then expensive precise reranking on a small candidate set) is the standard production pattern because cross-encoders are too slow to run against a full index directly.

Current options (2026): **Cohere Rerank 4** (Fast/Pro tiers, strong multilingual support, hosted API), **Voyage rerank-2.5** (positioned for agentic/conversational use cases, instruction-following), and open-source cross-encoders (**BGE-reranker-v2-m3**, **Qwen3-reranker**, ColBERT-style late-interaction models) for self-hosted deployments. Choice should be driven by license/latency/multilingual requirements for the specific deployment rather than a single universal pick — pricing and relative quality both shift frequently enough that a fixed recommendation would go stale; **build the reranker as a pluggable interface for the same reason as the embedding model.**

### 5.3 Vector Store: pgvector vs. Dedicated Vector Databases

This is a real architectural decision for a Postgres-centric stack, and the honest 2026 answer is **"it depends on scale and whether you already run Postgres,"** not a universal winner:

| Option | Strengths | Weaknesses | Best fit |
|---|---|---|---|
| **pgvector** (Postgres extension) | Lives inside your existing relational database — ACID transactions and relational joins against vectors in the same query are only available here; no new system to operate, back up, or secure separately; HNSW-indexed pgvector has been shown in some 2026 benchmarks to match or beat dedicated vector DBs at ~1M-vector scale on equivalent compute | Falls behind purpose-built engines at larger scale — reported benchmarks show an order-of-magnitude QPS gap versus Qdrant at 50M vectors under equivalent recall targets; scaling means scaling your whole Postgres instance, not just the vector workload | Startups/v1 products, anything where vectors need to be joined against relational data (permissions, org structure, user records) in the same query, corpora up to roughly single-digit millions of chunks |
| **Pinecone** | Fully managed, fastest path to production, usage-based billing, free tier for prototyping | Separate system to integrate/secure/pay for; vendor lock-in on a proprietary API; no relational joins | Teams wanting zero infra ops and willing to pay for it |
| **Qdrant** | Best performance-per-dollar at scale for pure vector workloads (Rust-based, filterable payload index); strong benchmark results at high vector counts | Yet another system to run (unless using their managed cloud); no native relational join with your primary data | High-volume, vector-workload-dominant products where retrieval latency/cost at scale is the binding constraint |
| **Weaviate** | Open-source with a managed cloud option; particularly strong at hybrid (vector+keyword) search and multi-tenancy out of the box | Separate system; smaller operational ecosystem than Postgres | Multi-tenant SaaS RAG products that want built-in hybrid search without hand-rolling BM25+vector fusion |

**Recommendation for our platform: start on pgvector.** Reasoning specific to our design, not a generic default:
1. Our platform already needs a relational store for users, tasks, tool registry, memory, and permissions (see `08_MEMORY_ARCHITECTURE.md`, `11_AGENT_LOOP.md`) — putting vectors in the same database means retrieval can be filtered by access control and org/project scope in a single SQL query with a join, instead of a two-hop "vector search then filter by ID list against Postgres" round trip, which is both slower and a source of subtle bugs (stale ID lists, pagination mismatches across two systems).
2. The commonly observed production pattern (start on pgvector, migrate to a dedicated vector DB when usage actually demands it) matches our own uncertainty about scale at this stage — we do not yet know if any single tenant's corpus will exceed the multi-million-chunk range where pgvector's disadvantage becomes decisive.
3. **Explicit migration trigger, decided now rather than left ambiguous**: if any single tenant's index exceeds roughly 5–10M chunks, or p95 retrieval latency under production load exceeds our SLA on pgvector after index tuning (HNSW parameters, connection pooling), that tenant's index (not necessarily the whole platform) migrates to a dedicated store — architect the retrieval layer behind an interface (§4's pluggability principle applies here too) so this is a per-tenant backend swap, not a rewrite.

## 6. Context Assembly and Citation Attribution

- **Context assembly**: after reranking, assemble the final context window with each chunk tagged by a stable, short citation marker (e.g., `[1]`, `[2]`) mapped to its source metadata (document title, section, URL/path, retrieved-at timestamp). Order chunks by relevance rank, not by source document order, unless the query is explicitly about document structure/ordering.
- **Grounding instruction**: the system prompt for the generation step should explicitly instruct the model to cite the marker for every factual claim drawn from retrieved content, and to distinguish between "stated in the retrieved sources" and "not found in the retrieved sources — answering from general knowledge" rather than blending the two silently.
- **Citation verification pass**: for high-stakes or long-form outputs, a documented pattern from Anthropic's own multi-agent research system (see `02_AI_AGENT_RESEARCH.md` §2.3, `03_EXISTING_AGENT_ARCHITECTURES.md`) is a **separate citation-checking pass** — verifying after generation that each cited marker's source chunk actually supports the claim attributed to it, rather than trusting the generation step's citations at face value. This catches the common failure mode where a model cites a real, retrieved source for a claim that source doesn't actually support.
- **Surfacing citations to the user**: the UI should let a user click through from a citation marker to the actual source chunk (and, where the source is a document we have permission to link to, the original document/URL) — citation that can't be verified by the user is not meaningfully different from no citation.

## 7. RAG vs. Memory — Explicit Boundary

RAG (this document) and memory (`08_MEMORY_ARCHITECTURE.md`) both retrieve information to inject into context, and both can be backed by similar underlying tech (embeddings, vector search) — but they answer different questions and should be architected as separate subsystems with a shared *interface* pattern rather than merged into one "everything store":

| | RAG (this doc) | Memory (`08_MEMORY_ARCHITECTURE.md`) |
|---|---|---|
| Content | External documents the user/org brought in | Facts the agent itself learned/derived from interacting with this user/task |
| Source of truth | The original document (RAG is a pointer/index into it) | The memory store itself is the source of truth — there's no separate "original" |
| Update pattern | Re-ingest/re-index when the source document changes | Written directly by the agent (or explicit user correction) as an ongoing process |
| Typical granularity | Chunks of a larger document | Discrete facts, preferences, or summaries |
| Failure mode if stale | Answers from an outdated document version | Agent "remembers" something the user never actually said, or forgot something they did |

They interact at the context-assembly stage: a single agent turn may pull from both (e.g., "using what I know about your team's stack [memory] and the API docs you uploaded [RAG], here's how to implement X") — the context assembler should tag each injected chunk with its source subsystem so the model (and any citation-verification pass) can distinguish "the org's document said X" from "the agent recalls you said X in a previous session," which have very different reliability and citability characteristics.

---

## Sources

- Databricks, "The Ultimate Guide to Chunking Strategies for RAG Applications" — https://community.databricks.com/t5/technical-blog/the-ultimate-guide-to-chunking-strategies-for-rag-applications/ba-p/113089
- Jason Liu, "Text Chunking Strategies for RAG Applications" — https://jxnl.co/writing/2025/09/11/text-chunking-strategies-for-rag-applications/
- "Empirical Evaluation of PDF Parsing and Chunking for Financial Question Answering with RAG," arXiv:2604.12047 — https://arxiv.org/pdf/2604.12047
- "Chunking Methods on Retrieval-Augmented Generation — Effectiveness Evaluation Against Computational Cost and Limitations," arXiv:2606.00881 — https://arxiv.org/pdf/2606.00881
- Denser AI, "Hybrid Search for RAG: Combining BM25 and Dense Vector Search (2026 Guide)" — https://denser.ai/blog/hybrid-search-for-rag/
- PremAI, "Hybrid Search for RAG: BM25, SPLADE, and Vector Search Combined" — https://www.premai.io/blog/hybrid-search-for-rag-bm25-splade-and-vector-search-combined/
- Reintech, "Embedding Models Comparison 2026: OpenAI vs Cohere vs Voyage vs BGE" — https://reintech.io/blog/embedding-models-comparison-2026-openai-cohere-voyage-bge
- FutureAGI, "Best Rerankers for RAG in 2026: 7 Models Compared" — https://futureagi.com/blog/best-rerankers-for-rag-2026/
- Firecrawl, "Best Vector Databases in 2026: A Complete Comparison Guide" — https://www.firecrawl.dev/blog/best-vector-databases
- Tensoria, "Pinecone vs Qdrant vs Weaviate vs pgvector [100M Vector Benchmark]" — https://tensoria.fr/en/blog/vector-database-comparison
- Aider documentation, "Repository map" — https://aider.chat/docs/repomap.html
