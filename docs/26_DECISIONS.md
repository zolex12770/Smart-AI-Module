# Architectural Decision Log

Format: Decision / Reason / Alternatives Considered / Tradeoffs / Date / Impact.
New decisions are appended at the bottom. Do not edit past decisions to hide history — if a decision is reversed, add a new entry that supersedes it and link back.

---

## ADR-001: Primary language — TypeScript (Node.js) end to end

**Decision:** Frontend, backend API, workers, and shared packages are all TypeScript on Node.js.

**Reason:** One language across the stack reduces context-switching cost for a small/solo engineering effort, lets shared types (task graph, provider interfaces, API contracts) be literally the same code, and every target LLM/image/video provider (Anthropic, OpenAI, Google) ships a first-class official TypeScript SDK. Node 24 is already available in this environment.

**Alternatives considered:**
- Python backend + TS frontend — Python has stronger ML/data tooling, but this platform orchestrates external model APIs rather than running models locally, so that advantage doesn't apply. Would also require maintaining two type systems for the same contracts (task graph, provider schemas).
- Full Python (backend + a Python web framework for frontend, e.g. via a JS framework anyway) — rejected, no mainstream production-grade equivalent to React/Next.js in the Python ecosystem.

**Tradeoffs:** If we later need Python-only ML tooling (e.g. local embedding models, fine-tuning), we'll shell out to a Python worker process or a small Python microservice behind an HTTP boundary rather than rewriting the core.

**Date:** 2026-08-31
**Impact:** All subsequent stack decisions build on this.

---

## ADR-002: Monorepo with npm workspaces

**Decision:** Single repository, npm workspaces (`apps/*`, `packages/*`), no separate monorepo build tool initially.

**Reason:** npm ≥7 workspaces are already available (npm 11.6.2 installed) with zero extra tooling. The project needs shared packages (agent-core, providers, tools, database schema, shared types) consumed by multiple apps (web, api, worker) — workspaces solve that without adding Turborepo/Nx complexity before it's earned.

**Alternatives considered:**
- Turborepo — better build caching and task orchestration at scale. Deferred: adds a config surface before there's enough build time pain to justify it. Revisit once CI build times become a problem (see `docs/25_IMPLEMENTATION_ROADMAP.md`).
- pnpm workspaces — faster installs, stricter dependency isolation. Deferred only because npm is already the available package manager here and switching has no urgent payoff; not a large migration if we change our minds later.
- Polyrepo (separate repos per app) — rejected, adds cross-repo versioning overhead for a project where frontend/backend/workers change together constantly during early development.

**Tradeoffs:** No remote build cache; CI reruns full builds. Acceptable at current scale.

**Date:** 2026-08-31
**Impact:** See `docs/24_PROJECT_STRUCTURE.md` for the concrete layout.

---

## ADR-003: Backend web framework — Fastify

**Decision:** Fastify for the API app and any HTTP surface in the worker app.

**Reason:** Native TypeScript-friendly schema validation, low overhead, first-class support for SSE (needed for chat/agent token and event streaming) and WebSockets via plugins, and a mature plugin ecosystem (auth, rate limiting, CORS, swagger/OpenAPI generation).

**Alternatives considered:**
- Express — most familiar, but weaker native TypeScript/schema story and slower for high-throughput streaming workloads.
- NestJS — strong structure via DI, but heavier ceremony (decorators, modules) that adds ramp-up cost disproportionate to current team size (one engineer + one agent).
- Next.js API routes only (no separate API app) — would couple the API lifecycle to the frontend deploy and make it awkward to scale/version the API independently or expose it as a standalone developer API (`/api/v1`) that isn't tied to page rendering.

**Tradeoffs:** Running a separate API app means the frontend must call it over HTTP (or a typed RPC layer) instead of colocated server actions — accepted, because a first-class external API (rule: "Developer/API interface", "API access") is an explicit product requirement, not an afterthought.

**Date:** 2026-08-31
**Impact:** `apps/api` is a standalone Fastify service; `apps/web` is a Next.js app that calls it.

---

## ADR-004: Frontend framework — Next.js (App Router, React)

**Decision:** Next.js for `apps/web`.

**Reason:** Mature streaming support (needed for token-by-token chat and live agent execution views), large ecosystem, straightforward containerized deployment to Cloud Run, and is the de facto standard for AI chat UIs, which lowers integration risk for third-party UI primitives if needed later.

**Alternatives considered:** SvelteKit, Remix — both viable, rejected mainly on ecosystem maturity for AI-specific UI components and hiring/familiarity grounds, not technical necessity.

**Date:** 2026-08-31
**Impact:** `apps/web` consumes `apps/api` over HTTP/SSE; no business logic lives in Next.js server actions to keep a clean API boundary reusable by non-web clients.

---

## ADR-005: Database — PostgreSQL, accessed via Drizzle ORM

**Decision:** PostgreSQL as the single relational store; Drizzle ORM + `node-postgres` for access and migrations. `pgvector` extension for embeddings (see `docs/09_RAG_ARCHITECTURE.md` for confirmation/detail once written).

**Reason:** Postgres covers relational data (users, projects, conversations, tasks, jobs) and, via pgvector, vector search — avoiding a second database system for the initial scale this project needs. Drizzle is chosen over Prisma for a thinner runtime (no separate query-engine binary, which matters for Cloud Run cold starts), SQL-proximate query building that suits the complex recursive/graph-like queries the task graph needs, and strong TypeScript inference without codegen lock-in.

**Alternatives considered:**
- Prisma — more mature migration UX and ecosystem, but heavier runtime and a query engine binary that complicates minimal container images.
- A dedicated vector DB (Pinecone/Qdrant/Weaviate) instead of pgvector — deferred until embedding volume/query latency actually demands it; adding a second stateful system before it's needed increases operational surface for no proven benefit yet.

**Tradeoffs:** pgvector is less specialized than a dedicated vector DB at very large scale (tens of millions of vectors with sub-50ms ANN requirements) — documented as a future migration path in `docs/09_RAG_ARCHITECTURE.md`, not a blocker now.

**Date:** 2026-08-31
**Impact:** `packages/database` owns the Drizzle schema and migrations; every app imports it rather than talking to Postgres directly.

---

## ADR-006: Local persistence for the Phase-1 MVP — SQLite, not Postgres

**Decision:** The very first runnable milestone (chat + coding agent core loop, single local user, no queued jobs yet) persists to a local SQLite file via the same Drizzle-based repository interfaces that Postgres will later implement, rather than requiring Postgres/Redis/Docker on day one.

**Reason:** This dev machine currently has no Docker and no gcloud CLI installed (verified 2026-08-31), and the platform must "run locally" from a clean checkout. Forcing a Postgres+Redis dependency before there's a single working feature would block the very first milestone on infrastructure setup instead of software. SQLite is a real, durable, ACID datastore — not a mock — so this satisfies "never fake implementation."

**Alternatives considered:** Require Docker Compose from day one — rejected as a needless bring-up cost for the first milestone; documented instead as required starting the phase that needs a real job queue (image/video mock generation), where SQLite's single-writer model stops being adequate.

**Tradeoffs:** Repository interfaces must be storage-agnostic from the start (no Postgres-only SQL features in shared code paths) so the swap to Postgres later is a config change, not a rewrite. This is enforced by defining repository interfaces in `packages/database` and having both a SQLite and Postgres Drizzle implementation.

**Date:** 2026-08-31
**Impact:** Phase 1 has zero required external services. Phase 6+ (jobs, RAG at scale) introduces Postgres + Redis and documents them as new local prerequisites at that point.

---

## ADR-007: Job queue — deferred choice, default to in-process queue for Phase 1, BullMQ+Redis from Phase 6

**Decision:** No queue infrastructure in Phase 1 (agent steps run in-process with async/await; a single "job" abstraction exists in code but executes immediately). From the phase that introduces real async work (mock image/video generation, long-form video orchestration), adopt BullMQ + Redis, pending confirmation against the dedicated research in `docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md`.

**Reason:** Introducing Redis and a queue worker before there is any actual long-running work to queue would be speculative infrastructure. The `Job` interface is still defined up front (id, status, progress, retry policy, idempotency key) so swapping the execution backend later doesn't change calling code.

**Date:** 2026-08-31
**Impact:** Revisit and finalize once `docs/07_LONG_RUNNING_JOB_ARCHITECTURE.md` lands; this entry will be superseded by ADR-00X if the research changes the recommendation (e.g. toward pg-boss to avoid adding Redis at all).

---

## ADR-008: Auth — self-hosted session-based auth, not a third-party auth SaaS

**Decision:** Custom email+password authentication with server-side sessions (httpOnly, secure cookies), password hashing via `argon2`. No third-party auth provider wired in by default.

**Reason:** No accounts/credentials for Auth0/Clerk/etc. are currently available, and the platform's own design principle is provider-agnosticism — hardcoding a paid auth SaaS as a requirement to even log in contradicts that. Self-hosted session auth is simple to reason about, has no external dependency, and is swappable later behind an `AuthProvider` interface (OAuth/SSO can be added as an additional provider without changing the interface).

**Alternatives considered:** Clerk/Auth0 — faster to bring up and offer more built-in flows (social login, MFA), but introduce a paid external dependency and vendor lock-in for a core, security-sensitive path before there's a business reason to accept that. Documented as a config-swappable option, not the default.

**Date:** 2026-08-31
**Impact:** `packages/security` implements the `AuthProvider` interface; the default implementation is the local session-based one.

---

## ADR-009: Image/video generation providers — mock-only until real credentials exist

**Decision:** Ship real, complete `ImageProvider`/`VideoProvider` interfaces and a `MockImageProvider`/`MockVideoProvider` from day one. Do not implement calls to a specific real image/video vendor until the user supplies actual API credentials for that vendor.

**Reason:** Explicit user decision (2026-08-31): no image/video provider keys or budget exist yet. Implementing against a real vendor without credentials to test against would be unverifiable and risks silently shipping broken integration code — worse than being explicit about what's mocked. This follows the platform's own rule against faking implementations: the mock is clearly labeled as a mock, not disguised as a real integration.

**Date:** 2026-08-31
**Impact:** `docs/29_FEATURE_MATRIX.md` marks every image/video capability "Mocked — real integration pending credentials" until superseded.

---

## ADR-010: Target LLM providers — Anthropic, OpenAI, Google (Gemini/Vertex)

**Decision:** The `LLMProvider` abstraction is designed against these three concretely (research in `docs/04_MODEL_PROVIDER_RESEARCH.md`), with a documented path for adding others (e.g. open-source/self-hosted via an OpenAI-compatible endpoint, which covers a large class of local/open models for free).

**Reason:** Explicit user choice (2026-08-31). No API keys are currently configured for any of the three (verified via environment inspection) — the MVP therefore defaults to a `MockLLMProvider` and documents exactly which environment variable unlocks each real provider.

**Date:** 2026-08-31
**Impact:** `packages/providers` implements one adapter per provider plus the mock; `ModelRegistry` treats the mock as just another provider so real keys can be dropped in later with zero code changes.

---

## ADR-011: Cloud deployment target — Google Cloud Run, documented but not provisioned

**Decision:** Design deployment around Google Cloud Run (API, web, worker as separate services), Cloud SQL for Postgres, Cloud Storage for assets, Secret Manager for credentials — but do not create any real GCP project, billing account, or resources as part of this engineering effort unless/until the user explicitly authorizes a specific provisioning step.

**Reason:** No `gcloud` CLI, GCP project, or billing information exists in this environment. Provisioning real cloud infrastructure is a billable, hard-to-reverse action that requires explicit user authorization per this project's own operating rules — architecture and IaC can be fully designed and written without ever running `terraform apply` or `gcloud deploy`.

**Date:** 2026-08-31
**Impact:** `infrastructure/` holds Dockerfiles and IaC definitions as code-reviewable artifacts; none are applied automatically.

---

## ADR-012: Job queue — pg-boss on Postgres, no Redis (supersedes ADR-007)

**Decision:** The async job system ([[07_LONG_RUNNING_JOB_ARCHITECTURE]]) uses **pg-boss** running on the same PostgreSQL instance already introduced for RAG/pgvector in Phase 6 ([[26_DECISIONS]] ADR-006, ADR-005). No Redis is added to the stack.

**Reason:** The completed research in [[07_LONG_RUNNING_JOB_ARCHITECTURE]] found this workload's bottleneck is slow external provider calls (seconds to minutes per image/video generation), not queue throughput — so BullMQ+Redis's raw speed advantage doesn't matter here, while transactional consistency between job rows and domain rows (e.g. a `SceneManifest` row and its job row committing atomically) does. Running the queue on Postgres also means the platform has exactly one stateful datastore to operate, back up, and reason about, instead of two.

**Alternatives considered:**
- BullMQ + Redis (ADR-007's original placeholder) — superseded. Would add a second stateful service with no corresponding benefit for this workload's actual bottleneck.
- Google Cloud Tasks / Pub/Sub — [[18_CLOUD_ARCHITECTURE]] independently proposed Cloud Tasks for the eventual cloud deployment. **Reconciled here:** we standardize on pg-boss for both local and cloud deployment (pg-boss runs unmodified against Cloud SQL Postgres) rather than operating two different queue systems for dev vs. prod, which would mean testing against one system and running production on another. Cloud Tasks remains documented in [[18_CLOUD_ARCHITECTURE]] as a deferred option, revisited only if a concrete need emerges (e.g. very high-volume HTTP-target fan-out) that pg-boss can't satisfy.

**Tradeoffs:** pg-boss adds write load to the primary Postgres instance; acceptable at current scale, revisit (e.g. read replica, or a move to Cloud Tasks for high-volume fan-out specifically) if job volume becomes a measured bottleneck.

**Date:** 2026-08-31
**Impact:** No Redis anywhere in the stack, local or cloud. `packages/jobs` implements its `Queue`/`Worker` interfaces against pg-boss.

---

## ADR-013: Mock providers cannot boot in production — enforced, not conventional

**Decision:** Any provider adapter registered as "mock" (`llm-mock`, `image-mock`, `video-mock`) causes the application to refuse to start when `NODE_ENV=production`, via an explicit startup-time guard in `model-router`/`media`'s provider registration path — not merely a code-review convention.

**Reason:** [[21_TESTING_STRATEGY]]'s research on mock-provider design argues that "don't use mocks in prod" enforced only by convention/documentation will eventually be violated by accident (a missing env var silently falling back to mock in a real deployment). A structural guard makes ADR-009's mock-first stance ("mocked" is honestly labeled, never disguised as real) impossible to violate silently in the one environment where it would matter most.

**Date:** 2026-08-31
**Impact:** `packages/providers`' registration code checks `NODE_ENV` and provider type at boot; CI and local dev are unaffected (they run with `NODE_ENV != production`).

---

## ADR-016: SQLite driver — libSQL (`@libsql/client`), not better-sqlite3

**Decision:** The Phase 1 SQLite implementation (ADR-006) uses `@libsql/client` + `drizzle-orm/libsql`, not `better-sqlite3`.

**Reason:** Discovered during actual Phase 1 scaffolding, not anticipated at doc-writing time: `better-sqlite3` requires native compilation via node-gyp, and this dev machine has no Visual Studio C++ Desktop workload/Windows SDK installed, and no prebuilt binary exists yet for Node 24.13.0 on win32/x64 (confirmed by a failed `npm install`). Rather than asking the user to install a multi-gigabyte C++ build toolchain just to run `npm install`, libSQL was substituted — it ships a prebuilt native binary for win32-x64 (`@libsql/win32-x64-msvc`) via napi-rs, installs with zero local compilation, and Drizzle supports it as a first-class SQLite driver with the same schema/query-builder API. Node's built-in `node:sqlite` was considered first (zero dependencies at all) but rejected because Drizzle has no driver integration for it as of this research.

**Tradeoffs:** libSQL's client API is async throughout (vs. better-sqlite3's synchronous API) — a non-issue here since the repository interfaces in [[14_DATABASE_ARCHITECTURE]] were already written async-first (to match the Postgres implementation coming in Phase 6).

**Date:** 2026-08-31 (Phase 1 scaffolding)
**Impact:** `packages/database/src/client.ts` uses `createClient` from `@libsql/client`; no other package is aware of the driver choice, per the repository-interface isolation this was designed for.

---

## ADR-017: API default port — 8787, not 4000

**Decision:** `apps/api` defaults to port 8787.

**Reason:** Port 4000 was already occupied by unrelated, pre-existing processes on this dev machine when Phase 1 was verified end-to-end (confirmed via `netstat`/`tasklist` — unrelated `node.exe` processes, not this project). Rather than investigate or kill processes this project didn't start, the API's default port was moved. Purely a local default — `PORT` is always configurable via env.

**Date:** 2026-08-31 (Phase 1 verification)
**Impact:** `.env.example`, `apps/api/src/config.ts`, and `apps/web/app/lib/chat-stream.ts`'s fallback all use 8787.

---

## ADR-015: GCP service selection detail — deferred to Phase 14, tracked here as a pointer

**Decision:** No new decision needed now; recorded only so this file stays the single index of pending architectural calls. See [[18_CLOUD_ARCHITECTURE]] for the current recommendation (Cloud Run + Cloud SQL + Cloud Storage + Cloud Tasks(deferred, see ADR-012) + Secret Manager + Artifact Registry, GKE/AlloyDB/Pub-Sub explicitly deferred).

**Date:** 2026-08-31
**Impact:** None yet — Phase 14 is documentation/IaC only per ADR-011 and is not authorized to provision anything.

---

## ADR-018: Agent-core Phase 3/4 scope — deterministic planner, atomic nodes only, real MCP integration

**Decision:** The first working implementation of [[11_AGENT_LOOP]] and [[10_TOOL_AND_MCP_ARCHITECTURE]] (`packages/agent-core`, `packages/tools`, `packages/mcp`) covers: the full 13-state task state machine; `atomic` task-graph nodes scheduled purely via `dependsOn` (sufficient to express sequential graphs, per [[11_AGENT_LOOP]] §3.2 — `sequential_group`/`parallel_group`/`conditional`/`loop`/`sub_agent` are reserved in the type enum but not executed by the dispatcher yet); `schema_check`/`deterministic_compare`/`none` verification (`test_suite`/`model_judge`/`human` throw rather than silently pass if ever hit); per-node retry with correct classification-ready plumbing (the `plan-invalidating` replan-loop transition is not wired up — see rationale below); commit-before-act persistence with real crash-recovery reconciliation (§4.2–4.3); a sandboxed native filesystem tool set with real permission-tiered approval gating; and a real (not simulated) MCP client connected to the official `@modelcontextprotocol/server-filesystem` reference server over stdio.

**Reason — deterministic planner instead of LLM-driven planning:** [[11_AGENT_LOOP]]'s `PLANNING` state is designed for an LLM that reasons about arbitrary requests. Building that against the mock provider (no real LLM key configured — [[26_DECISIONS]] ADR-010) would produce a planner that can't actually reason, i.e. theater dressed as a feature. A small rule-based planner (`packages/agent-core/src/planner.ts`) for four known task shapes (`echo_chat`, `read_and_summarize`, `mcp_read_and_summarize`, `delete_sandbox_file`) exercises the entire state machine, task graph, tool-calling, approval, and persistence machinery for real, honestly, without claiming reasoning that isn't there. Swapping in an LLM-driven planner once Phase 2 has a real provider key is a `planner.ts`-only change — the dispatcher, verification, and persistence layers don't know or care how a graph was produced.

**Reason — plan-invalidating replan loop not wired up:** [[11_AGENT_LOOP]] §2.2 specifies that retry exhaustion can escalate to a return-to-`PLANNING` replan, not just `FAILED`. With a deterministic planner, replanning would deterministically reproduce the identical graph and fail again — implementing the loopback now would mean building infinite-loop protection for a code path that can't yet produce a different outcome. Retry exhaustion always terminates as `FAILED` in this increment; the state machine still supports the `PLANNING`-reachable-from-`VERIFYING` transition for when a real planner makes replanning meaningful.

**Reason — real MCP server over a fake one:** connecting to an actual `@modelcontextprotocol/server-filesystem` subprocess (not a hand-rolled stub pretending to speak MCP) is what makes "MCP integration works" a verified claim rather than an assertion — see PROJECT_STATUS.md for the concrete verification (14 real tools discovered, registered disabled-by-default per [[10_TOOL_AND_MCP_ARCHITECTURE]] §3.2, one explicitly enabled and called through the real subprocess).

**Alternatives considered:** Waiting for Phase 2 (real LLM provider) before starting agent-core at all — rejected; the state machine, persistence, crash-recovery, and tool/MCP infrastructure are all independent of *which* planner produces a graph, per [[01_REQUIREMENTS]]'s own phase-gating logic, and building them now means Phase 2's real planner has real infrastructure to slot into rather than being built together with it.

**Date:** 2026-08-31
**Impact:** [[29_FEATURE_MATRIX]] marks task graph/tool-calling/MCP as MVP DONE, not DONE — full completion needs the deferred node types and an LLM-driven planner.

---

## ADR-019: MCP tool trust — name-based permission-level heuristic, disabled by default

**Decision:** A newly-discovered MCP tool's `permissionLevel` is inferred from its name (patterns like `delete|remove|drop` → `destructive`, `write|create|move|rename|edit` → `write_local`, else `read_only`) and every discovered tool is registered with `enabled: false` regardless of inferred risk, requiring an explicit operator action (`POST /api/v1/tools/:id/enable`) before it's callable.

**Reason:** [[10_TOOL_AND_MCP_ARCHITECTURE]] §2.6 is explicit that MCP gives a tool's name/description/schema, not a trust level — the host must assign one, and §3.2 specifies disabled-by-default for newly-discovered tools as the mitigation for tool-poisoning risk (§2.5). A name-based heuristic is a real, working ASSUMED policy (labeled as such), not a permanent design — verified in practice against the reference filesystem server's 14 real tools (`read_text_file` → `read_only`, `edit_file`/`write_file`/`move_file` → `write_local`, correctly matching their actual behavior).

**Tradeoffs:** A tool whose name doesn't hint at its risk (or is deliberately misleading — the tool-poisoning scenario this whole mechanism defends against) could be misclassified as lower-risk than it is. The disabled-by-default requirement is the actual safety net here, not the heuristic — an operator reviewing a tool's real description before enabling it is what catches a heuristic miss.

**Date:** 2026-08-31
**Impact:** `packages/mcp/src/client.ts`'s `inferPermissionLevel`; revisit if/when MCP servers carry richer standardized risk metadata.

---

## ADR-021: No OS-level sandboxing for the spawned MCP subprocess (yet)

**Decision:** The MCP reference server is spawned as a normal child process (via Node's `child_process`, through the MCP SDK's `StdioClientTransport`) with the platform's own OS user privileges — no container, restricted user, or seccomp profile around it.

**Reason:** [[10_TOOL_AND_MCP_ARCHITECTURE]] §2.5 is explicit that a local stdio MCP server has full subprocess privileges unless the host imposes isolation, and that MCP itself provides none. Building real OS-level sandboxing (containerization or a restricted-user spawn) is a meaningful chunk of platform-specific work that wasn't in scope for proving the MCP integration itself works end-to-end. This is a known, accepted gap for this increment.

**Date:** 2026-08-31
**Impact:** Tracked in [[27_RISKS_AND_LIMITATIONS]] as a standing item — required before connecting to any MCP server whose trustworthiness isn't fully controlled (the reference filesystem server, running against our own sandbox directory, was chosen specifically because this gap doesn't create real exposure yet).

---

## ADR-027: Job queue is pg-boss via its native `fromPglite` adapter; the worker runs in-process within `apps/api`, not a separate `apps/worker`

**Decision:** `packages/jobs` wraps `pg-boss` (per [[26_DECISIONS]] ADR-012's original recommendation) constructed with `backend: 'pglite'` and `db: fromPglite(client)` — an adapter **pg-boss ships and maintains itself**, not something built here. The worker (`registerWorker` call for `document.ingest`) runs inside `apps/api`'s own process at boot, not in a separate `apps/worker` OS process as [[24_PROJECT_STRUCTURE]] originally sketched.

**Reason:** PGlite (ADR-025) is a single-connection, embedded, in-process database — verified directly by trying to run two processes against the same `dataDir` during this phase's own testing, which produced a hard WASM-level crash rather than a graceful "database locked" error. A separate `apps/worker` process cannot open the same PGlite instance apps/api holds, so a genuinely separate worker process is not possible without either (a) a real standalone Postgres server (Phase 14) or (b) `@electric-sql/pglite-socket` fronting PGlite with a real TCP Postgres wire-protocol listener a second process could connect to (evaluated, works, but adds a component purely to simulate multi-process separation that provides no real benefit yet, since there's exactly one worker and one job type as of this phase). Running the worker in-process is not a lesser version of the design — it is a real, correct job system (pg-boss's own crash-recovery, retry, backoff, and persistence all genuinely work, verified below) with a documented, honest scaling limit.

**Verified for real, three ways:**
1. `packages/jobs/src/queue.test.ts` — a real in-memory PGlite instance, no mocks: basic enqueue/process, a genuine crash-recovery scenario (a worker "hangs" forever mid-job to simulate a crash; a second `JobQueue` instance sharing the same PGlite handle, simulating a restarted worker, picks up the job once pg-boss's stale-lock expiry fires), and idempotency.
2. A real, non-obvious finding from that test: pg-boss's default `standard` queue policy does **not** deduplicate by `singletonKey` at all — only `exclusive`/`singleton`/`stately`/`short` policies do. The initial test (and this doc, before the fix) assumed otherwise; corrected after the test failed against a real queue, not by reading further documentation.
3. End-to-end through the running API: `POST /api/v1/files` now returns `202` immediately with the document in `ingesting` status; the in-process worker (registered in `apps/api/src/index.ts`) processes it moments later; a full `taskkill` of the API process immediately after enqueueing (before the job could be claimed) followed by a clean restart still resulted in the job completing correctly — real full-process crash recovery, not just the isolated unit test.

**Alternatives considered:** `@electric-sql/pglite-socket` to allow a genuinely separate `apps/worker` process — rejected for now per the reasoning above (real complexity for a boundary that protects nothing yet, since apps/api and the worker have identical uptime/resource characteristics with only one job type). BullMQ+Redis — rejected for the same reasons as ADR-012 originally gave, still valid.

**Date:** 2026-08-31
**Impact:** `packages/jobs`, `apps/api/src/index.ts`'s worker registration. Revisit `apps/worker` as a genuinely separate process once either a real standalone Postgres exists (Phase 14) or a second job type with meaningfully different resource/scaling needs (e.g. a real, expensive media-generation call) actually justifies the isolation — not preemptively.

---

## ADR-028: Mock image generation — a real, valid SVG file, deterministically rendered; runs through the real job system, not inline

**Decision:** `MockImageProvider` (`packages/providers/image-mock`) produces an actual valid SVG image — real bytes that render correctly in any browser or image viewer — with the prompt text rendered onto a deterministically-hashed gradient background and an explicit "MOCK IMAGE — not a real generation" banner. `POST /api/v1/images` only creates the DB record and enqueues an `image.generate` job (via `packages/jobs`, ADR-027); the actual generation happens in the job worker, never inline in the HTTP handler, even though the mock itself is fast.

**Reason:** [[26_DECISIONS]] ADR-009 requires mocks to be honestly labeled, never disguised as real — an SVG with a visible mock banner satisfies that more directly than an opaque placeholder blob would, while still being a genuinely valid, inspectable image file (verified: fetched via `GET /api/v1/assets/:id`, confirmed well-formed SVG XML with correct dimensions for the requested aspect ratio). Running even the mock through the real job system implements [[07_LONG_RUNNING_JOB_ARCHITECTURE]] §1.6's explicit "mock-provider parity" directive: the orchestration (job submission, async status polling, worker execution, asset storage) is exercised for real today, so swapping in a real (slow, rate-limited) provider later is a provider-adapter change, not a pipeline rewrite.

**Interface design**: `ImageProvider`/`ImageGenerationRequest`/`ImageResult`/`ImageProviderCapabilities` in `packages/shared/src/image.ts` are built directly against [[05_IMAGE_GENERATION_RESEARCH]] §4's interface sketch (aspect ratios, seed, quality tiers, capabilities-gated parameters) — not guessed. `getCapabilities()` exists even though only one (mock) provider is registered, because the research found no two real providers support the same parameter set.

**Verified for real**: 4 unit tests (deterministic seed, correct dimension mapping, real capabilities, actual SVG content produced) plus a live end-to-end session — submitted a real request, polled status through `pending`→`processing`→`succeeded`, fetched the resulting asset over HTTP, and confirmed it was a well-formed SVG containing the exact submitted prompt and correct 16:9 dimensions.

**Date:** 2026-08-31
**Impact:** New `assets` and `image_generations` tables ([[14_DATABASE_ARCHITECTURE]]); new `packages/media` (asset storage + orchestration, reusable by video generation in Phase 9). Real provider adapters (OpenAI, Imagen, Stability, FLUX — per [[05_IMAGE_GENERATION_RESEARCH]]) remain mock-only until the user supplies credentials, per ADR-009.

---

## ADR-029: Graceful shutdown added to `apps/api` after a real PGlite corruption incident

**Decision:** `apps/api` now handles `SIGINT`/`SIGTERM` by closing the Fastify server, stopping the job queue, and closing the PGlite connection (`db.$client.close()`) before exiting, instead of relying on the OS to just tear the process down.

**Reason:** during this phase's own testing, a forceful process kill (`taskkill /F`, used throughout this session because Windows refused a non-forceful kill on this process type — confirmed directly, "This process can only be terminated forcefully") left the local PGlite data directory in a state that appeared to work normally for simple reads afterward, but caused a hard WASM-level crash (`RuntimeError: Aborted()`) the next time a schema migration touched the affected structures — real, silent corruption that surfaced much later than the event that caused it, not an immediate error. Root-caused by reproducing it: a fresh database applied the exact same migration cleanly, isolating the fault to the specific damaged data directory, which was then wiped and reinitialized (disposable local dev/test data, not user data).

**Honest verification limitation**: the handler is implemented correctly and should work under normal signal delivery (Linux/Mac `kill`, Docker/Cloud Run's SIGTERM on container stop, or Ctrl+C in a real interactive terminal) — but it could **not** be exercised end-to-end in this sandboxed Windows environment, since every kill mechanism available here is forceful-only (bypasses signal handlers by design). Do not claim this fixes the corruption risk until it's actually observed working under a real graceful shutdown.

**Alternatives considered:** Detecting and auto-clearing a stale `postmaster.pid` at boot — investigated first as the likely cause, removed a real stale lock file, and the crash persisted, disproving that hypothesis before the real one (corruption, not just a lock) was found. Left as a non-fix.

**Date:** 2026-08-31
**Impact:** `apps/api/src/index.ts`. Tracked as an open item in [[27_RISKS_AND_LIMITATIONS]] until real graceful-shutdown behavior is observed (e.g. once this runs under Docker/Cloud Run in Phase 14, or on a non-Windows dev machine).

**2026-08-31 addendum (Phase 9):** directly attempted `taskkill /PID <pid>` (no `/F`) against the running `apps/api` dev server to test whether this sandbox can deliver a graceful signal at all. Windows refused outright: `ERROR: The process with PID <pid> could not be terminated. Reason: This process can only be terminated forcefully (with /F option).` This upgrades the finding from "assumed forceful-only" to **confirmed structurally impossible in this sandbox** — a headless Node.js process here has no window to receive `WM_CLOSE` and no real POSIX `SIGTERM` delivery path, so `apps/api`'s shutdown handler can never be reached by any tool available in this environment, for any process, regardless of how the handler itself is written. Separately, immediately re-running the (now force-killed) server against the same data directory booted cleanly with no corruption — consistent with the original finding that corruption is timing-dependent (whether a write was in flight at the moment of the kill), not guaranteed on every forceful kill.

---

## ADR-022: Coding agent (Phase 5) — deterministic literal-fix pipeline, not LLM-driven bug fixing; `node`-only terminal allow-list

**Decision:** The first coding-agent capability (`fix_failing_test` task type, `terminal.run_command`, `code.parse_fix_directive`, `code.apply_literal_fix`) runs a real sandboxed test command, parses a *structured, self-describing* failure signal the test itself prints (`FIX_NEEDED path=... find=... replace=...`), applies the exact named literal replacement, and re-runs the test to confirm it passes. The terminal tool's command allow-list contains only `node`.

**Reason — deterministic fix, not reasoning:** the same constraint as ADR-018's planner applies here even more directly: genuinely reading arbitrary test/build output and writing a correct code fix requires real reasoning from an LLM, and no real provider key is configured ([[26_DECISIONS]] ADR-010). Building a "coding agent" that feeds arbitrary failure text to the mock provider and calls whatever canned text comes back "a fix" would be exactly the kind of faked functionality this project's own rules (see `docs/00_PROJECT_VISION.md` principle 1) forbid. Instead, this proves the full pipeline mechanics — sandboxed command execution, real failure observation, a real file mutation, real re-verification, full audit trail via the existing transition log — for a genuine, narrow, honestly-scoped automated-fix class. Verified for real: a deliberately-wrong constant (`ANSWER = 41` vs. an assertion expecting `42`) was actually corrected on disk and the re-run test genuinely passed; running the same task again after the fix correctly fails with "nothing to fix" rather than fabricating a result.

**Reason — `node`-only allow-list:** [[13_SECURITY_ARCHITECTURE]]'s command allow/deny-listing requirement means every allowed command must be a deliberate, reviewed decision, not a default-permissive list. `node` is the only command the one verified scenario needs. Adding `npm`/`git` now, unexercised by any real verified scenario, would be untested attack surface for no proven benefit — expand the allow-list when a concrete scenario needs it, the same discipline already applied to native tools.

**Alternatives considered:** Sending real test output to the mock LLM and using its response as "the fix" — rejected outright as fake functionality, not a reasonable simplification. Using `child_process.exec` with a shell string instead of `spawn` with an argument array — rejected: shell string construction is exactly the shell-injection pattern [[13_SECURITY_ARCHITECTURE]] warns against, regardless of how narrow the allow-list is.

**Date:** 2026-08-31
**Impact:** `packages/tools/src/native/{terminal,coding}.ts`; [[29_FEATURE_MATRIX]] marks "Coding Agent" MVP DONE for this narrow class, not DONE — general LLM-driven code fixing is Phase 2-dependent future work, same as planning (ADR-018).

---

## ADR-023: Real LLM provider adapters built with raw `fetch`, not the official SDKs

**Decision:** `packages/providers/llm-anthropic`, `llm-openai`, and `llm-google` call each provider's documented HTTP/SSE API directly via `fetch` (with an injectable `fetchImpl` for testing), rather than depending on `@anthropic-ai/sdk`, `openai`, or `@google/genai`.

**Reason:** No real API key exists for any of the three providers in this environment ([[26_DECISIONS]] ADR-010), so nothing here can be exercised against a live endpoint regardless of which HTTP layer is used — the only thing actually verifiable right now is that request construction and SSE response parsing correctly implement the documented shapes in [[04_MODEL_PROVIDER_RESEARCH]]/[[28_API_PROVIDER_MATRIX]]. Hand-rolling that against the raw documented JSON/SSE shapes, with fixture-based unit tests asserting the exact parsing logic, is more honestly verifiable than depending on three additional SDKs whose current major-version APIs cannot be checked against a live call either, and which would add real dependency/security-surface overhead (matching the same `npm audit` discipline applied to every other dependency choice, e.g. ADR-006's version bumps) for no verification benefit in this specific situation. This also keeps every adapter a small, auditable, directly-comparable translation of the same documented request/response shapes, consistent with [[10_TOOL_AND_MCP_ARCHITECTURE]] §1.4's "one canonical schema, thin per-provider adapter" pattern already used for tools.

**Tradeoffs:** Hand-rolled HTTP clients don't get a vendor SDK's automatic handling of retries, edge-case response shapes, or API evolution (e.g. Google's Interactions API migration, OpenAI's Responses-vs-Chat-Completions churn — both noted in [[04_MODEL_PROVIDER_RESEARCH]]). **This is a real, honestly-tracked gap, not a permanent decision**: revisit once a real key exists and live-call testing is possible — at that point, compare the hand-rolled adapter's actual behavior against the official SDK's before deciding whether to keep it or migrate, rather than assuming either is correct without evidence.

**Date:** 2026-08-31
**Impact:** Zero new runtime dependencies for the three provider packages beyond `@ai-platform/shared`. Each adapter's file header states its verification status explicitly — do not remove or overstate it until a real end-to-end *success* has actually happened.

**Update (same day):** each adapter was additionally exercised with a deliberately invalid key against its real live endpoint (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`) through the running API + ADR-024's router fallback. All three reached the real endpoint and received a real, correctly-shaped error response in that provider's documented error format (confirming request construction — URL, headers, auth, model path — is genuinely correct), and the router's fallback-to-mock then worked exactly as designed, verified via a real network round-trip rather than a mocked one. This is real partial verification, not full verification: the success path (parsing an actual streamed completion) still requires a valid key and remains untested.

---

## ADR-024: Model router fallback — commit-on-first-event, no mid-stream provider switching

**Decision:** `ModelRouter.streamChat` tries the default provider first (or the caller's explicitly-named provider, with no fallback substitution if that fails), and falls back through the rest of the registry in order — but only while a candidate provider has not yet produced its first real event. Once a provider yields a first token, the router is committed to it for the rest of that response; a failure after that point ends the stream with a clean `error` event, not a silent retry against a different provider.

**Reason:** falling back mid-stream would mean a user could see a partial response from one model abruptly followed by a full response from a different one for the same turn — more confusing than a clean failure, and semantically wrong (the two providers aren't guaranteed to continue each other's partial text coherently). Committing only after the first successful event keeps fallback invisible and safe (an all-or-nothing swap before any output is shown) while still surfacing a genuine mid-stream failure honestly instead of masking it.

**Verified for real** (not just unit-tested): with a deliberately invalid `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GOOGLE_API_KEY` set one at a time, each real provider genuinely failed its first call (a real 401/400 from the live API — see ADR-023's update above) and the router transparently fell back to the mock provider, which completed the response normally; a `console.warn` records each fallback for operator visibility.

**Alternatives considered:** Retry the same provider before falling back — deferred; the per-request retry/backoff policy from [[23_FAILURE_RECOVERY]] is a distinct, not-yet-implemented layer above this router-level provider fallback, which handles "this provider is unavailable," not "this call transiently failed."

**Date:** 2026-08-31
**Impact:** `packages/model-router/src/router.ts`. Explicit `request.provider` still means "use exactly this one" — no automatic substitution — matching the principle that an explicit caller choice shouldn't be silently overridden.

---

## ADR-025: Postgres for Phase 6 via PGlite (embedded WASM Postgres + pgvector), not Docker or a hosted service

**Decision:** Phase 6 (memory & RAG) migrates the whole platform from SQLite/libSQL ([[26_DECISIONS]] ADR-006/ADR-016) to real PostgreSQL — specifically `@electric-sql/pglite` (a genuine WASM build of Postgres, not a reimplementation) plus the official `@electric-sql/pglite-pgvector` extension, accessed via `drizzle-orm/pglite`. Data persists to a local directory, the same way the SQLite file did.

**Reason:** [[26_DECISIONS]] ADR-006 always intended Phase 6 to introduce real Postgres+pgvector, and [[19_DEPLOYMENT_ARCHITECTURE]] documented two ways to get there locally: Docker Compose, or a hosted free-tier service (Neon). Neither is available without an action only the user can take (installing Docker Desktop, or signing up for and configuring a hosted database) — the user asked to proceed with Phase 6 now, not to pause on that setup step. PGlite is a third real option neither doc anticipated: an actual Postgres engine compiled to WASM, running embedded in the Node process with zero external services, verified directly (a smoke test round-tripped a real `CREATE EXTENSION vector`, inserted real vectors, and got correct cosine-distance ranking back via `<=>`). This is the same honest-substitution pattern as ADR-016 (libSQL over better-sqlite3): a real engine swapped in to remove a blocking environment gap, not a mock standing in for one.

**Alternatives considered:** Waiting and asking the user to install Docker or set up Neon — rejected per the user's explicit direction to proceed with Phase 6 now. Keeping SQLite and bolting on a separate vector store — rejected; pgvector co-located with relational data was always the documented plan ([[09_RAG_ARCHITECTURE]] §5.3), and running two datastores for no reason contradicts this project's own "avoid speculative/redundant infrastructure" principle.

**Tradeoffs:** PGlite is a single-connection, embedded, single-process engine — excellent for local dev and even light single-instance deployments, but not the target for a multi-instance production deployment. [[18_CLOUD_ARCHITECTURE]]/[[19_DEPLOYMENT_ARCHITECTURE]]'s Cloud SQL plan for Phase 14 is unaffected by this decision — because PGlite genuinely speaks Postgres/pgvector, the schema and queries built against it now are expected to work against real Cloud SQL later with a connection-string-level change (new repository implementation, not a rewrite), the same portability property SQLite→Postgres was designed around in ADR-006.

**Date:** 2026-08-31
**Impact:** `packages/database` schema moves from `drizzle-orm/sqlite-core` to `drizzle-orm/pg-core`; `packages/database/src/client.ts` constructs a `PGlite` instance instead of a libSQL client. `docs/19_DEPLOYMENT_ARCHITECTURE.md`'s local-dev options gain a third entry (PGlite, no install) alongside Docker/hosted.

---

## ADR-026: RAG embeddings — a real deterministic feature-hashed vector, not a local ML model, until a real embeddings API key exists

**Decision:** `packages/embeddings`' default provider computes embeddings via feature hashing (tokenize → hash each token into one of N buckets → accumulate term-frequency weight → L2-normalize) — a real, deterministic, from-scratch vector with no external dependency and no API key, not a neural embedding.

**Reason:** genuine semantic embeddings need either a real embeddings API (OpenAI `text-embedding-3-*`, Google `gemini-embedding-2`, Voyage per [[04_MODEL_PROVIDER_RESEARCH]] §4 — none configured, same constraint as every other real-provider gap this session) or a local ML model. A local model was evaluated (`@huggingface/transformers` running `all-MiniLM-L6-v2` fully offline, no API key) and its installation was verified to work — but it pulls in `onnxruntime-node` and `sharp`, which brought **4 real, currently unpatched high-severity advisories** (a crafted-ZIP memory-exhaustion DoS in `adm-zip`, and multiple libvips CVEs in `sharp`) with no clean fix available (`npm audit fix` found none; forcing one risks breaking the library). Unlike the dev-only, never-network-exposed `drizzle-kit` advisory accepted elsewhere in this project, these packages would sit in the real runtime dependency tree of a security-conscious platform (see [[13_SECURITY_ARCHITECTURE]]) — accepting them for a "no API key needed" convenience is a bad trade. Feature hashing is a real, known IR technique (not a placeholder): documents sharing vocabulary genuinely rank as more similar via cosine distance over the resulting vectors, verified end-to-end against pgvector (PROJECT_STATUS.md). It is honestly a **lexical/keyword-overlap similarity, not a learned semantic one** — the same class of limitation, and the same honesty discipline, as ADR-018's deterministic planner and ADR-022's deterministic coding fix.

**Alternatives considered:** `@huggingface/transformers` — rejected per the vulnerability findings above. A real embeddings API — the natural upgrade path once a real key exists (same unlock as ADR-018/ADR-022); swapping it in is an `EmbeddingProvider` implementation change only, not a RAG-pipeline rewrite, mirroring the `LLMProvider` abstraction's role for chat.

**Date:** 2026-08-31
**Impact:** `packages/embeddings/src/hash-embedding.ts`. [[27_RISKS_AND_LIMITATIONS]] and [[29_FEATURE_MATRIX]] state plainly that RAG retrieval quality is bounded by lexical overlap, not semantic understanding, until a real embeddings provider is configured.

---

## ADR-030: Long-form video pipeline (Phase 9 MVP) — animated-GIF mock clips, a deterministic storyboard planner, a narrowed data model, and ffmpeg invoked as a system binary rather than bundled via npm

**Decision:** Four linked choices, scoped together as the Phase 9 MVP against [[07_LONG_RUNNING_JOB_ARCHITECTURE]] Part 2:

1. **Mock "video" clips are real, valid, playable animated GIFs** (`packages/providers/video-mock`), not fake bytes with a `.mp4` extension. There is no practical way to hand-write a valid MP4/WebM bitstream without a real video encoder, so — mirroring ADR-028's SVG choice for images — the format is whatever can be *genuinely, correctly* hand-encoded: a real GIF89a encoder plus a real general-purpose LZW decoder (used only for testing, but a real one, not hard-coded to this encoder's trivial output). Each clip visibly animates (a marker sweeps across the frame, a progress bar fills) so it's obviously a real per-frame render. Prompt text is **not** rendered into the pixels — unlike the SVG mock, embedding readable text into hand-encoded indexed-color raster frames would need a bundled bitmap font, which was deliberately avoided to stay dependency-free; the prompt/scene metadata remains fully available via the API.
2. **Script + storyboard (docs/07 §2.2 stages 1-2) collapse into one deterministic planner** (`planScenes` in `packages/media/src/video-storyboard.ts`) — the same honesty pattern as ADR-018's agent-core planner: a real, working scene-decomposition algorithm (`ceil(targetDurationSeconds / sceneClipSeconds)` scenes, each ≤ the clip length, the last absorbing the remainder), with templated (not LLM-authored) shot descriptions, clearly labeled as a stand-in until a real LLM key exists.
3. **The DB data model is deliberately narrower than docs/07 §2.4's full design**: `video_projects` and `video_scenes` fold "timeline" and "render" concerns onto the project row directly, with no separate `Timeline`/`AudioTrack`/`SubtitleTrack`/`RenderJob` tables and no consistency-reference columns — because there is no real LLM script, no `AudioProvider`/`MusicProvider`, and no subtitle stage yet to populate them. Revisit once those exist.
4. **Rendering (stage 8) shells out to a system `ffmpeg` binary** (safe `spawn`, argument arrays, `shell: false` — same pattern as `packages/tools/src/native/terminal.ts`) rather than bundling one via npm. If ffmpeg isn't found on `PATH`, the project still ends `succeeded` (every scene generated correctly) with `renderStatus: "skipped_no_ffmpeg"` and an explanatory message — never a fabricated video file.

**Reason (ffmpeg specifically):** both realistic npm options carried real trade-offs evaluated directly, not assumed: `ffmpeg-static` runs a postinstall script (`install.js`) that downloads a compiled binary from GitHub at install time — a real supply-chain surface, even though it's a popular, actively-maintained package (last published 2025-11-14). `@ffmpeg-installer/ffmpeg` avoids the network fetch (binary is published via per-platform npm packages) but hasn't been updated since 2021 — its bundled ffmpeg build is over five years stale and very likely carries unpatched CVEs, the same risk shape as `sharp`/`onnxruntime-node` already rejected in ADR-026. Presented to the user as an explicit tradeoff via `AskUserQuestion`; the user chose the no-new-dependency option.

**Resumability — verified for real, not just designed:** `orchestrateVideoProject` (docs/07 §2.3's literal mechanism) only (re-)enqueues scenes whose status is not already `succeeded`. `packages/media/src/video-pipeline.integration.test.ts` proves this against a real PGlite Postgres + real pg-boss queue: a `FlakyVideoProvider` wrapping the real `MockVideoProvider` is configured to fail exactly one scene; after the first run the project is `partially_succeeded` with that one scene `failed` and the other three `succeeded`; the failure is "fixed" and orchestration is re-run; the previously-failed scene gets a second provider call while the three already-succeeded scenes' asset ids and `updatedAt` timestamps are asserted **unchanged** — i.e., they are never resubmitted.

**Verified for real (live, end-to-end, not just unit tests):** booted `apps/api`, `POST /api/v1/videos` with a 16s/4s-clip request, polled to `succeeded` with all 4 scenes `succeeded` and `renderStatus: "skipped_no_ffmpeg"` (this sandbox has no ffmpeg installed); fetched a scene's asset over `GET /api/v1/assets/:id` and confirmed real `GIF89a` bytes (correct width/height/frame-count) that independently decode correctly; submitted a second project whose `sceneClipSeconds` (10s) exceeds the mock provider's capability ceiling (8s) and confirmed a real, clean failure path — both scenes `failed` with the provider's actual capability-check error message, project `partially_succeeded` with an actionable message. **The ffmpeg-present branch of `processVideoRender` (the actual scale/pad/concat commands) has not been exercised in this environment** — no ffmpeg install is available here — see [[27_RISKS_AND_LIMITATIONS]].

**Alternatives considered:** A full docs/07 §2.4 data model built up front — rejected as premature: it has columns (audio tracks, subtitle cues, consistency reference sheets) with no producer to populate them yet, which is exactly the kind of speculative schema this project's own principles argue against. Bundling `ffmpeg-static`/`@ffmpeg-installer/ffmpeg` — rejected per the ffmpeg reasoning above, confirmed by the user's explicit choice.

**Date:** 2026-08-31
**Impact:** New `packages/providers/video-mock` (GIF encoder/decoder + `MockVideoProvider`); new `video_projects`/`video_scenes` tables; `packages/media` gains `video-storyboard.ts`/`video-orchestration.ts`/`video-render.ts`; `packages/jobs`' `registerWorker` gains an optional `WorkOptions` passthrough (used for `localConcurrency` on the scene-generation queue, per docs/07 §1.6 "not all 150 scenes fire at once"); new `POST /api/v1/videos`, `GET /api/v1/videos`, `GET /api/v1/videos/:id`, `POST /api/v1/videos/:id/retry` routes; new `FFMPEG_PATH` env var (default `"ffmpeg"`, resolved via `PATH`).

---

## ADR-031: Phase 10 frontend — real screens for every backend that exists, plain CSS instead of Tailwind, three real bugs found only by driving a real browser

**Decision:** Built the 8 `apps/web` screens from [[16_FRONTEND_ARCHITECTURE]] that have a genuine, working backend behind them: an upgraded multi-conversation `/chat` (+ `/chat/[conversationId]`), the live SSE-driven agent execution detail view (`/agent/[id]`) that doc §"Agent execution UI" calls out as the one screen worth designing in detail, a coding-agent specialization of it (`/coding/[id]`, same component, a `variant="coding"` prop adding "commands run"/"files changed" tabs sourced from the same task-node data), `/tasks` (history + a task-creation form), `/images`, `/videos` (+ `/videos/[id]`), `/files`, and `/settings` (memory only). Deliberately did **not** build `/projects`, `/models`, `/providers`, `/usage`, `/admin` — presented to the user as a real trade-off via `AskUserQuestion` first, since none of the five has any backend at all (no projects table, no models/usage/admin API) and building UI for them now would mean showing fake data, which is exactly what this project's whole discipline exists to avoid.

**Styling deviation from docs/16, done consciously:** the frontend architecture doc recommends Tailwind CSS; this phase extended the existing Phase 1 plain-CSS approach (`globals.css`) instead, to avoid a new build-tool dependency (PostCSS config, Tailwind's own config surface) for what is purely a styling choice with no functional bearing — real, working screens mattered more than matching the styling recommendation exactly. Revisit if/when a design system is actually needed.

**New, small, additive backend surface** built specifically to support these screens (none of it existed before): `ConversationRepository.list()`, `TaskRepository.list()`, `GET /api/v1/conversations`, `GET /api/v1/conversations/:id/messages`, `GET /api/v1/agent/tasks` (list). All mirror the existing `list()`/`GET` conventions already used by documents/images/videos.

**Three real bugs found and fixed — every one of them only surfaces by actually driving a real browser, not by curl, unit tests, or code review:**

1. **CORS rejected DELETE (and PUT/PATCH).** `@fastify/cors`'s own default `methods` is `"GET,HEAD,POST"` — the `/api/v1/memory/:id` DELETE route has existed since Phase 6 but was only ever curl-tested, and curl doesn't enforce CORS preflight at all (that's a browser-only mechanism). The first real click of the Settings page's "Delete" button failed with a real preflight rejection in the browser console. Fixed by passing an explicit `methods` list to `@fastify/cors`'s registration in `apps/api/src/server.ts`.
2. **A bodyless request with a JSON content-type header 400'd.** The frontend's shared `request()` helper (`apps/web/app/lib/api.ts`) unconditionally set `Content-Type: application/json` on every call, including `DELETE`/bodyless `POST` (cancel task, retry video) that send no body — Fastify's body parser rejects that combination outright (`FST_ERR_CTP_EMPTY_JSON_BODY`, confirmed directly via `curl -X DELETE ... -H "Content-Type: application/json"`). Fixed by only attaching the header when `init.body` is actually present.
3. **A task that completed *while the page was open* never showed its final result.** `useTaskEvents`'s SSE handler only updated `task.state` from events carrying a `state` field; the `"completed"`/`"failed"` events (which carry `output`/`error`, not `state` — confirmed by reading `engine.ts`'s `finalizeTask`) were silently ignored by that same handler, so the "Final result" card only ever appeared after a manual page reload, never live. Caught by a Playwright script watching an `echo_chat` task complete in real time and asserting the card appeared — it didn't, on the first attempt. Fixed by adding dedicated `"completed"`/`"failed"` listeners that update `task.output`/`task.errorMessage` directly.

**Verified for real, in an actual headless browser, not just "should work":** used Playwright (`playwright-core`, driven against a Chromium build already cached locally from a prior `npx playwright` invocation — no network fetch needed) to script and screenshot a full pass across all 8 screens: sent a chat message, confirmed the mock response streamed in and the conversation survived a page reload with its history intact; created an `echo_chat` task and watched it reach `COMPLETED` live with the final result card rendering in real time (after fix #3 above); created a `fix_failing_test` coding-agent task against a real deliberately-broken fixture and watched the "Commands run"/"Files changed" tabs populate with the real failing→fixed→passing command output; generated a real mock image and confirmed the actual SVG rendered inline; generated a real 2-scene mock video and confirmed both scene GIFs rendered as playing `<img>` elements with the honest `SKIPPED_NO_FFMPEG` render badge (this sandbox has no ffmpeg — ADR-030); ingested a real file via `/files` and watched it reach `READY`; drove the full human-in-the-loop approval flow end to end (`delete_sandbox_file` task → "Waiting for approval" card → clicked Approve → task `COMPLETED` → confirmed the file was actually deleted from disk, not just marked so); added and deleted a real memory item (this is what caught bugs #1 and #2 above).

**A second, independent PGlite corruption incident, different in kind from ADR-029's:** this phase's very first API restart — triggered by `tsx watch` noticing the CORS fix in `server.ts` and restarting the process **on its own, not via any external kill** — crashed on the next boot with the same `RuntimeError: Aborted()` as ADR-029. This is a materially different trigger than "a forceful external `taskkill`": it suggests `tsx watch`'s own restart sequence does not necessarily let the old process release its PGlite file handle cleanly before the new one opens it, which is a real, if still only twice-observed, risk distinct from (and possibly compounding) ADR-029's forceful-kill finding. Recovered the same way both times: wipe the disposable `apps/api/data/pgdata` directory and let it re-migrate. Logged as an open item in [[27_RISKS_AND_LIMITATIONS]] rather than quietly worked around.

**Date:** 2026-08-31
**Impact:** `apps/web/app/{layout,globals.css,page}` + new `chat/`, `tasks/`, `agent/`, `coding/`, `images/`, `videos/`, `files/`, `settings/` route trees and a shared `lib/{api,use-task-events,status-badge,chat-stream}` client layer; `apps/api`'s `chat.ts`/`agent.ts` routes and `ConversationRepository`/`TaskRepository` gain list endpoints; `apps/api/src/server.ts`'s CORS registration.
