# Feature Matrix

Authoritative, honest status per capability from the original project brief. Status values: **NOT STARTED**, **IN PROGRESS**, **MVP DONE** (works, minimally), **DONE** (meets its full requirement + tests), **MOCKED** (real interface + working mock, real integration pending credentials/authorization). This file is updated every phase — see [[25_IMPLEMENTATION_ROADMAP]] — and is more current than this document's prose elsewhere if they ever disagree.

| # | Capability | Status | Phase | Notes |
|---|---|---|---|---|
| 1 | General AI chat / Q&A | MVP DONE | 1–2 | Working end-to-end against mock provider, verified in browser; real providers land in Phase 2 |
| 2 | Coding Agent | MVP DONE | 5 | Real sandboxed test execution + deterministic literal-fix pipeline verified end-to-end (ADR-022); general LLM-driven fixing needs Phase 2 |
| 3 | Autonomous multi-step task execution | MVP DONE | 3 | Full state machine + task graph working, verified incl. crash-recovery; deterministic planner only (ADR-018) |
| 4 | Image generation | MOCKED | 8 | Full async pipeline (job → real SVG asset → served over HTTP) verified live end-to-end; MOCKED per ADR-009/028 until a real provider key exists |
| 5 | Fast image generation | MOCKED | 8 | `quality: "fast"` param modeled per [[05_IMAGE_GENERATION_RESEARCH]]'s capability design; the mock always responds fast — real fast-tier latency behavior needs a real provider |
| 6 | Long-form video generation | NOT STARTED | 9 | MOCKED first; real duration limits documented in [[06_VIDEO_GENERATION_RESEARCH]] |
| 7 | Video generation from prompts | NOT STARTED | 9 | |
| 8 | Video generation >20 min | NOT STARTED | 9 | Requires scene-decomposition pipeline, [[07_LONG_RUNNING_JOB_ARCHITECTURE]] — no provider does this in one call |
| 9 | File/document understanding | MVP DONE | 6 | Plain text/.md ingestion + real pgvector retrieval verified (unit + integration test + live curl); PDF/DOCX not yet parsed |
| 10 | PDF/document analysis | NOT STARTED | 6 | RAG pipeline is real for text; no PDF parser integrated yet |
| 11 | Web/information retrieval | NOT STARTED | 4 | Web tool not yet built; only filesystem tools exist so far |
| 12 | Tool calling | MVP DONE | 4 | Real sandboxed native tools + risk-tiered approval gate, verified incl. path-traversal rejection |
| 13 | MCP integration | MVP DONE | 4 | Real connection to `@modelcontextprotocol/server-filesystem`; 14 tools discovered, disabled-by-default, one enabled and called end-to-end through the real subprocess |
| 14 | Agent memory | MVP DONE | 6 | Real storage/list/delete for user-visible memory items (FR-032) verified via API; does not yet *generate* summaries via LLM reasoning (ADR-018-style honest gap) |
| 15 | Conversation history | MVP DONE | 1/6 | Persisted to real PostgreSQL as of Phase 6 (was SQLite in Phase 1); multi-turn continuity verified both times |
| 16 | User/project context | MVP DONE | 1/6 | Basic in Phase 1; Phase 6 adds real document/memory context, still single-operator (no multi-user auth yet) |
| 17 | Multi-model orchestration | MVP DONE | 2 | Three real adapters (Anthropic/OpenAI/Google) + mock all registered; conditional on env vars |
| 18 | Model routing | MVP DONE | 2 | Real fallback-on-failure verified against live (invalid-key) API calls to all three providers, not just mocked |
| 19 | Background jobs | MVP DONE | 7 | Real pg-boss on Postgres (via PGlite's native adapter); document ingestion converted from sync to async as the first real job type |
| 20 | Queue-based long-running tasks | MVP DONE | 7 | Retry/backoff/persistence all real (pg-boss); cancellation not yet wired up (no job type needs it yet) |
| 21 | Streaming responses | MVP DONE | 1 | SSE token streaming verified end-to-end (curl + browser) |
| 22 | Progress reporting | MVP DONE | 3/7 | Live SSE task/node events verified end-to-end; job status polling (ingesting/ready/failed) verified for the async document-ingest job |
| 23 | Cancellation/resume of long-running jobs | MVP DONE | 3/7 | Agent-level cancel + crash-restart resume verified (incl. mutating-tool reconciliation); job-level crash-recovery now also verified for real (a killed API process's in-flight job completed correctly after restart) |
| 24 | Retry and failure recovery | MVP DONE | 2/7 | Node-level retry verified (caught a real infinite-loop bug); provider-level fallback verified against real live-endpoint failures (ADR-024); job-level retry/backoff/crash-recovery now real via pg-boss, verified incl. a real full-process kill-and-restart |
| 25 | Authentication and authorization | NOT STARTED | 1 | Self-hosted per ADR-008 |
| 26 | Usage tracking | NOT STARTED | 11/15 | |
| 27 | Cost/token/resource tracking | NOT STARTED | 15 | |
| 28 | Admin controls | NOT STARTED | 10 | |
| 29 | API access | MVP DONE | 1 | `/api/v1/chat` live; rest of the surface in `docs/15_API_ARCHITECTURE.md` lands with the features it backs |
| 30 | Web application UI | MVP DONE | 1/10 | Minimal chat screen working; full screen set is Phase 10 |
| 31 | Developer/API interface | MVP DONE | 1 | Verified directly via `curl`, independent of the web UI |
| 32 | Plugin/tool architecture | MVP DONE | 4 | Native + MCP tools share one registry/permission gate, verified with both origins |
| 33 | Cloud deployment | NOT STARTED | 14 | Docs/IaC only until authorized, ADR-011 |
| 34 | Observability | NOT STARTED | 12 | |
| 35 | Automated testing | IN PROGRESS | 1–13 | 24 real tests across 7 files: provider adapters (fixtures), embeddings (real retrieval-property test), image-mock (real SVG generation + determinism), RAG and jobs (genuine end-to-end integration tests against real in-memory Postgres/pg-boss — no mocks, incl. a real simulated worker-crash scenario); no coverage yet for agent-core/tools/API routes — continuous, not a single phase |
| 36 | Security controls | MVP DONE | 4/11 | Path-traversal protection, risk-tiered approval gating, and MCP disabled-by-default all verified for real in Phase 4; full pass (rate limiting, auth, SSRF, etc.) is Phase 11 |
| 37 | Extensible architecture for future capabilities | IN PROGRESS | 0 | Provider/tool/adapter patterns are the mechanism — see [[24_PROJECT_STRUCTURE]], [[26_DECISIONS]] |

## Phase 0 documentation status

| Doc | Status |
|---|---|
| 00–01, 24–27, 29 (this file) | DONE (written directly) |
| 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 18, 20, 21, 28 | DONE (research agents completed 2026-08-31, verified present and substantive) |
| 14–17, 19, 22–23 | DONE — architecture-synthesis docs written, informed by completed research |
| 30 (Final System Spec) | DRAFTED as target-state spec (2026-08-31); re-validated against actual implementation at program completion (Phase 15) |

**All 31 Phase 0 documents now exist with substantive content.** Phase 0 exit criteria met — see [[25_IMPLEMENTATION_ROADMAP]].

**Phase 1 exit criteria also met (2026-08-31):** the minimal chat loop runs end-to-end against the mock provider with zero external services, verified in an actual browser session, not just by code review. See PROJECT_STATUS.md for the two real bugs this verification caught and fixed.

**Phase 3 and Phase 4 exit criteria also met (2026-08-31, done together since tool-calling is load-bearing for any non-trivial agent task):** the full state machine + task graph + dispatcher + verification + retry + approval gate + crash-recovery reconciliation all work, verified against real scenarios including a deliberately-induced crash mid-tool-call and a path-traversal attack attempt — the latter surfaced and fixed a genuine infinite-loop bug in the dispatcher (see PROJECT_STATUS.md). MCP integration connects to a real external server subprocess, not a stub. Deferred by deliberate, documented scope decision (ADR-018): LLM-driven planning, conditional/loop/sub-agent node types, the plan-invalidating replan loop, and OS-level MCP subprocess sandboxing.

**Phase 5 (coding agent) exit criteria also met (2026-08-31)**, honestly scoped per ADR-022: given a real repo with a deliberately failing test, the agent ran the real test via a sandboxed, allow-listed terminal tool, parsed the real failure output, applied an exact fix to the actual source file on disk, and re-ran the test to confirm a real pass — end to end, no human editing in between. The "fix" is a deterministic literal-value correction driven by a structured failure signal, not free-form LLM reasoning (no real model key is configured yet — see ADR-018's identical reasoning for the planner).

**Phase 2 (real LLM provider adapters) MVP-complete (2026-08-31)**, per the user's explicit choice to keep building without providing a key yet: all three adapters (Anthropic, OpenAI, Google) are built against the raw documented HTTP/SSE API shapes (ADR-023) with 9 passing fixture-based unit tests, and — going further than fixtures alone — each was verified with a real network call to its actual live endpoint using a deliberately invalid key, confirming genuinely correct request construction via a real (not simulated) authentication error in each provider's documented error format. The router's fallback-to-mock (ADR-024) was verified the same way: a real live-API failure, not a mocked one, triggered a real fallback. What's still open: the success path (an actual completion) needs a real key to verify, which the user has deferred — the platform is fully ready for one to be dropped in with zero code changes. First automated test suite in the project (Vitest) also landed this phase.

**Phase 6 (memory & RAG) MVP-complete (2026-08-31)**, per the user's choice to proceed without pausing for Docker/hosted-Postgres setup: the whole platform migrated to real PostgreSQL via PGlite (an actual WASM-compiled Postgres, not a mock or a compatibility shim — ADR-025), with real pgvector cosine-distance search. Document ingestion, chunking, embedding, and retrieval all work end-to-end, verified two independent ways: a real automated integration test (genuine in-memory Postgres, real migrations, real ranked retrieval, zero external services) and a live curl session where changing the query topic correctly flipped which chunk ranked first. Embeddings are a real deterministic feature-hashed vector rather than a learned semantic one (ADR-026) — a local ML model was evaluated and rejected specifically because it carried real, currently-unpatched high-severity vulnerabilities with no clean fix, a bad trade for a "no API key needed" convenience. Memory storage/retrieval/deletion (FR-032) is real; memory *generation* via summarization is not — same honest constraint as the planner and coding agent. PDF parsing is not yet implemented; only plain text/Markdown documents ingest today.

**Phase 7 (async job system) MVP-complete (2026-08-31)**: pg-boss on the same PGlite Postgres, using pg-boss's own native `fromPglite` adapter — no Redis, no hand-rolled bridge. Document ingestion converted from a synchronous HTTP call to a real async job as the first concrete use case. Verified three ways: a real integration test that simulates a crashed worker (a hung handler, then a second `JobQueue` instance sharing the same database picks up the stale-locked job); a genuinely useful bug found by that same test — pg-boss's default queue policy doesn't dedupe by `singletonKey` at all, only stricter policies do — corrected after the test failed for real, not caught by reading docs more carefully; and a full-process test where the API was killed immediately after enqueueing a job and, after a clean restart, the job still completed correctly. The worker runs in-process within `apps/api` rather than a separate `apps/worker`, because PGlite only allows one process to hold a given database — confirmed directly when two competing processes crashed the WASM engine during this phase's own testing (ADR-027). This is a documented, honest scope boundary: a real standalone Postgres (Phase 14) is what unlocks a genuinely separate worker process, not a missing feature today.

**Phase 8 (image generation, mocked) API/pipeline-level MVP-complete (2026-08-31)**: `MockImageProvider` produces a real, valid SVG image (not an opaque placeholder) with an honest "MOCK IMAGE" banner and prompt text rendered onto a deterministically-hashed background, built against [[05_IMAGE_GENERATION_RESEARCH]]'s researched interface design. The whole flow runs through the real job system from Phase 7 — never resolved inline — per that research's own "mock-provider parity" directive, so the orchestration a real (slow) provider would need is already proven. Verified live: submitted a real request, polled `pending`→`processing`→`succeeded`, fetched the resulting asset over HTTP, and confirmed well-formed SVG XML with the correct requested dimensions and prompt content, plus 4 unit tests. A genuinely valuable side effect of this phase's testing: found and fixed a real PGlite data-corruption risk — a forceful process kill left the database silently damaged until a later migration crashed on it — by adding a graceful-shutdown handler (its effectiveness unverified in this Windows sandbox, where every available kill mechanism is forceful-only; tracked as open in docs/27). Not yet built: the web UI screen for image generation (Phase 10's scope) and any real provider adapter (gated on the user supplying credentials, per ADR-009).
