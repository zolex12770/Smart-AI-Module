# Feature Matrix

Authoritative, honest status per capability from the original project brief. Status values: **NOT STARTED**, **IN PROGRESS**, **MVP DONE** (works, minimally), **DONE** (meets its full requirement + tests), **MOCKED** (real interface + working mock, real integration pending credentials/authorization). This file is updated every phase — see [[25_IMPLEMENTATION_ROADMAP]] — and is more current than this document's prose elsewhere if they ever disagree.

| # | Capability | Status | Phase | Notes |
|---|---|---|---|---|
| 1 | General AI chat / Q&A | MVP DONE | 1–2 | Working end-to-end against mock provider, verified in browser; real providers land in Phase 2 |
| 2 | Coding Agent | MVP DONE | 5 | Real sandboxed test execution + deterministic literal-fix pipeline verified end-to-end (ADR-022); general LLM-driven fixing needs Phase 2 |
| 3 | Autonomous multi-step task execution | MVP DONE | 3 | Full state machine + task graph working, verified incl. crash-recovery; deterministic planner only (ADR-018) |
| 4 | Image generation | NOT STARTED | 8 | Will ship MOCKED first (ADR-009) |
| 5 | Fast image generation | NOT STARTED | 8 | Interface designed for low-latency tier per [[05_IMAGE_GENERATION_RESEARCH]] |
| 6 | Long-form video generation | NOT STARTED | 9 | MOCKED first; real duration limits documented in [[06_VIDEO_GENERATION_RESEARCH]] |
| 7 | Video generation from prompts | NOT STARTED | 9 | |
| 8 | Video generation >20 min | NOT STARTED | 9 | Requires scene-decomposition pipeline, [[07_LONG_RUNNING_JOB_ARCHITECTURE]] — no provider does this in one call |
| 9 | File/document understanding | NOT STARTED | 6 | |
| 10 | PDF/document analysis | NOT STARTED | 6 | Part of RAG |
| 11 | Web/information retrieval | NOT STARTED | 4 | Web tool not yet built; only filesystem tools exist so far |
| 12 | Tool calling | MVP DONE | 4 | Real sandboxed native tools + risk-tiered approval gate, verified incl. path-traversal rejection |
| 13 | MCP integration | MVP DONE | 4 | Real connection to `@modelcontextprotocol/server-filesystem`; 14 tools discovered, disabled-by-default, one enabled and called end-to-end through the real subprocess |
| 14 | Agent memory | NOT STARTED | 6 | |
| 15 | Conversation history | MVP DONE | 1 | Persisted to SQLite, multi-turn continuity verified |
| 16 | User/project context | NOT STARTED | 1/6 | Basic in Phase 1, full in Phase 6 |
| 17 | Multi-model orchestration | MVP DONE | 2 | Three real adapters (Anthropic/OpenAI/Google) + mock all registered; conditional on env vars |
| 18 | Model routing | MVP DONE | 2 | Real fallback-on-failure verified against live (invalid-key) API calls to all three providers, not just mocked |
| 19 | Background jobs | NOT STARTED | 7 | |
| 20 | Queue-based long-running tasks | NOT STARTED | 7 | |
| 21 | Streaming responses | MVP DONE | 1 | SSE token streaming verified end-to-end (curl + browser) |
| 22 | Progress reporting | MVP DONE | 3/7 | Live SSE task/node events verified end-to-end; job-level (Phase 7) still pending |
| 23 | Cancellation/resume of long-running jobs | MVP DONE | 3/7 | Agent-level cancel + crash-restart resume both verified for real (incl. mutating-tool reconciliation path); job-level in Phase 7 |
| 24 | Retry and failure recovery | MVP DONE | 2/7 | Node-level retry verified (caught a real infinite-loop bug); provider-level fallback now verified against real live-endpoint failures too (ADR-024); job-level recovery is Phase 7 |
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
| 35 | Automated testing | IN PROGRESS | 1–13 | Vitest introduced in Phase 2 (9 real fixture-based provider adapter tests, `npm test` works); no coverage yet for agent-core/tools/API — continuous, not a single phase |
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
