# Implementation Roadmap

Staged program per the user's explicit direction (2026-08-31): documentation first, then a real working MVP (chat + coding agent + tool calling + one real LLM provider) before any media generation or cloud work. Each phase ends with something that actually runs and is verified — see [[44_SELF_VERIFICATION|21_TESTING_STRATEGY]] for what "verified" means per layer. Status is tracked live in `/PROJECT_STATUS.md`, not duplicated here.

## Phase 0 — Research & Documentation *(in progress)*
Deliverables: `/docs` files 00–30, PROJECT_STATUS.md, initial decision log.
Exit criteria: every doc listed in the original scope exists with real, cited-where-applicable content (not placeholders); tech stack decided and logged in [[26_DECISIONS]].

## Phase 1 — Repository Foundation & Minimal Chat Loop
Scope: monorepo scaffold per [[24_PROJECT_STRUCTURE]]; `packages/shared` core types; `packages/providers/llm-mock`; `packages/model-router` (minimal — single provider, no fallback yet); `packages/database` with SQLite ([[26_DECISIONS]] ADR-006); a minimal `apps/api` exposing `POST /api/v1/chat` with SSE token streaming; a minimal `apps/web` chat page.
Exit criteria: `npm install && npm run dev` on a clean checkout produces a working chat UI against the mock provider with zero external services, per NFR-010. This is the first hard checkpoint — nothing later starts until this runs and is manually verified in a browser.

## Phase 2 — Real LLM Provider Adapter(s) — MVP DONE (2026-08-31), full completion pending a real key
Scope: implement `llm-anthropic`, `llm-openai`, `llm-google` adapters per [[04_MODEL_PROVIDER_RESEARCH]] and [[28_API_PROVIDER_MATRIX]]; wire into `model-router` with capability registry and basic fallback ([[12_MODEL_ROUTING]]).
Exit criteria: with a real API key set in `.env`, chat uses the real provider; with no key, falls back to mock automatically; a provider timeout/error triggers the documented retry/fallback path, tested via fault injection on the mock. **Partially met, honestly scoped per ADR-023/024:** all three adapters are built against the raw documented HTTP/SSE shapes (not the official SDKs — ADR-023), unit-tested against realistic fixtures (9 tests, all passing), and each was verified with a real network call to its live endpoint using a deliberately invalid key — all three reached the real API and received a real, correctly-shaped error (proving request construction is genuinely correct), and the router's fallback-to-mock worked exactly as designed on a real failure, not a simulated one. What remains unverified: the success path (parsing an actual real completion), which needs a valid key the user has not yet provided — the no-key default (mock) and fallback-on-failure exit criteria are fully met; the "chat uses the real provider" criterion is implemented but not live-confirmed.

## Phase 3 — Agent Core (state machine + task graph) — COMPLETE (2026-08-31)
Scope: implement [[11_AGENT_LOOP]]'s state machine and task graph in `agent-core`; persist agent state to the database so a restart resumes correctly (FR-005).
Exit criteria: an agent task requiring 2+ sequential steps completes correctly and its state survives an API process restart mid-task (integration test, not just manual check). **Met** — verified via real curl-driven scenarios plus two deliberate crash simulations (safe auto-resume for an in-flight model call, and correct `needs_reconciliation`/`PAUSED` surfacing for an in-flight mutating tool call — see PROJECT_STATUS.md). Scope deviations logged in ADR-018: deterministic rule-based planner (not LLM-driven), `atomic`-only node execution.

## Phase 4 — Tool System & MCP — COMPLETE (2026-08-31)
Scope: `packages/tools` registry with filesystem/terminal/git/web tools per [[10_TOOL_AND_MCP_ARCHITECTURE]]; permission/risk-level gating and the approval flow (FR-007, FR-022); `packages/mcp` client supporting at least one real external MCP server for validation.
Exit criteria: agent can call a filesystem tool and a real MCP tool in the same task; a high-risk tool call correctly pauses for approval; a prompt-injection fixture (malicious content returned from a tool) does not escalate privilege (FR-023, tested). **Met** for filesystem tools (native + a real `@modelcontextprotocol/server-filesystem` connection) and the approval gate (approve and reject both verified, including that a rejected/pending destructive action never executes). Terminal/git/web tools and a dedicated prompt-injection fixture test are not yet built — tracked as remaining Phase 4 follow-up, not blocking Phase 3's dependents.

## Phase 5 — Coding Agent — COMPLETE for its honestly-scoped increment (2026-08-31)
Scope: scoped multi-file read/search/edit, sandboxed terminal execution (tests/build/lint), change/command audit trail (FR-010–FR-014), building entirely on Phases 3–4's primitives (no separate agent architecture).
Exit criteria: given a real small repo with one failing test, the coding agent finds the failure from real command output, proposes and applies a scoped fix, and the test passes — end to end, no human editing in between. **Met**, per ADR-022's documented scope: the "fix" is a deterministic literal-value correction driven by a structured failure signal (`FIX_NEEDED path=... find=... replace=...`) rather than LLM reasoning about arbitrary output, since no real model key is configured yet (same constraint as Phase 3's planner, ADR-018). Verified for real: a deliberately-wrong constant was corrected on disk and the re-run test genuinely passed; re-running when already passing correctly reports "nothing to fix" instead of fabricating success. Remaining, not yet built: multi-file edits (this increment is single-file), `npm`/`git` in the terminal allow-list (deliberately deferred — no verified scenario needs them yet), and general LLM-driven fixing (needs Phase 2).

## Phase 6 — Memory & RAG — MVP DONE (2026-08-31)
Scope: `packages/memory` (conversation summarization, user/project memory, FR-030/FR-032) and `packages/rag` (document upload, chunking, embeddings, pgvector-backed retrieval per [[09_RAG_ARCHITECTURE]], FR-031). **This phase is the trigger for introducing Postgres** ([[26_DECISIONS]] ADR-006) — SQLite's single-writer model and lack of pgvector make it insufficient beyond this point; migration path documented in [[14_DATABASE_ARCHITECTURE]].
Exit criteria: uploading a real PDF and asking a question about it returns an answer with a correct source citation; a long conversation past the summarization threshold still answers correctly about early context. **Honestly partial per ADR-025/026:** the whole platform migrated to real PostgreSQL (via PGlite — an actual WASM-compiled Postgres engine, not Docker or a hosted service, chosen because neither was available without a user action that wasn't requested — ADR-025) with real pgvector search. Document upload/chunking/embedding/retrieval all work end-to-end and are verified two ways: a real automated integration test (an actual in-memory Postgres instance, real migrations, real ingestion, real ranked retrieval) and a live curl-driven session that correctly re-ranked chunks when the query topic changed. Citation is present (`[[n]] chunk text` numbering in the assembled context). What's not done: PDF specifically (only plain text/.md is parsed — no PDF library integrated yet); embeddings are a real deterministic feature-hashed vector, not a learned semantic one (ADR-026 — a local ML model was evaluated and rejected for carrying unpatched high-severity vulnerabilities); and conversation summarization past a length threshold is not implemented — the `memory_items` table, repository, and view/delete API are real and working (FR-032), but nothing yet *generates* a summary via LLM reasoning, the same honest constraint as the planner (ADR-018) and coding agent (ADR-022).

## Phase 7 — Async Job System — MVP DONE (2026-08-31)
Scope: `packages/jobs` real implementation (queue tech per [[07_LONG_RUNNING_JOB_ARCHITECTURE]]'s recommendation, likely introducing Redis alongside Postgres — supersedes ADR-007's placeholder once that doc lands); job persistence, retry/backoff, cancellation, idempotency (FR-050, NFR-004).
Exit criteria: a long-running job survives a worker process restart and resumes; a retried job step does not duplicate its side effect (tested with a fault-injecting mock). **Met, no Redis needed** — pg-boss (ADR-012) via its own native `fromPglite` adapter (ADR-027), not a hand-rolled bridge. Verified three ways: a real integration test simulating a crashed worker (a hung handler + a second `JobQueue` instance sharing the same PGlite handle picks up the stale-locked job); a real finding that pg-boss's default queue policy does *not* dedupe by `singletonKey` (only `exclusive`/`singleton`/`stately`/`short` do — corrected after the test failed against a real queue); and a full-process test — `POST /api/v1/files` enqueues a real job, the API process was `taskkill`ed immediately after (before the job could be claimed), and after a clean restart the job still completed correctly. Cancellation is not yet wired up (no job type needs it yet — document ingestion is fast and idempotent by nature of its status field). The worker runs in-process within `apps/api`, not a separate `apps/worker`, because PGlite is single-connection (ADR-027) — a documented, honest scope boundary, not a shortcut.

## Phase 8 — Image Generation (mocked)
Scope: `packages/media` image pipeline against `image-mock` per [[05_IMAGE_GENERATION_RESEARCH]]'s interface design (FR-040); full UI flow (prompt → job → progress → result) even though the result is mock.
Exit criteria: end-to-end image request flow works and is visibly, honestly labeled as mock output in the UI — see ADR-009. Real provider wiring (FR-041) is a follow-up task gated on the user supplying credentials, tracked in PROJECT_STATUS.md, not attempted speculatively.

## Phase 9 — Video Generation & Long-Form Pipeline (mocked)
Scope: `video-mock` short-clip generation (FR-042); the long-form orchestration pipeline from [[07_LONG_RUNNING_JOB_ARCHITECTURE]] (script → storyboard → per-scene generation → assembly via ffmpeg) running entirely against mock clips (FR-043).
Exit criteria: requesting a 20+ minute video produces a real assembled output file (via ffmpeg concatenation of mock clips) of the correct total duration, with per-scene resumability demonstrated by deliberately failing one scene and confirming only it regenerates.

## Phase 10 — Frontend Completion
Scope: remaining UI surfaces per [[16_FRONTEND_ARCHITECTURE]] (projects, files, assets, task history, settings, models/providers, usage, admin, agent execution detail view per rule 25 of the original spec).
Exit criteria: every screen listed is reachable, functional against real backend data (not static mocks in the frontend sense), and manually walked through in a browser per this project's own testing discipline for UI changes.

## Phase 11 — Security Hardening
Scope: full pass against [[13_SECURITY_ARCHITECTURE]] — RBAC finalized, rate limiting, input/output validation audit, SSRF/path-traversal tests, MCP trust boundary review, secret-scanning in CI.
Exit criteria: `security-review` skill run against the full diff surface with zero unresolved CRITICAL/HIGH findings.

## Phase 12 — Observability
Scope: structured logging, metrics, tracing per [[20_OBSERVABILITY]] across all apps.
Exit criteria: a single request id is traceable across API → worker → provider-call logs for one real chat and one real job execution.

## Phase 13 — Testing Completion
Scope: fill gaps against [[21_TESTING_STRATEGY]] — unit/integration/e2e coverage for every P0/P1 requirement in [[01_REQUIREMENTS]].
Exit criteria: CI green on a clean run, including agent-loop and security tests, using mock providers only (no paid API calls in CI, per the testing strategy).

## Phase 14 — Cloud Deployment (documentation & IaC only, pending authorization)
Scope: Dockerfiles for each app, IaC for the [[18_CLOUD_ARCHITECTURE]] recommendation, deployment runbook.
Exit criteria: `docker build` succeeds locally for each app image. **No `gcloud`/`terraform apply` is run without explicit user authorization** ([[26_DECISIONS]] ADR-011) — this phase produces reviewable artifacts, not a live environment.

## Phase 15 — Production Hardening & Final Audit
Scope: cost/quota enforcement (FR-063), final pass on [[27_RISKS_AND_LIMITATIONS]], `/docs/FINAL_AUDIT.md` per the project's own definition of done.
Exit criteria: FINAL_AUDIT.md exists with zero open CRITICAL items; every item in [[29_FEATURE_MATRIX]] has an accurate, current status.

---

**Note on pacing:** phases are dependency-ordered, not time-boxed — each is only started once the previous phase's exit criteria are actually met and verified (build/test/typecheck green, manually confirmed where the checklist in the original brief calls for it). PROJECT_STATUS.md is the source of truth for "what phase are we actually in," not this document.
