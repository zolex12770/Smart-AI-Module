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

---

## ADR-032: Phase 11 security hardening — a real, live-exploited argument-injection RCE found and fixed; structural prompt-injection delimiting; per-route rate limiting; RBAC/SSRF/CI-secret-scanning explicitly deferred, not faked

**Decision:** Scoped [[13_SECURITY_ARCHITECTURE]]'s full control list against what is honestly actionable in a single-operator, local-first, no-auth, no-multi-tenant system today, rather than building placeholder versions of controls that need infrastructure this platform doesn't have yet (an OIDC provider, a secret manager, a microVM sandbox runtime, object storage). Four real, load-bearing changes shipped; several sections of docs/13 are explicitly marked not-yet-applicable below rather than silently skipped.

**1. A real, critical vulnerability — found by attempting the exploit against a live server, not by review — and fixed:** `terminal.run_command`'s `args` were passed to `node` with zero validation beyond the command-name allow-list. Node's own CLI parser treats a single argv token like `--eval=<code>` as a flag, not a filename — `args: ["--eval=require('fs').readFileSync('../../secret.txt','utf8')"]`, submitted through the real, existing `fix_failing_test` task's `testFile` field, **genuinely read a file planted outside the sandbox root** on a running instance of this platform (confirmed twice: once by accident hitting the wrong relative depth, once precisely). This is exactly docs/13 §6's "highest-severity risk surface" (ASI05 Unexpected Code Execution), and it existed in code shipped in Phase 5, unnoticed until this phase's deliberate adversarial testing. **Fixed** in `packages/tools/src/native/terminal.ts`: any argument starting with `-` is rejected outright (this tool's only legitimate use is `node <script-file>`, which never needs a flag), and the first (script-path) argument is additionally resolved through `resolveSandboxedPath` — which gained a `resolutionBase` parameter (`packages/tools/src/native/sandbox-path.ts`) so the path is validated relative to the tool's already-sandboxed `cwd`, the same base Node itself will actually use, not relative to the sandbox root (which would silently validate the wrong path for any non-root `cwd`). Re-verified live after the fix: both the flag-injection and a leading-dash-free `../`-only variant are rejected with clear errors, and the legitimate `fix_failing_test` flow (real fail → real fix → real pass) still works identically. Locked in with 11 new automated tests in `packages/tools` (previously zero — a tracked gap since Phase 4).

**2. Structural prompt-injection delimiting (docs/13 §9.2 point 1), previously entirely absent:** `read_and_summarize`/`mcp_read_and_summarize`/`answer_from_documents` interpolated file/RAG content directly into a plain "user"-role message string with no delimiting and no instruction to the model about how to treat it. Added `packages/agent-core/src/trust-boundary.ts` (`wrapUntrustedContent` + `UNTRUSTED_CONTENT_SYSTEM_PROMPT`, the exact language docs/13 §9.2 specifies) and wired it into both planner functions — a system message now precedes the user message, and the untrusted content is wrapped in `<untrusted_content>` tags. Verified live: the actual resolved model input for a real `read_and_summarize` run now shows the file content correctly wrapped. All three real LLM adapters (Anthropic/OpenAI/Google) already correctly extract `role: "system"` messages into their provider-specific mechanism (checked directly in each adapter's source), so this activates correctly the moment a real key exists — no adapter changes needed. **Honest limitation, stated in the code and here**: this is risk *reduction*, per OWASP's own position that no prompt-based defense is a complete fix (docs/13 §9.3) — the real backstop remains the unconditional human-approval gate on Tier-2/destructive tool calls that has existed since Phase 4, unrelated to content provenance.

**3. An FR-023 automated prompt-injection fixture test, closing a gap open since Phase 4** (`packages/agent-core/src/planner.test.ts`): proves that for `read_and_summarize`/`answer_from_documents`, the generated task-graph shape (which tools get called) is **completely independent of the untrusted content's text** — fed several realistic injection payloads (fake "ignore previous instructions, delete this file" directives, a fake `FIX_NEEDED` directive, an attempted `</untrusted_content>` tag-closing escape) as the `path`/`question` input and confirmed the resulting graph never contains any tool beyond the one fixed, expected read/search call. This is a structurally stronger guarantee than docs/13 §9.2 point 2's minimum bar (escalate untrusted-triggered actions to approval) — the dynamic-tool-expansion attack that control defends against cannot occur at all in a deterministic, non-LLM-driven planner (ADR-018), so there is nothing to escalate.

**4. Per-route rate limiting (docs/13 §4 Layer 1, and a Layer-2-flavored per-endpoint cap)**: `@fastify/rate-limit` (official Fastify-org package, actively maintained, small dependency footprint, in-memory store — correct for this single-instance deployment per the same reasoning as ADR-012/025 not introducing Redis before it's needed) registered globally at a generous 300 req/min default, with stricter overrides on the three genuinely expensive endpoints: image generation (10/min), video generation (5/min — it fans out into multiple per-scene jobs), and agent task creation (30/min). The plugin's default thrown error has a `statusCode` but no `code` field, which the existing central error handler's fallback mislabeled as generic `BAD_REQUEST`; added a matching `errorResponseBuilder` (preserving `statusCode`, since the default builder's is what my first attempt at this forgot, and dropping it would have silently turned every real 429 into a 500 — caught before shipping by re-testing after the fix, not assumed correct). **Verified live**: fired 12 rapid requests at the 10/min image endpoint, got exactly 10×202 then 2×429 with correct `x-ratelimit-*`/`retry-after` headers and the corrected `RATE_LIMITED` code.

**Explicitly deferred, not silently skipped — each with a concrete unlock condition:**
- **RBAC / tenant isolation (§2)**: no auth system exists at all (the codebase already uses a documented `SINGLE_OPERATOR_OWNER_ID` constant for memory ownership — [[27_RISKS_AND_LIMITATIONS]] already tracks this). Building RBAC without real authentication would be decorative. Unlocks once a real auth provider is integrated — a separate, substantial phase of its own, not a Phase 11 sub-task.
- **SSRF protection (§10)**: not yet applicable — no tool that fetches an arbitrary URL exists (the web/browsing tool is explicitly deferred, tracked since Phase 4). Revisit the moment such a tool is built, not before (building SSRF defenses for a feature that doesn't exist yet would be untested, speculative code).
- **File upload restrictions (§12)**: mostly not applicable — there is no multipart file-upload endpoint; RAG ingestion takes a sandbox-relative path to a file the operator already placed there (docs/09, `apps/web`'s `/files` screen states this plainly), and generated assets are served from DB-recorded `storagePath` values, never user-supplied filenames, so the storage-path-traversal risk this section targets doesn't exist in the current design.
- **Managed secret store / secret rotation (§3, production half)**: current scale is a single local operator with `.env` + Zod-validated config (already matches §3's "local dev" guidance exactly); a managed secret store is Phase 14 cloud-deployment scope (ADR-011 gates any real cloud provisioning on explicit authorization), not something to half-build now with no cloud environment to hold it.
- **CI secret-scanning (§3)**: no CI pipeline exists in this repo at all yet — a scanning step with nothing to run it on is inert. Ran a manual one-off scan of tracked files for common committed-secret patterns (API key prefixes, private-key headers) as a substitute check for this pass; found nothing. Revisit when CI is introduced.
- **Sandbox isolation strength (§6, microVM/gVisor)**: the coding agent's execution already runs through an allow-listed, argument-validated, path-sandboxed `child_process.spawn` (not a shell), which is real containment for the one command (`node`) this platform actually runs — but it is process-level isolation, not the OS/VM-level isolation docs/13 recommends for untrusted AI-generated code at production scale. Tracked as a known, accepted gap for the current scope; revisit before allow-listing any command with a larger attack surface than `node`.

**Date:** 2026-09-02
**Impact:** `packages/tools/src/native/{terminal,sandbox-path}.ts` (+11 new tests); `packages/agent-core/src/{trust-boundary,planner}.ts` (+6 new tests); `apps/api/src/server.ts` (`@fastify/rate-limit`) and `routes/v1/{images,videos,agent}.ts` (per-route limits). [[27_RISKS_AND_LIMITATIONS]] gains the deferred items above as tracked, honestly-scoped open risks rather than assumed-solved.

---

## ADR-033: Phase 12 observability — real structured logs + real OTel spans via manual instrumentation and a console exporter, no Docker-based LGTM stack, no metrics, no Cloud export

**Decision:** Built [[20_OBSERVABILITY]]'s two most load-bearing signals — structured logging and distributed tracing — for real, scoped to what's honestly verifiable without Docker (not installed in this sandbox, per docs/20 §4's own acknowledged fallback) or a GCP project (ADR-011). New `packages/observability`: `createLogger()` (a shared, redacting Pino instance — `pino` directly, not Fastify's `logger: true`, so job workers running outside any HTTP request share the exact same structured format and redaction config as request/response logs) and `initTracing()`/`getTracer()`/`withSpan()` (a real `NodeTracerProvider` with `AsyncLocalStorageContextManager` — confirmed correct by reading `NodeTracerProvider`'s own source, not assumed — exporting to `ConsoleSpanExporter`).

**Why manual spans, not auto-instrumentation:** `@opentelemetry/instrumentation-http`-style auto-instrumentation patches modules at `require()` time, which is unreliable to sequence correctly against this project's static ESM imports and `tsx watch` — a real, known friction point for OTel+ESM, not a hypothetical one. Manual spans at exactly the points docs/20 §3.3 cares about (`gen_ai.chat`, `job.process`) are simpler, more precise, and don't depend on getting that sequencing right.

**Why a console exporter, not OTLP-to-a-Collector:** no Collector/Tempo/Grafana is running (no Docker), so there is nothing to export OTLP *to* — installing the OTLP exporter machinery now would be unexercised code. `ConsoleSpanExporter` is a first-class, supported OTel exporter (not a hack), and swapping it for a real OTLP exporter later is a one-line change inside `initTracing()` — no call site that creates a span needs to know or change, which is exactly docs/20 §4's stated design goal ("only the exporter configuration differs per environment").

**Verified live, end to end, both halves of this phase's roadmap exit criterion:**
- **One real chat**: `POST /api/v1/chat` produced an "incoming request" log with `reqId: "req-1"`, a "provider call completed" log with the matching `request_id: "req-1"` plus `provider`/`model`/`tokens_input`/`tokens_output`/`latency_ms`, and a real `gen_ai.chat` span (`request_id: "req-1"`, `gen_ai.system`, `gen_ai.request.model`, token-usage attributes, `status: OK`) — the same id present on the log line and the span.
- **One real job**: `POST /api/v1/images` returned a generation id; the async worker's "provider call completed" and "job completed" logs both carried `request_id: "req-2"` (the *originating HTTP request's* id, propagated through the job payload — see `routes/v1/images.ts`) alongside `job_id` (the generation id), and a real `job.process` span carried both. Re-verified with the long-form video pipeline too: `request_id` propagated correctly through *two* job hops (`video.generate_scene` → `video.render`, via `orchestrateVideoProject`/`checkProjectCompletion` in `packages/media`), proving the propagation mechanism generalizes beyond the single-hop image case.
- A real span-nesting bug was found the same way earlier phases have found real bugs — by testing, not review: `packages/observability`'s own test suite initially registered a fresh `NodeTracerProvider` per test in `beforeEach`, and the second test's spans silently vanished. Root cause: `trace.setGlobalTracerProvider()` is idempotent — first registration wins, later ones are silently ignored — so the second test's `getTracer()` was still bound to the first test's (different) exporter. Fixed by registering once in `beforeAll` and resetting the shared exporter between tests; documented in the test file since this is a real, non-obvious OTel API property worth not re-discovering later.

**Explicitly deferred, not silently skipped:**
- **Metrics (§2)**: no Prometheus/Grafana exists to scrape or display them, so emitting OTel metrics now would have no consumer — pure unexercised code. Revisit once Docker (or a hosted metrics backend) exists.
- **Full `agent.run`/`agent.step`/`tool.call` span coverage (§3.3)**: a real structural mismatch, not an oversight — an agent run can pause for human approval for an arbitrary, unbounded duration (docs/13 §7), so a single lexically-scoped `withSpan()` call (which requires the entire traced operation to happen within one contiguous `async` function) cannot represent it; that needs an explicit start-now/end-later span lifecycle tied to task persistence, a genuinely different (and larger) pattern than the one built this phase. `gen_ai.chat` and `job.process` — the two spans that map directly onto this phase's actual exit criterion — are real and verified; the richer agent-domain span tree is tracked as open work.
- **OTLP export to a real Collector, Cloud Trace/Logging/Monitoring**: no Collector, no GCP project. The application code has nowhere to point either exporter at yet; wiring them in now would be unverifiable.
- **Cost estimation (§1.3)**: no versioned per-provider pricing table exists (that's docs/22_COST_AND_QUOTA_STRATEGY's scope); token counts are already logged/attributed (`tokens_input`/`tokens_output`), so adding `cost_estimate_usd` is a follow-up multiplication once that table exists, not a redesign.

**Date:** 2026-09-02
**Impact:** New `packages/observability` (`logger.ts`, `logging.ts`, `tracing.ts` + 3 tests); `apps/api/src/index.ts` (tracing/logger init, `runJob` helper, request-id-carrying job payloads for all four job types); `apps/api/src/server.ts` (Fastify now takes a shared `loggerInstance`); `apps/api/src/routes/v1/{chat,images,rag,videos}.ts` (provider-call/job logging, `gen_ai.chat` span, request-id propagation); `packages/media/src/video-orchestration.ts` (`requestId` threaded through `orchestrateVideoProject`/`checkProjectCompletion`/`processVideoScene`).

---

## ADR-034: Automated test coverage for the agent-core state machine and the API HTTP layer — real PGlite/real dispatcher/real `app.inject()`, no mocked internals

**Decision:** Closed the two longest-standing tracked gaps in `docs/29_FEATURE_MATRIX.md`'s testing row (open since Phase 3/4 and Phase 1 respectively): the `AgentEngine` state machine/dispatcher itself, and the API's HTTP route layer. Both follow this project's established "test for real" pattern (rag/jobs/media's own integration tests) rather than mocking the systems under test.

**`packages/agent-core/src/engine.test.ts` (10 new tests, real PGlite + real repos + real `ToolRegistry` with real sandboxed filesystem tools + the real `MockLLMProvider`, zero mocked engine internals):** a single-step and a real multi-step task (proving template resolution actually threads a real file's content into a real model call, not just that both steps individually "work"), the full approve/reject HTTP-adjacent flow at the engine level (asserting the real file was/wasn't touched on disk, not just a status field), `cancel()`, live event ordering via `subscribe()`, a regression test for the historical cascade-loop bug (asserting a bounded transition count, not just "it doesn't hang forever" which a timeout would mask either way), and three crash-recovery scenarios exercising `resumeAll()` against a *second, freshly-constructed* `AgentEngine` sharing the same underlying repositories — the way a real process restart actually looks — covering all three branches docs/11 §4.2-4.3 describes: auto-resume (model call), no-auto-retry-surface-for-reconciliation (mutating tool call, with a real assertion the file was never touched), and replan-from-scratch (crashed before any nodes existed).

**`apps/api/src/routes/v1/{agent,images,rag}.test.ts` (14 new tests) via a new `test-app.ts` harness:** builds the *real* `buildServer()` app — real PGlite, real dispatcher, real filesystem tools, real (started but worker-less) pg-boss queue — and drives it with Fastify's own `app.inject()`, which runs a request through the full middleware/route/serialization stack without binding a real network socket. Covers task creation-through-completion over HTTP, validation 400s, 404s, the full approve-a-destructive-action HTTP flow (again asserting the real file was deleted, not just a 200), image-generation creation/validation, and — deliberately — regression tests for both real bugs Phase 10's browser testing found (the CORS-preflight-excludes-DELETE bug and the empty-JSON-body-on-DELETE 400), plus a live re-verification of Phase 11's rate limiter (10 requests through, 2 real `429 RATE_LIMITED`) at the HTTP layer specifically, not just the plugin level. Endpoints that hijack the raw reply for SSE (`chat.ts`'s POST, `agent.ts`'s `/events`) are not covered here — `reply.hijack()` bypasses Fastify's normal response lifecycle in a way `inject()` isn't designed to observe cleanly; those remain manually/Playwright-verified only, an honestly narrower gap than "no test coverage," not a silently accepted one.

**A real bug found by this pass, not by review:** the very first `apps/api` test run failed a suite that was never written — `data/sandbox/coding-demo/math.test.js`, a real fixture file the coding-agent's own tests (Phase 5) write to and run via the terminal tool, matching vitest's default test-discovery glob and getting collected as an actual test file, then failing on its own `process.exit(0)`. No other package hit this because none of them have a runtime `data/` directory sitting alongside `src/`. Fixed with a one-line `apps/api/vitest.config.ts` scoping discovery to `src/**/*.test.ts` — the same effective scope every other package already had by default, just made explicit here since the default was no longer safe.

**Date:** 2026-09-02
**Impact:** New `packages/agent-core/src/engine.test.ts`; new `apps/api/src/test-app.ts` (reusable test harness), `apps/api/src/routes/v1/{agent,images,rag}.test.ts`, `apps/api/vitest.config.ts`. 81 tests now pass across 19 files (up from 57/16). No production code changed — this is test-only, aside from the new `vitest.config.ts`.

---

## ADR-035: Phase 13 — a real (if unproven) CI workflow, and a real redaction bug found by the secret-leakage test that was supposed to prove there wasn't one

**Decision:** Closed the two concrete, non-Docker-blocked items left open from [[21_TESTING_STRATEGY]]/[[13_SECURITY_ARCHITECTURE]] §3/§2.8: a CI pipeline definition, and an automated secret-leakage test.

**1. `.github/workflows/ci.yml`** — install, `build:packages`, typecheck, full `build`, `test`, `npm audit --audit-level=high`, plus a separate `gitleaks` job (docs/13 §3's own named tool, now that CI exists to run it on — closes the item [[27_RISKS_AND_LIMITATIONS]] had tracked as blocked on exactly this precondition). No Testcontainers/Postgres/Redis service containers are needed at all: this whole test suite already runs against PGlite (ADR-025) and pg-boss's native PGlite adapter (ADR-027), a real embedded Postgres, not a service this pipeline needs to stand up separately.

**Every step in the file was verified locally against a genuinely fresh build state before being written down as fact, not assumed correct**, by wiping every package's `dist/` and `.tsbuildinfo`, then running `npm ci` followed by the exact step sequence in the file. This caught a real ordering bug before it could fail in an actual CI run: `npm run typecheck` (a plain per-package `tsc --noEmit`, not `tsc -b`) resolves a cross-package import like `@ai-platform/shared` through that package's *compiled* `dist/*.d.ts` output, not its source — so on a truly fresh checkout, `npm run typecheck` fails immediately with "Cannot find module" for every single cross-package import, something no one had ever noticed because local development always already had `dist/` built (via `predev` or a manual `build:packages` run) before typecheck ever ran. Fixed by inserting `build:packages` before `typecheck` in the workflow — verified by re-running the corrected sequence from the same wiped state through to a fully green `npm test` and a clean `npm audit --audit-level=high` (exit 0, the 4 already-accepted moderate `drizzle-kit`/`esbuild` advisories reported but not gating, matching their documented acceptance).

**Honest limitation, stated plainly rather than glossed over**: this repository has no GitHub remote in the environment that authored this file, and the `gh` CLI isn't available in this sandbox either — so the workflow has been validated for correctness by running every one of its commands locally, but it has **never actually executed inside GitHub Actions**. "CI green" per the roadmap's own exit criterion is therefore unverified in the one way that would fully confirm it (a real Actions run), pending this repo being pushed somewhere — the same class of gate ADR-011 already applies to real cloud provisioning, applied here to real external hosting.

**2. A real secret-leakage test (docs/21 §2.8), `packages/observability/src/logger.test.ts`** — captures actual Pino log output through a real logger instance (a custom `Writable` destination, not a mocked logger) and asserts a fake secret-shaped value never appears in the emitted JSON. **This test caught a real bug in the redaction config it was meant to prove already worked**: `LOG_REDACT_PATHS` used wildcard paths like `*.apiKey`, on the mistaken assumption (stated as fact in the original code comment) that this means "redact `apiKey` at any depth." It doesn't — `fast-redact` (Pino's redaction engine) treats a bare `*` as "any key at exactly one specific depth," so `*.apiKey` only ever matched a *nested* field and silently passed a top-level `{ apiKey: "..." }` straight through unredacted, which is exactly the shape a naive `logger.info({ apiKey })` call would produce. There is no fast-redact syntax for "this key at any depth" at all — the real fix is to list each secret-shaped field name explicitly at both the top level and one level of nesting (the only depths any real call site in this codebase produces). `createLogger()` gained an optional `destination` parameter (defaults to stdout, i.e. no behavior change for real callers) specifically so this test could capture output without touching global stdout.

**Date:** 2026-09-02
**Impact:** New `.github/workflows/ci.yml`; new `packages/observability/src/logger.test.ts`; `packages/observability/src/logging.ts` (`LOG_REDACT_PATHS` corrected) and `logger.ts` (`destination` parameter). 85 tests now pass across 20 files (up from 81/19).

---

## ADR-036: Real PDF and DOCX ingestion — `pdfjs-dist` for PDF, a hand-rolled ZIP+XML reader for DOCX

**Decision:** Closed the longest-standing RAG gap ([[09_RAG_ARCHITECTURE]] §2, [[27_RISKS_AND_LIMITATIONS]], [[29_FEATURE_MATRIX]] rows 9/10 — open since Phase 6): `processDocumentIngestion` (`packages/rag/src/ingest.ts`) now dispatches on file extension to two real, from-scratch-evaluated parsers instead of unconditionally reading every file as UTF-8 text.

**PDF — `pdfjs-dist` (Mozilla's PDF.js), not a hand-rolled parser, not `pdf-parse`.** A real PDF parser (correct handling of compressed cross-reference streams, object streams, CID-keyed fonts, and CMaps — all common in PDFs from modern generators like Chrome print-to-PDF and LibreOffice) is a substantially larger undertaking than [[26_DECISIONS]] ADR-030's GIF codec or this ADR's own DOCX reader below, and a subtly-incorrect hand-rolled implementation would risk silently garbling extracted text — a worse outcome for RAG accuracy than not supporting PDF at all (docs/27's own standing concern about citations being trusted at face value). `pdfjs-dist` was evaluated directly, not assumed safe: **zero runtime dependencies** (confirmed via `npm view`), **no install/postinstall script**, Apache-2.0, actively maintained (published four days before this decision), and its only native-binary-adjacent dependency (`@napi-rs/canvas`, for rendering pages to bitmap images) is a **peer-optional** dependency this project never installs, since only text extraction is needed. `npm audit` after installing shows zero new findings — the same four pre-existing, already-accepted `drizzle-kit`/`esbuild` moderate advisories and nothing else. This is not the same risk shape as ADR-030's `ffmpeg-static`/`@ffmpeg-installer/ffmpeg` rejection or ADR-026's `@huggingface/transformers` rejection (both had a real, confirmed supply-chain or CVE cost); it did not need to be put to the user as a trade-off the way those did. Only the `legacy` build (`pdfjs-dist/legacy/build/pdf.mjs`) works under plain Node — the package's main export assumes browser Web Crypto (`Uint8Array.prototype.toHex`) and throws immediately otherwise, confirmed by hitting the error directly before switching builds.

**DOCX — a real, hand-rolled ZIP central-directory reader (`packages/rag/src/parsers/zip.ts`) plus a WordprocessingML text-run extractor (`parsers/docx.ts`), no new dependency.** Unlike PDF, the DOCX-as-ZIP-of-XML format is genuinely tractable to implement correctly from the public spec: a ZIP reader only needs the End-of-Central-Directory record, central directory entries, and local file headers (Node's built-in `zlib.inflateRawSync` handles the one compression method — 8, deflate — every real DOCX writer uses), and the text extraction only needs to walk `<w:t>` runs and `</w:p>` boundaries. This is the same "real implementation over a new dependency" call as ADR-030's GIF89a encoder: `mammoth` (the standard npm choice) pulls in 10 transitive dependencies for a task this narrow scope doesn't need. Deleted tracked-change text (`<w:delText>`, not `<w:t>`) is correctly excluded as a side effect of only reading `<w:t>` — no special-casing needed, matching docs/09 §2's DOCX guidance.

**Deliberately narrower than docs/09 §2's full target design, for both formats**: reading order follows each format's own text stream (PDF.js's text items in the order they appear in the content stream; DOCX paragraphs in document order) with no column/table detection or Markdown-table restructuring, and no heading-hierarchy/`section_path` metadata. Table cells and multi-column PDF text fold into ordinary paragraph-shaped text for the existing `chunkText` splitter. The same honest-narrowing shape as ADR-030's video data model.

**Verified for real, not just unit-tested:** 14 new tests (`zip.test.ts`, `docx.test.ts`, `pdf.test.ts`) — the ZIP tests round-trip both deflate and stored entries through a real ZIP archive built in-memory (`zip-fixtures.ts`, test-only, excluded from the package's compiled output); the DOCX tests cover multi-run paragraphs, `<w:tab/>`/`<w:br/>`, XML entity decoding, and the tracked-changes exclusion above; the PDF tests build a real, byte-correct minimal PDF (computed offsets, not transcribed) and assert exact extracted text across one and multiple pages, plus a real thrown error for a non-PDF buffer. **Live end-to-end**: booted `apps/api`, `POST /api/v1/files` with a real PDF and a real DOCX, both reached `status: "ready"`; a real `answer_from_documents` agent task's `rag.search_documents` step returned each file's actual extracted text (not placeholder content) ranked by real relevance — the PDF's remote-work content ranked first (lower cosine distance) for a remote-work question, the DOCX's expense-policy content ranked second — proving both parsers, chunking, embedding, and retrieval are wired together correctly, not just individually working.

**Alternatives considered:** `pdf-parse` v2 — rejected, hard-depends on `@napi-rs/canvas` (a native prebuilt-binary package) for every install, unlike `pdfjs-dist`'s peer-optional treatment of the same package. `mammoth` for DOCX — rejected per the dependency-weight reasoning above, not a correctness concern (mammoth is a fine, real library). A hand-rolled PDF parser — rejected as too large/fragile a surface for this scope, per the PDF reasoning above.

**Date:** 2026-09-02
**Impact:** New `packages/rag/src/parsers/{zip,docx,pdf,zip-fixtures}.ts` and matching `.test.ts` files; `packages/rag/src/ingest.ts` (extension-based dispatch); `packages/rag/package.json` (new dependency: `pdfjs-dist`); `packages/rag/tsconfig.json` (excludes the test-only `zip-fixtures.ts` from compiled output, mirroring `apps/api`'s `test-app.ts` exclusion). 99 tests now pass across 23 files (up from 85/20).

---

## ADR-037: Phase 14 — real Postgres connectivity, Dockerfiles, and Terraform IaC (docs/IaC only, unauthorized to provision, per ADR-011)

**Decision:** Closed the roadmap's stated Phase 14 scope (docs/25 — Dockerfiles, IaC for the docs/18_CLOUD_ARCHITECTURE.md recommendation, a deployment runbook) plus one real prerequisite gap found before any of that would have been more than paperwork.

**1. Real standalone-Postgres connectivity — found and closed before writing any Terraform.** `packages/database/src/client.ts`'s `createDb()` only ever opened a local embedded PGlite instance; there was no code path to connect to a real server (e.g. Cloud SQL) at all, which would have made "provision a Cloud SQL instance via Terraform" pure theater — infrastructure the deployed container could never actually use. Presented to the user as an explicit scope fork via `AskUserQuestion` (ship Dockerfiles/IaC only and flag the gap, vs. also build real connectivity); the user chose to build it.

- New `createPostgresDb(connectionString)` in `client.ts` using `drizzle-orm/node-postgres` + `pg` (already present transitively via `drizzle-orm` and `pg-boss` — the de facto standard Postgres driver for Node, not a new supply-chain surface). `DrizzleDb`, the type every repository is written against, is now the general dialect-agnostic `PgDatabase<PgQueryResultHKT, typeof schema>` base type rather than the PGlite-specific `PgliteDatabase<...>` — both `PgliteDatabase` and `NodePgDatabase` are `PgDatabase<...>` subtypes with an identical query-builder surface, confirmed directly from drizzle-orm's own type declarations, so **zero repository files needed to change** to support a second backend. Only `packages/database/src/repositories/document-chunk-repository.ts`'s raw `db.execute(sql...)` needed a one-line cast, since `.execute()`'s return type is generic over the driver-specific query-result kind that the general `DrizzleDb` deliberately leaves abstract — both drivers' real result objects carry `.rows` at runtime (the standard `pg`-style convention both follow), so the cast reflects an actual stable shape, not a fudge.
- `packages/database/src/migrate.ts` gained `runPostgresMigrations()` (drizzle's migrator is driver-specific, unlike the query builder, so this needed its own entry point); `migrate-cli.ts` branches on `DATABASE_URL`.
- `apps/api/src/index.ts` gained a `connectDatabase()` composition-root helper selecting PGlite (default, unchanged) vs. real Postgres (`DATABASE_URL` set) once, and threading a backend-agnostic `db`/`jobQueueOptions`/`close()` through the rest of boot — `packages/jobs`' `JobQueue` already only needed a `connectionString` option added (`pg-boss`'s own default connection adapter reads it directly; confirmed from pg-boss's source that `db: undefined` correctly falls through to it) since its `db`/`backend` passthrough design was already storage-agnostic per its own pre-existing doc comment.
- **A real, separate bug found while researching this**: `@modelcontextprotocol/server-filesystem` was a `devDependency` in `apps/api/package.json`, but `index.ts` resolves and spawns it as a real subprocess in production code (the MCP integration, ADR-021), not just in tests. A production `npm ci --omit=dev`/`npm prune --omit=dev` (exactly what the new Dockerfile does) would have silently lost the whole MCP integration — the failure is soft (a try/catch around the connection attempt logs a warning and continues), but silent degradation of a real feature on every containerized deploy is still a real bug. Fixed by moving it to `dependencies`.
- **Verified for real, not just type-checked**: `packages/database/src/client.test.ts` (new — this package had no test suite at all before) proves `createPostgresDb` makes a genuine `node-postgres` TCP connection attempt, not a stub, by pointing it at a real unreachable address and a real nonexistent host and asserting the real `ECONNREFUSED`/`ENOTFOUND` errors that come back — the same "deliberately invalid target, confirm a real correctly-shaped failure" pattern ADR-023 used for the LLM provider adapters. **Honestly unverified**: a genuine round-trip (insert/query/migrate against a real running standalone Postgres) isn't possible in this sandbox — no Docker, so no local Postgres container either — the same class of gap as ADR-030's unverified ffmpeg-present branch.

**2. Dockerfiles** (`apps/api/Dockerfile`, `apps/web/Dockerfile`) — multi-stage, `node:24-alpine` (confirmed a real, currently-published tag via the Docker Hub registry API, since no local Docker exists to pull it), non-root `USER node` in the runtime stage. `apps/web` uses Next.js's `output: "standalone"` (`next.config.mjs`, newly enabled) for a minimal self-traced runtime bundle; `apps/api` copies the whole pruned monorepo (`npm ci` → build → `npm prune --omit=dev`) rather than a more surgical per-package copy, a deliberate simplicity-over-optimization call given this Dockerfile has never even been built once to know whether the more complex approach would matter. **Both builds copy the entire source tree in one layer rather than a dependency-only layer copied ahead of the rest** — sacrifices Docker's own layer-caching benefit, chosen because an npm workspaces monorepo's package list changing would otherwise silently make a hand-maintained "copy every package.json individually" layer go stale. `NEXT_PUBLIC_API_URL` (Next.js build-time-only, per its own framework's design) is a Dockerfile `ARG`, documented in the runbook as needing the real deployed API URL at image-build time, not left to be silently wrong against the `localhost:8787` dev default.

**Honestly unverified**: no Docker install exists in the environment that authored these files — `docker build` has never actually run. Both Dockerfiles were reviewed line by line against the already-verified local build sequence (`npm ci && npm run build:packages && npm run build --workspace=...`) but that is not the same as a real build having produced a real image.

**3. Terraform IaC** (`infrastructure/terraform/`) for docs/18_CLOUD_ARCHITECTURE.md's recommendation, **with two deliberate divergences from that document**, both because it was written pre-implementation and the system actually built took a different real path: no Cloud Tasks (the actual job queue is pg-boss directly on Postgres, ADR-012/ADR-027 — Cloud Tasks was never built), and no Memorystore/Redis (nothing in this codebase uses a distributed cache today; rate limiting is in-process per-instance, ADR-032). Provisioning either would be paying for infrastructure the app cannot use — the same discipline this project has applied to code throughout, applied here to infrastructure. Cloud SQL is reached through Cloud Run's built-in Cloud SQL Auth Proxy connector over the instance's public IP (IAM/cert-authenticated regardless), avoiding a VPC + private-services-connection setup entirely, matching docs/18 §3's explicit deferral of dedicated VPC networking. The worker still runs in-process with the API (one Cloud Run service, not a separate Worker Pool) — the same topology already tested locally; actually splitting it needs a small, currently-unbuilt code change (an env-gated worker-only boot mode), a concrete stated follow-up, not silently assumed done. Cloud Storage buckets (media/uploads/quarantine) are provisioned ahead of the code that will use them — `packages/media`'s `LocalAssetStore` and the RAG/coding-agent `SANDBOX_ROOT` are both local-disk-only today, which does not survive Cloud Run's ephemeral, multi-instance, scale-to-zero model at all; this is a real, structural, currently-open gap, tracked honestly (docs/27) rather than implied-solved by the buckets existing.

**A real bug found by actually validating this, not assumed correct**: `terraform validate` genuinely failed three times in a row with a misleading error ("Cannot use a `<type>` value in for_each. An iterable collection is required.") while iterating on the `dynamic "env"` blocks that conditionally inject optional LLM API keys from Secret Manager. Root-caused by isolated bisection (a minimal reproduction case, narrowing from a working example to the exact failing one): Terraform's `dynamic` block `for_each` genuinely cannot be driven by an expression derived from a `sensitive = true` variable, regardless of the collection type on either side of the conditional — a real Terraform limitation, not a config typo, and the error message doesn't name the actual cause. Fixed with `nonsensitive(var.x != "")` — revealing only the *presence* of a key, never the key itself, in the one place a boolean (not the secret) is genuinely needed for structural plan-time decisions. (The equivalent resource-level `count = var.x != "" ? 1 : 0` on the secret resources themselves was separately confirmed, via the same isolated testing, to have no such restriction.)

**Verified for real, as far as this sandbox allows**: a real `terraform` CLI was downloaded (no local install existed) and used to `init` (downloading and installing the real `hashicorp/google`/`hashicorp/random` providers) and `validate` this exact configuration — genuinely green, not assumed. A real `terraform plan` against a placeholder project id got as far as planning `random_id.bucket_suffix` (no GCP dependency) before failing with a real, correctly-shaped "no GCP credentials found" error from the provider itself — confirming the configuration is structurally sound up to the point where real GCP authentication is required, not silently broken. **Honestly unverified**: no real GCP project/credentials exist in this environment, so `terraform apply` has never run, and none of these resources have ever actually been created.

**4. Deployment runbook** (`infrastructure/DEPLOYMENT_RUNBOOK.md`) — a real, ordered procedure including the Artifact-Registry-before-images-before-everything-else bootstrapping sequence Terraform's own circular dependency here requires (the registry that receives pushed images is itself created by the same config the Cloud Run services — which need those images already pushed — live in), the `NEXT_PUBLIC_API_URL` build-time-value chicken-and-egg for a first deploy, and an explicit "known gaps this runbook does not close" section naming the asset-storage and worker-split follow-ups above rather than a runbook that reads as more complete than the system it deploys actually is.

**Alternatives considered:** Docs/IaC only, flagging the Postgres gap without closing it — rejected by explicit user choice (see above). A more surgical, per-package Docker layer-caching strategy — deferred as premature optimization for a Dockerfile that has never even been run once. Provisioning Cloud Tasks/Memorystore to match docs/18's original recommendation exactly — rejected, since the app doesn't use either.

**Date:** 2026-09-02
**Impact:** `packages/database/src/{client,migrate,migrate-cli}.ts`, new `client.test.ts` and `test`/`vitest` devDependency (this package's first test suite); `packages/database/src/repositories/document-chunk-repository.ts` (one cast); `packages/jobs/src/queue.ts` (`connectionString` option); `apps/api/src/{config,index}.ts` (`DATABASE_URL`, `connectDatabase()`); `apps/api/package.json` (`@modelcontextprotocol/server-filesystem` moved to `dependencies`); new `apps/api/Dockerfile`, `apps/web/Dockerfile`, `.dockerignore`; `apps/web/next.config.mjs` (`output: "standalone"`); new `infrastructure/terraform/{main,variables,outputs}.tf` + `.terraform.lock.hcl` + `terraform.tfvars.example`; new `infrastructure/DEPLOYMENT_RUNBOOK.md`. 102 tests now pass across 24 files (up from 99/23).

---

## ADR-038: Phase 15 — real cost/quota enforcement (FR-063/FR-061), an independent audit, and the divergences it found and fixed

**Decision:** Closed the roadmap's stated Phase 15 scope: cost/quota enforcement, a final pass on [[27_RISKS_AND_LIMITATIONS]], and `/docs/FINAL_AUDIT.md`.

**1. Real cost/quota enforcement — single-operator scope (ADR-008), the same narrowing `rag.ts`'s `SINGLE_OPERATOR_OWNER_ID` already applies elsewhere; FR-063's per-user/per-project wording doesn't map onto a platform with no auth system.** Researched what already existed before building anything new: all three real LLM adapters already parse and return real token usage (`packages/shared/src/chat.ts`'s `TokenUsage`), and `apps/api/src/routes/v1/chat.ts` already persists it to `messages.inputTokens/outputTokens` — a real foundation, not something to duplicate. What didn't exist anywhere: any cost/pricing table, any quota table, and any `usage_records`/`models`/`settings` table — [[22_COST_AND_QUOTA_STRATEGY]]'s design was pure aspiration until now.

- New `usage_records` table (real migration `0003_slow_reptil.sql`) — one row per real generation call across all three kinds (LLM/image/video), kept deliberately separate from `messages`' existing per-message tracking (a different query pattern: normalized aggregation for quota/dashboard vs. per-conversation audit trail) and from `image_generations`/`video_scenes` (which have no usage columns at all).
- `packages/model-router/src/cost-estimator.ts` — real, dated, cited per-token pricing for the exact model each real adapter currently defaults to. Two of the three needed live web research beyond [[04_MODEL_PROVIDER_RESEARCH]] (written before `gpt-5.6-terra` and `gemini-3.5-flash` existed): confirmed $2/$12 per million input/output tokens for `gpt-5.6-terra` (short-context standard tier, post the 2026-07-30 cut) and $1.50/$9 for `gemini-3.5-flash` (confirmed NOT the newer, cheaper $0.75/$3.75 introductory rate reported for `gemini-3.6-flash`/`3.7-flash` — an easy mix-up a less careful search would have made). `estimateLlmCostUsd()` returns `null`, never a fabricated number, for any unpriced provider/model (today, only the mock provider) — a config file, not a `models.cost_profile` DB column as [[14_DATABASE_ARCHITECTURE]]'s target design describes, since a real provider's price already changes independent of any deploy (both researched entries had already changed since docs/04 was written) and a DB-backed table with an editing UI is real, larger work FR-063's P2 priority doesn't justify yet.
- New `packages/quota` (`QuotaManager`) — daily/monthly token limits, a daily image limit, a monthly video-seconds limit, each independently optional (unset = no limit, since FR-063 says quotas "CAN be configured," not that they're on by default). Checked before enqueueing a job or making a model call, never after, per docs/22 — chat uses a real `~4-chars/token` pre-flight estimate (`estimatePromptTokens()`, the same heuristic `llm-mock` already used for its own usage reporting) purely to decide whether to reject now, since exact tokens aren't known until the provider responds; the amount actually recorded against the quota is always the real post-call figure.
- Wired into `apps/api/src/routes/v1/{chat,images,videos}.ts` (pre-flight rejection, a new `QuotaExceededError` → real `429 QUOTA_EXCEEDED`, matching FR-063's acceptance criterion "a clear error, not a silent overage") and `index.ts`'s image/video job handlers (real usage recorded only on real job success — a failed generation never happened, so it shouldn't consume quota). New `GET /api/v1/usage` (docs/15's documented but unbuilt route, FR-061) reports real token/image/video totals and configured limits; `pricedCallsOnly: true` in its response makes the "only priced calls count toward the cost total" limitation visible rather than silently undercounting.
- **A real, separate bug found while wiring this up, not by inspection**: `PgDatabase.execute()`'s generic query-result type meant the new `sumColumnSince()` aggregate helper needed the same kind of driver-agnostic-result cast ADR-037 already established for `document-chunk-repository.ts` — confirmed this is a recurring, understood pattern, not a one-off.
- **Verified for real, at every layer**: `packages/model-router` gained its first-ever test file (`router.test.ts`, closing a real gap the audit below found) plus `cost-estimator.test.ts` (12 tests total) exercising the real researched pricing math; `packages/quota/src/quota-manager.test.ts` (7 tests) runs against a real in-memory PGlite Postgres and the real `PgUsageRecordRepository` — including a real day-boundary-exclusion test (an old record correctly stops counting once the clock crosses midnight, not just "the arithmetic is right for a fixed window"); `apps/api/src/routes/v1/usage.test.ts` (5 tests) drives the full real `buildServer()` app via `app.inject()`, including three real `429`s at the HTTP layer for each of chat/images/videos. **Live end-to-end, not just tested**: booted the API with real tiny limits (`DAILY_TOKEN_LIMIT=50`, `DAILY_IMAGE_LIMIT=1`, `MONTHLY_VIDEO_SECONDS_LIMIT=10`), confirmed a first chat request succeeded and a second was rejected with the exact real running total ("41 used so far today"), confirmed the same for images, and confirmed a video project's real per-scene usage (2 scenes × 4s = 8s, aggregated from two separate job completions) correctly reduced the remaining budget seen by a subsequent request.

**2. An independent Phase 15 audit** (a fresh agent with no access to this session's own record of what was built, specifically to avoid the audit confirming its own author's assumptions) re-verified [[29_FEATURE_MATRIX]] against the real repository and answered docs/30's own three self-posed verification questions. Found:

- **CRITICAL, fixed**: [[30_FINAL_SYSTEM_SPEC]] listed "auth" under "Real, provider-swappable" components — no authentication/authorization system exists anywhere in this codebase (confirmed: zero JWT/session/login code in `apps/api/src`), and [[29_FEATURE_MATRIX]] row 25 had correctly said "NOT STARTED" the whole time. This is exactly the "claimed-working capability that's actually fake" pattern this audit exists to catch, in the one document whose own stated purpose is to be re-validated at this exact phase. Fixed: docs/30's prose and diagram now correctly show auth as not-started (single-operator scope, ADR-008), not real.
- **MEDIUM, fixed**: docs/30's system diagram showed a separate `apps/worker` box and a GCS-backed `storage` box — neither exists (the worker runs in-process per ADR-027, and only `LocalAssetStore` exists per ADR-037's own tracked gap). Both already correctly documented in prose elsewhere; only the diagram itself was stale. Annotated both boxes in place to show target-vs-actual rather than removing them, so the target design stays visible.
- **LOW/MEDIUM, fixed**: `packages/model-router`'s real fallback-order/no-mid-stream-retry behavior (confirmed by the audit to correctly match [[12_MODEL_ROUTING]]) had never been locked in as an automated test — only manually/live-verified once, in Phase 2. Closed with 5 new tests (`router.test.ts`) using real fake `LLMProvider` implementations exercising: explicit-provider requests never silently substituted even on failure, fallback on a pre-first-event failure, fallback on a real `error` event, no fallback once a real token has streamed (a mid-stream failure surfaces as a stream-ending error, never a silent retry), and exhaustion of the whole fallback chain throwing.
- **Confirmed accurate, no action needed**: the agent execution UI's live SSE state-machine rendering, and long-form video's real per-scene-only resumability (docs/30's other two self-posed questions) — both independently re-verified against real source/tests, not just re-read from the feature matrix's own prior claim.

**3. `/docs/FINAL_AUDIT.md`** (new) records all of the above with severity, plus a systematic spot-check of [[29_FEATURE_MATRIX]]'s remaining rows — the roadmap's stated Phase 15 exit criterion (zero open CRITICAL items, every feature-matrix row accurate) is met: the one CRITICAL finding was fixed within this same phase, not left open.

**Alternatives considered:** A DB-backed `models.cost_profile` table matching [[14_DATABASE_ARCHITECTURE]]'s full target design — deferred as real, larger work (needs an editing UI, a migration per price change) that FR-063's P2 priority and this platform's current single-operator scale don't justify yet; a static, version-controlled config file is the honest MVP. Having the audit performed by this same session re-reading its own work — rejected in favor of an independent agent with no access to this conversation's summary of what was built, specifically so the audit couldn't just confirm its author's own claims.

**Date:** 2026-09-02
**Impact:** New `usage_records` table + migration; new `packages/database/src/repositories/usage-record-repository.ts`; new `packages/model-router/src/cost-estimator.ts` (+ its own test file) and `router.test.ts`; new `packages/quota` package; `apps/api/src/{config,context,index}.ts` and `routes/v1/{chat,images,videos}.ts` (quota wiring); new `apps/api/src/routes/v1/usage.ts` (+ test); `packages/shared/src/errors.ts` (`QuotaExceededError`); `docs/30_FINAL_SYSTEM_SPEC.md` (auth/worker/storage corrections); new `docs/FINAL_AUDIT.md`. 126 tests now pass across 28 files (up from 102/24).

---

## ADR-039: The job worker becomes a separate deployable — one image, a `ROLE` env var, a Cloud Run worker pool (post-roadmap; closes ADR-027's stated follow-up)

**Decision:** `apps/api`'s single entrypoint now reads `ROLE` (`all` | `api` | `worker`, default `all`) and starts only that role's responsibilities (`apps/api/src/role.ts`, a pure decision table). `infrastructure/terraform/main.tf` deploys the same image twice: the existing Cloud Run service with `ROLE=api`, and a new `google_cloud_run_v2_worker_pool` with `ROLE=worker` and its own service account. This is the follow-up ADR-027 named ("revisit `apps/worker` as a genuinely separate process once a real standalone Postgres exists") and ADR-037 re-flagged as "a small, currently-unbuilt code change" — ADR-037's `DATABASE_URL` path removed the PGlite single-process constraint that originally forced the worker in-process, so the split is now real rather than deferred.

**Why a role on one image rather than a second `apps/worker` package** ([[17_BACKEND_ARCHITECTURE]]/[[24_PROJECT_STRUCTURE]]'s original sketch): what actually needs to be independent is the *process* — its scaling, its failure domain, its event loop — not the *source*. The composition root (database connection, providers, repositories, asset store, job queue) is identical for both, so a separate package would have meant two verbatim copies of it kept in sync by hand. One image + `ROLE` is also the standard Cloud Run pattern for exactly this split, and means a single `docker build` and a single Artifact Registry image feed both units.

**What each role does — and, more importantly, what it deliberately does not.** The pg-boss queue is *started* and every queue is *ensured* in every role: the `api` role must still enqueue (pg-boss requires `start()` before `send()`), and `ensureQueue` is idempotent, so whichever process boots first creates the queues. Only the four `registerWorker` calls are gated (`api` never claims a job) and only the HTTP listener, agent engine, and MCP connection are gated (`worker` never serves a request — a Cloud Run worker pool has no ingress and runs no health checks, so binding a port would be waste). The observability service name follows the role, so a worker pool's logs and spans are attributable as `worker`, not misfiled under `api`. Graceful shutdown was factored into one shared `installGracefulShutdown()`; the roles differ only in what they close. `ROLE=all` is byte-for-byte today's local-dev topology, which stays mandatory locally (PGlite, ADR-025).

**Terraform:** the worker pool uses `MANUAL` scaling with one always-on instance — a worker pool does not scale to zero, so this is a real standing cost alongside Cloud SQL (docs/18 §4's "double-check the always-on minimums against the budget" applies); `manual_instance_count = 0` pauses processing without destroying the pool. No LLM keys are injected into the worker on purpose: no job type calls an LLM today, so least privilege says it shouldn't hold them. The worker pool resource was validated against the real `hashicorp/google` v6.50 provider schema (`terraform init`/`validate`, clean) the same way ADR-037's resources were.

**Verified for real, in all three roles, against a running process — not just by reading the code:**
- `ROLE=worker`: booted with service name `worker`, logged all four queues' workers registered, logged "no HTTP listener started", **nothing listening on 8787** (confirmed via `netstat`), no MCP connection attempted, process alive on pg-boss's polling loop.
- `ROLE=api`: HTTP listening, MCP connected, logged "job workers NOT registered"; a `POST /api/v1/images` was accepted (202) and **the job was still `pending` six seconds later with zero `job completed` log lines in that process** — the negative result that proves the gate is real, not cosmetic.
- `ROLE=all` (default): both halves ran exactly as before; a fresh job completed end to end.
- **A real cross-process hand-off:** the job the `api`-role process (pid 12456) had left pending was picked up and completed by the later `all`-role process (pid 19292) — pg-boss's persisted queue genuinely moved work from one OS process to another, which is the exact mechanism the Cloud Run split depends on.
- 3 new unit tests (`role.test.ts`) lock the decision table; 129 tests now pass across 29 files.

**Honestly unverified:** the two roles have only run *sequentially* here, never *concurrently* — PGlite permits one process per data directory, and no Docker means no local standalone Postgres to share. Concurrent api + worker against one real Postgres is exactly what the Cloud SQL deployment provides and exactly what this sandbox cannot exercise; it is the one remaining piece of this ADR's claim that a real deploy (or a Docker Postgres) is needed to close. Same class of gap as ADR-037's `createPostgresDb` round-trip.

**Alternatives considered:** A separate `apps/worker` package — rejected per the duplication reasoning above; the docs that sketched it ([[17_BACKEND_ARCHITECTURE]], [[24_PROJECT_STRUCTURE]]) are annotated, not rewritten, so the original design intent stays visible. A second Cloud Run *service* for the worker with a dummy HTTP port for health checks — rejected; docs/18 §1.1 already identified Worker Pools as the purpose-built (and cheaper) home for a queue consumer, and the provider supports them. Sharing the API's service account — rejected in favor of a separate identity with identical bindings today, so either can be narrowed independently later.

**Date:** 2026-09-03
**Impact:** New `apps/api/src/role.ts` (+ `role.test.ts`); `apps/api/src/config.ts` (`ROLE`); `apps/api/src/index.ts` (role gating, shared graceful shutdown); `infrastructure/terraform/main.tf` (worker service account + bindings, `google_cloud_run_v2_worker_pool`, `ROLE=api` on the API service); `docs/17_BACKEND_ARCHITECTURE.md`, `docs/24_PROJECT_STRUCTURE.md` (as-built annotations). Dockerfiles unchanged — the role is an env var, not a build. 129 tests now pass across 29 files (up from 126/28).

---

## ADR-040: A real Cloud Storage asset store behind an `AssetStore` interface (post-roadmap; closes ADR-037's last structural prerequisite for a working Cloud Run deploy)

**Decision:** `packages/media` gains an `AssetStore` interface — `store()` (already existed on `LocalAssetStore`) plus a new `read(asset)` — and a second real implementation, `CloudStorageAssetStore` (`gcs-asset-store.ts`, Google Cloud Storage via the official `@google-cloud/storage` client). `apps/api` selects it when `ASSETS_BUCKET` is set, exactly the opt-in shape ADR-037 used for `DATABASE_URL`; unset keeps today's local-disk default. Both Cloud Run units get `ASSETS_BUCKET = google_storage_bucket.media.name` in Terraform (the worker writes assets, the API reads them back, so both must point at one bucket — their service accounts already held `objectAdmin` on it since ADR-037).

**The interface change matters more than the new class.** Before this, two places read asset bytes by opening `asset.storagePath` from disk directly — the `GET /api/v1/assets/:id` route and the ffmpeg render (which handed the path straight to `ffmpeg -i`). Both now go through `assetStore.read()`; the render materializes each clip into its own temp dir first (one extra copy of a small clip for the local store; the download that has to happen anyway for GCS). `storagePath` is now explicitly "whatever the store that wrote the row understands": an absolute path from `LocalAssetStore`, a `gs://bucket/object` URI from `CloudStorageAssetStore` — precisely the "the column's interpretation changes, not the schema" outcome the `assets` table's original comment predicted. `parseGsUri` refuses a local path outright, so a row written by one store can never be silently misread by the other. Objects are keyed `<kind>/<id>.<ext>` so one bucket stays navigable; uploads are non-resumable (every asset this platform produces fits in one request — a resumable session is an extra round trip and a server-side session to leak on failure, for nothing).

**The dependency, reviewed the same way as `pdfjs-dist` (ADR-036) and `pg` (ADR-037), not assumed safe:** `@google-cloud/storage@8.0.1` — Google's official client, Apache-2.0, published 2026-08-18, no `install`/`postinstall` script (its `prepare` runs only for git/local installs, never a registry tarball). It adds 59 packages and **one new moderate advisory in the runtime tree**: `uuid < 11.1.1` (GHSA-w5hq-g745-h8pq, a missing bounds check in `v3`/`v5`/`v6` when a caller-supplied buffer is passed), reached via a transitive `uuid@9` under `gaxios@6.7.1`; the `gaxios` entry in `npm audit` is that same advisory, not a second one. Assessed rather than waved through: (1) our own `uuid` is 11.1.1 (patched); (2) `gaxios` calls only `uuid.v4()` — for a multipart boundary, `gaxios.js:417`, confirmed in its source — never the vulnerable `v3/v5/v6(name, ns, buf)` path, so the flaw is not reachable through this dependency as used; (3) `npm audit fix --dry-run` changes zero packages — the only fix is a semver-major bump upstream; (4) the CI gate (`npm audit --audit-level=high`, ADR-035) is unaffected. Accepted and recorded as a standing row in [[27_RISKS_AND_LIMITATIONS]] so it is re-checked, not forgotten — the first *runtime* (not dev-only) advisory this project has accepted, which is why the reasoning is spelled out here.

**A real bug found by the live check, invisible to the unit tests:** the emulator-backed integration suite passed cleanly, then the live run — the real API booted with the bucket configured, an image generated, the object confirmed in the bucket — returned a **500 on the read-back**. The tests had constructed the client with an explicit `apiEndpoint`; the live run relied on the library's `STORAGE_EMULATOR_HOST` env var. In `storage.js` the library sets `baseUrl = EMULATOR_HOST || \`${apiEndpoint}/storage/v1\`` — under the env var the base URL is the bare host *without* `/storage/v1`, so uploads (which build their own `/upload/storage/v1/...` URL) succeed while downloads (base-URL-relative `/b/<bucket>/o/...`) 404. The library's own source comments call the env var "experimental... use apiEndpoint instead." Fixed by making `apiEndpoint` an explicit store option (`GCS_API_ENDPOINT` in config, only ever set to point at an emulator), so the test path and the production path are now the *same* code — and a new test constructs the store exactly the way the composition root does, so the suite can never again pass while the real wiring fails.

**Verified for real, at every layer:**
- 7 tests in `asset-store.integration.test.ts`: `LocalAssetStore` round-trip on real disk + a real `assets` row (real in-memory PGlite); `parseGsUri` accepting `gs://` and refusing local paths; and, **against a real `fake-gcs-server` process driven through the real client**, a byte-identical upload/download round-trip with the object independently confirmed via the client's own metadata call, no `assets` row written when the upload fails, the production-constructor path, and the kind-prefix layout. The emulator binary isn't checked in (35 MB): the suite skips itself with a loud console warning when `FAKE_GCS_SERVER_BIN` is unset, and `.github/workflows/ci.yml` now downloads the pinned release so CI runs it rather than skipping.
- **Live, end to end**: the real API booted with `ASSETS_BUCKET` + `GCS_API_ENDPOINT` against a second emulator instance; `POST /api/v1/images` → job → `succeeded`; `GET /api/v1/assets/:id` returned `200 image/svg+xml`, 995 bytes, **sha256-identical** to fetching the same object straight from the emulator's JSON API; a 2-scene video project put both clips under `video/`; zero error-level log lines; and the local `ASSETS_ROOT` directory's newest file predates the run — nothing touched disk.
- 136 tests now pass across 30 files.

**Honestly unverified:** real Google Cloud Storage has never been touched — every byte went to an emulator. Untested: the Application Default Credentials path (`new Storage()` with no endpoint on Cloud Run), the Terraform IAM bindings actually authorizing the write, and real-GCS latency for the render's clip materialization. Same class of gap as ADR-037's Cloud SQL round-trip; the deployment runbook's verify step now names what to look for. **Still open, and now the *only* local-disk dependency left** ([[27_RISKS_AND_LIMITATIONS]]): `SANDBOX_ROOT` — RAG ingestion takes a sandbox-relative path to a file already on disk, and the coding agent's workspace lives there — is unchanged. That is a product-design question (how does a file *arrive* at a stateless container? an upload endpoint into the `uploads` bucket, then a fetch into a per-job temp dir?), not a storage-adapter swap, and is deliberately not folded into this ADR.

**Alternatives considered:** Redirecting `GET /api/v1/assets/:id` to a signed URL instead of streaming bytes through the API — a real later optimization once assets get large; rejected now because it changes the frontend's `<img src>`/CORS contract for no present benefit. An S3-compatible abstraction rather than the GCS client — rejected; docs/18 chose GCS, and the `AssetStore` interface is already the seam a second backend would plug into. Relying on `STORAGE_EMULATOR_HOST` — rejected per the bug above. Skipping the emulator and testing only with an injected fake — rejected; it would have hidden exactly the bug the live check found.

**Date:** 2026-09-03
**Impact:** `packages/media/src/asset-store.ts` (`AssetStore` interface, `read()`), new `gcs-asset-store.ts`, `image-generation.ts`/`video-orchestration.ts`/`video-render.ts` (typed to the interface; render materializes clips through it), new `asset-store.integration.test.ts`; `packages/media/package.json` (`@google-cloud/storage`); `apps/api/src/{config,context,index}.ts`, `routes/v1/images.ts` (asset route reads through the store), `test-app.ts`; `infrastructure/terraform/main.tf` (`ASSETS_BUCKET` on both Cloud Run units); `.github/workflows/ci.yml` (emulator download step); `packages/database/src/schema/index.ts` (comment). 136 tests now pass across 30 files (up from 129/29).

---

## ADR-041: Real file upload for RAG ingestion — `POST /api/v1/files/upload` into the AssetStore, with docs/13 §12 actually applied (post-roadmap; closes the RAG half of the `SANDBOX_ROOT` gap)

**Decision:** RAG ingestion no longer requires a file to already be sitting under `SANDBOX_ROOT`. A new multipart `POST /api/v1/files/upload` (`@fastify/multipart`, the official Fastify plugin — MIT, five small `@fastify/*` dependencies, no install scripts) stores the bytes through the same `AssetStore` ADR-040 introduced (kind `document`, so on Cloud Run they land in the media bucket under `document/<generated-id>.<ext>`), records a `documents` row carrying an `assetId`, and enqueues the *same* `document.ingest` job as before. `processDocumentIngestion` now takes bytes from whichever of the row's two sources is set — `assetId` (read through the store) or the original `sourcePath` (the sandbox flow, unchanged and still used by local dev and its tests) — and its parser dispatch keys off `filename`'s extension, which is the one source that works for both. The schema change is minimal and honest about the two flows: `documents.source_path` becomes nullable and `asset_id` is added with a real foreign key to `assets` (migration `0004`).

**Why this shape, rather than reworking `SANDBOX_ROOT` itself:** the sandbox root serves two unrelated purposes that only looked like one — it was RAG's *file input* and it is the coding agent's *working directory*. Only the first is a problem on a stateless instance (nothing can put a file there); the second is inherently a per-run scratch space and works fine on an ephemeral disk for the lifetime of one run. So the fix for RAG is an ingress path (upload → object storage → job), not a new place for the sandbox to live. The path-based `POST /api/v1/files` stays: it is real, tested, and the fastest local-dev loop, but it is now labeled dev-only in the UI and cannot do anything useful on Cloud Run.

**docs/13 §12, applied in full where it could be, and named where it couldn't.** ADR-032 recorded file-upload restrictions as "N/A — no upload endpoint exists"; now one does, so every control in that section is implemented in order in the route, not left for later: **allow-list by extension** (`.txt`/`.md`/`.pdf`/`.docx` — exactly and only what `packages/rag`'s parsers handle, so a file is rejected up front rather than failing later in the job); **declared MIME checked against that extension** (with `application/octet-stream` accepted as a *declared* type everywhere, because browsers — Windows especially — send it for any extension they don't recognize, `.md` and `.docx` included; rejecting it would reject real users, and it is the content sniff, not the header, that actually matters); **a hard size cap** enforced by the multipart parser itself (25 MiB, one file per request — surfaces as a real `413`, never a silent truncation); **real content validation** (`sniffDocumentBytes` in `packages/rag`): a PDF must carry the `%PDF-` signature, a DOCX must be a real ZIP that actually contains `word/document.xml` — checked with the same real ZIP reader the ingestion parser uses, not a magic-number guess — and text/Markdown must be valid UTF-8 with no NUL bytes; **rename on upload** — the store keys the object by a generated id, the original filename is reduced to a basename and kept for display only, never used to locate anything; **never render uploads inline** — `GET /api/v1/assets/:id` now sends `Content-Disposition: attachment` for `kind: "document"` assets, under the generated id; and the route carries the same **per-route rate limit** as image generation. **Not built, stated plainly:** docs/13 §12's malware scan before promoting from a quarantine location. The `quarantine` bucket Terraform provisions stays unused; this is a tracked row in [[27_RISKS_AND_LIMITATIONS]], not a footnote.

**Verified for real:**
- 5 tests for the content sniff (`sniff.test.ts`) — real PDF signature vs. an HTML file renamed `.pdf`; a real ZIP with `word/document.xml` vs. a ZIP without it vs. a PDF renamed `.docx`; UTF-8 text vs. a PNG-ish buffer with a NUL vs. invalid UTF-8; and a check that the allow-list is exactly the four parseable types and tolerates `octet-stream` everywhere.
- 8 route tests in `rag.test.ts` through the real `buildServer()` app with a **real multipart body** (the platform `FormData`/`Blob`, which Fastify's `inject()` streams with a real boundary): a text upload that is then driven through the real ingestion step — real store read, real chunking, real embeddings, real pgvector write — and retrieved by `searchDocuments`; a real minimal PDF upload ingested through the real PDF parser and retrieved; and the rejections — allow-list (`.exe`), declared-MIME mismatch, a content sniff failure (`<html>` renamed `.pdf`), a real `413` for 25 MiB + 1 byte, an empty file — plus the attachment header on read-back.
- **Live, against the running API**: real `curl -F` uploads of a Markdown file, the ADR-036 PDF fixture, and the ADR-036 DOCX fixture *declared as `application/octet-stream`* — all `202` with `sourcePath: null` and a real `assetId`; all three reached `status: "ready"` via the real job worker; a real `answer_from_documents` agent task then retrieved the uploaded Markdown's content as source `[1]` for a question answerable from nothing else; the `.exe`, the fake `.pdf`, and a two-byte `.docx` each got the specific `400` (the last one exercising a length guard added by inspection — without it, `readUInt32LE` on a short buffer would have been a `500`); the read-back carried `Content-Disposition: attachment; filename="<id>"`; nothing appeared under `SANDBOX_ROOT`; zero error-level log lines.
- 149 tests now pass across 31 files. (This session's live run also re-hit ADR-029's PGlite corruption on first boot — the day's forceful kills, surfacing exactly where that ADR says it does, at the next migration — recovered by the documented wipe, not by touching application code.)

**Honestly unverified / still open:** the upload → GCS path has only been exercised against the local store live and the emulator in ADR-040's tests — a real bucket has still never received an upload. The coding agent's workspace under `SANDBOX_ROOT` is unchanged and remains per-instance scratch: fine for one run, not durable, and not this ADR's problem to solve. Malware scanning: not built.

**Alternatives considered:** Making `SANDBOX_ROOT` itself object-storage-backed (a virtual filesystem over GCS) — rejected; it conflates RAG's ingress problem with the coding agent's working-directory needs, and would put a network round trip under every sandboxed tool call. Accepting only the exact declared MIME per extension — rejected as user-hostile for the `octet-stream` reason above; the content sniff is the stronger check anyway. A chunked/resumable upload protocol — unnecessary at a 25 MiB cap. Reusing `POST /api/v1/files` for both JSON-path and multipart bodies via content-type switching — rejected in favor of a distinct `/upload` route, keeping the existing route's contract, tests, and dev usage untouched.

**Date:** 2026-09-03
**Impact:** New `POST /api/v1/files/upload` (`apps/api/src/routes/v1/rag.ts`); `@fastify/multipart` registered in `server.ts` with `UPLOAD_MAX_BYTES`; `documents.source_path` nullable + `asset_id` FK (migration `0004`), `document-repository.ts` (`CreateDocumentInput` union); `packages/rag/src/parsers/sniff.ts` (+ tests), `ingest.ts` (`loadDocumentBytes`, `createPendingUploadedDocument`, bytes-based `extractText`, optional `assetRepo`/`assetStore` deps); `images.ts` (attachment disposition for documents); `apps/api/src/index.ts` (worker deps); `apps/web/app/lib/api.ts` (`uploadFile`), `files/page.tsx` (a real file picker; the path form kept, labeled dev-only); 8 new route tests. 149 tests now pass across 31 files (up from 136/30).

---

## ADR-042: Upload malware scanning — clamd's real `INSTREAM` protocol, status-based quarantine, a serve-gate, delete-on-reject, and a `clamav/clamav` sidecar on the worker pool (post-roadmap; closes docs/13 §12's last unimplemented control)

**Decision:** A new `packages/scanning` implements clamd's TCP protocol directly (`ClamAvScanner`: `zINSTREAM\0`, big-endian-length-prefixed chunks, a zero-length terminator, a NUL-terminated `stream: OK` / `stream: <Signature> FOUND` reply), behind a `MalwareScanner` interface. A new `document.scan` job sits between upload and ingestion: with `CLAMD_HOST` configured, `POST /api/v1/files/upload` records the document as `scanning` (`scan_status = pending`, migration `0005`) and enqueues `document.scan` instead of `document.ingest`; the worker role reads the bytes back through the `AssetStore`, streams them to clamd, and on a clean verdict advances the document to `ingesting` and enqueues the ordinary ingest job — on an infected verdict it marks the document `rejected` with the signature named, clears the asset reference, and deletes the object and its `assets` row. `GET /api/v1/assets/:id` gained a serve-gate: a `document`-kind asset whose document is `scanning` or `rejected` (or has none) is a 404. On Cloud Run the scanner is the official `clamav/clamav:1.5` image as a **sidecar container on the worker pool** (`CLAMD_HOST=127.0.0.1`); the deployed API sets `UPLOAD_SCAN_REQUIRED=true`.

**Quarantine is a status, not a bucket.** docs/13 §12 and docs/18 §1.4 sketched a quarantine bucket with a copy-on-promote step. What that buys is containment: an unscanned file must be unable to do anything. Here an upload already can't — `document.scan` is the only thing that enqueues `document.ingest` for an upload, and the serve-gate is the only read path — so a second bucket and a promotion copy would add moving parts (a second IAM surface, a copy that can half-fail) for no additional containment, and an infected object is *deleted*, which is strictly stronger than moving it. The provisioned-but-unused `quarantine` bucket ADR-041 had flagged is therefore removed from Terraform, with the reasoning in place of the resource.

**Why a daemon over TCP, a sidecar, and a hand-rolled client.** `clamscan` reloads the entire signature database on every invocation — tens of seconds per file — which is why every real deployment runs `clamd` (database resident in memory) and scans over its socket in milliseconds. clamd speaks raw TCP on 3310, which a separate Cloud Run *service* cannot expose (services are HTTP(S)-only), so Google's own reference architecture wraps it in a service; a sidecar on the one role that actually scans is simpler and keeps the scan off the network. The npm wrappers for clamd either spawn the CLI binaries or re-implement exactly this ~40-line, fully documented protocol; implementing it directly (the same call as the ZIP and GIF codecs) means no dependency and full control over the one property that matters for a security control — a scan that could not run is *never* reported as clean (`parseInstreamReply` throws on anything but the two known replies; a connection failure rejects; the job leaves the document `scanning` and pg-boss retries with backoff, tuned for the sidecar's 1–2 minute cold start).

**Fail-open locally, fail-closed deployed — and never silent.** With no `CLAMD_HOST`, uploads are accepted with a durable `scan_status = skipped_no_scanner` on the row (the `renderStatus: skipped_no_ffmpeg` honesty pattern from ADR-030 — an audit can always tell "scanned clean" from "never scanned"), the UI shows "not scanned (no scanner configured)", and boot logs a WARN in capitals. That is the right default for the single-operator dev loop (ADR-008), where the operator is the only uploader. `UPLOAD_SCAN_REQUIRED=true` flips it: the route refuses uploads with a real `503 SERVICE_UNAVAILABLE` (a new shared error class) *before reading a single byte*. The Terraform sets it on the deployed API, so a misconfigured deployment refuses uploads rather than quietly skipping the scan. The API service never scans anything (the sidecar lives on the worker pool), so its boot-time ping is a logged observation, not a gate.

**Verified for real, with the real scanner:**
- `packages/scanning` (7 tests): the reply grammar; an unreachable host (`ping()` false, `scan()` rejects — never clean); and, **against a real `clamd` process** started from ClamAV 1.5.4's official Windows build with a one-line custom `.ndb` signature database containing only the EICAR signature (no 200 MB database download needed): PING/PONG, clean bytes, the real EICAR sample streamed over `INSTREAM`, EICAR placed past the first 64 KiB chunk boundary (proving the multi-chunk framing), and a 5 MiB clean payload. The EICAR sample is assembled in memory from two halves and travels only over the socket — never written to this machine's disk. `.github/workflows/ci.yml` installs `clamav-daemon` and sets `CLAMD_BIN` so CI runs this for real; without the binary the suite skips itself loudly.
- `packages/rag` (4 tests, real PGlite + real `LocalAssetStore`): the job's branching — clean → `ingesting` + exactly one ingest enqueued; infected → `rejected` naming the signature, no ingest, bytes **and** row deleted, FK cleared; a scanner failure leaves the document `scanning`/`pending` and propagates; a retry on an already-handled document is a no-op that does not re-scan or double-enqueue. The scanner is the one dependency stood in for here by a scripted double, because this test is about what the job does with a verdict; the scanner itself is tested for real above.
- `apps/api` (3 route tests through the real app): with a scanner configured, an upload is held `scanning` and its asset 404s until the scan clears it, then 200s; an infected verdict rejects it, deletes bytes and row, and the asset 404s forever after while the document stays listed as `rejected`; `UPLOAD_SCAN_REQUIRED` with no scanner → a real 503 and nothing stored.
- **Live, end to end, with everything real**: the API booted with `CLAMD_HOST` (real clamd, EICAR-only DB), `ASSETS_BUCKET` (in-memory emulator, so EICAR never touched disk) — boot log `"reachable":true`; EICAR uploaded **from stdin** → `202 scanning/pending` → the asset 404'd while scanning → after the real job: `rejected`, `infected`, `errorMessage` naming `Eicar-Test-Signature.UNOFFICIAL`, `assetId: null`, the asset 404, **the object gone from the bucket**; a clean Markdown upload → `scanning` → `clean` → `ingesting` → `ready` → retrieved by a real `answer_from_documents` task as source `[1]`; job logs: two `document.scan` successes, one `document.ingest`; zero error-level lines; clamd's own log showed the `INSTREAM ... FOUND`.
- 163 tests now pass across 33 files.

**Two real findings from verification, neither visible by reading the code.** (1) The test harness had never ensured the new `document.scan` queue — pg-boss's `send()` to a never-created queue throws — so the first scanner-configured route test 500'd where the live run (whose composition root ensures it) succeeded; fixed in `test-app.ts` with a comment that the list must mirror `index.ts`. (2) ClamAV suffixes signatures from a custom database with `.UNOFFICIAL`, so a real clamd names the sample `Eicar-Test-Signature.UNOFFICIAL`; the assertions now check the signature's identity, not ClamAV's naming convention — the official database will name it differently again. Also found: Windows keeps clamd's log/pid files locked briefly after `kill()`, so the test's cleanup awaits the real exit event and retries.

**Honestly unverified:** only an EICAR-only custom database and a locally-spawned `clamd` have been exercised — never the official signature set (detection quality is ClamAV's, but it has never been watched here), never the `clamav/clamav:1.5` sidecar on Cloud Run (its 3 GiB limit is from ClamAV's documentation, not a measurement; its cold start vs. `document.scan`'s backoff is designed, not observed; freshclam egress is assumed). The runbook's verify step uploads a real EICAR sample on the first deploy. Malware scanning applies to uploads only — the dev-only sandbox-path route is operator-placed files and unscanned, and the coding agent's scratch directory is unchanged.

**Alternatives considered:** A separate quarantine bucket + promotion — rejected per the containment reasoning above. `clamscan` per upload in the request path — rejected: tens of seconds per file from database reload, and it would couple upload latency to the scanner. A managed third-party scanning API (e.g. VirusTotal) — rejected: it sends users' documents to a third party. A separate Cloud Run service for clamd — rejected: services can't expose raw TCP; the sidecar is what Cloud Run's multi-container support is for. An npm clamd client — rejected per the dependency reasoning above. Fail-closed as the *local* default — rejected: it would make the zero-config dev loop (README's headline promise: no Docker, no keys) require a 200 MB ClamAV install; the fail-open state is durably recorded and loudly logged instead, and the deployed posture is fail-closed.

**Date:** 2026-09-03
**Impact:** New `packages/scanning` (`MalwareScanner`, `ClamAvScanner`, `parseInstreamReply`, tests); `packages/rag/src/scan.ts` (`processDocumentScan`, tests); `documents.scan_status` + `status` enum (`scanning`/`rejected`, migration `0005`), `document-repository.ts` (`updateScan`, `clearAsset`, `findByAssetId`), `asset-repository.ts` (`delete`); `AssetStore.delete()` on both stores; `packages/shared` (`ServiceUnavailableError`); `apps/api/src/{config,context,index}.ts` (`CLAMD_HOST`/`CLAMD_PORT`/`UPLOAD_SCAN_REQUIRED`, scanner construction + boot ping, `document.scan` queue/worker), `routes/v1/rag.ts` (scan/fail-open/fail-closed branch), `images.ts` (serve-gate), `test-app.ts` (queue list), 3 new route tests; `apps/web` (status badge, `scanStatus` display); `infrastructure/terraform/main.tf` (clamd sidecar, `CLAMD_HOST` on both units, `UPLOAD_SCAN_REQUIRED` on the API, quarantine bucket removed); `.github/workflows/ci.yml` (ClamAV install step). 163 tests now pass across 33 files (up from 149/31).

---

## ADR-043: `.env` file loading via Node's own loader — so a real API key can be supplied by dropping it in a gitignored file, not by exporting it in every shell

**Decision:** `apps/api` now loads `.env` files at the top of `loadConfig()` using Node 20.6+'s built-in `process.loadEnvFile` — no `dotenv` dependency. Two locations are read, in order: `apps/api/.env`, then the repo-root `.env` that `.env.example` has always told the reader to copy. Both are resolved **relative to the compiled module's own URL**, not `process.cwd()`, because the working directory legitimately differs between `npm run dev -w @ai-platform/api` (repo root), `node dist/index.js` in the container (`/app/apps/api`), and the test runner — and `../.env` / `../../../.env` resolve identically from `src/` and from `dist/`. The paths loaded are logged (`Loaded environment from: …`), never the values.

**Why this was a real gap, not a convenience.** Every key-shaped variable the platform supports — `ANTHROPIC_API_KEY`, `DATABASE_URL`, `CLAMD_HOST`, the quota limits — could only ever be supplied by exporting it in the exact shell that launched the process. `.env.example` existed and `.gitignore` had ignored `.env` since Phase 0, so the repository *documented* a file that nothing read: a reader copying `.env.example` to `.env`, filling in a key, and starting the server would have seen the mock provider still answering and no explanation. That is a divergence between docs and behaviour of exactly the kind ADR-038's audit was written to catch. It also blocks the one thing Phase 2 has never been able to verify (a real provider's success path), because the only alternative — pasting a key into a shell command, or into a chat with an agent — is the wrong way to handle a secret.

**Node's loader rather than `dotenv`.** `dotenv` is 2 KB and universally used, but this needs nothing it adds: no variable expansion, no multi-file merge semantics, no override mode. Node has shipped the parser since 20.6 and this project already requires Node 24 (`packages/*` use `node:` builtins throughout). The decisive property is one the built-in loader has and `dotenv`'s `override: true` mode would break: **an already-set environment variable is never replaced by a file value.** So a container's injected secrets, a Cloud Run secret binding, and a `DATABASE_URL=… npm run …` prefix all still win over a stray `.env` left in an image — the file is a fallback, never an override. That property is *tested against the real loader* rather than trusted from the docs.

**Never under `NODE_ENV=test`.** `loadDotEnvFiles` returns immediately when the environment is `test`. A developer's `.env` with a real `DATABASE_URL` or a real `ANTHROPIC_API_KEY` in it must not be able to point the test suite at a real database or spend real money the moment someone runs `npm test`; the suite's own fixtures are the only configuration it may see. This is also why loading happens inside `loadConfig()` (which tests never call — they build the app through `test-app.ts`) rather than as a module-level side effect.

**Verified for real:**
- 3 tests (`apps/api/src/config.test.ts`) exercising the two properties the design rests on against the **real** `process.loadEnvFile`, not a mock: `loadDotEnvFiles("test")` loads nothing, a variable already present in the environment survives a file that sets it to something else, and a variable that is absent is set from the file.
- **Live, three boots of the real server**: with `apps/api/.env` containing `PORT=8799`, the boot logged `Loaded environment from: …\apps\api\.env` and `GET http://127.0.0.1:8799/api/health` returned `200 {"status":"ok"}` while the 8787 default answered nothing — a value that existed nowhere but that file changed real runtime behaviour. With the file deleted, the same command logged no load line and bound 8787 again. (`git status` confirmed the temporary file was invisible to git throughout, and it was removed afterwards.)
- The full `apps/api` suite (36 tests) still passes, which is the check that the new call in `loadConfig()` is genuinely inert under `NODE_ENV=test`.

**`.env.example` rewritten to match reality.** It had drifted to six variables while the schema grew to twenty-four; it now documents every one — `ROLE`, `DATABASE_URL`, `ASSETS_ROOT`/`ASSETS_BUCKET`/`GCS_API_ENDPOINT`, `CLAMD_HOST`/`CLAMD_PORT`/`UPLOAD_SCAN_REQUIRED`, `FFMPEG_PATH`, the four quota limits — grouped by subsystem, each pointing at the ADR that introduced it, with the ones that must stay unset locally (`ROLE`, `GCS_API_ENDPOINT`) saying so.

**Honestly unverified:** no real provider key has been supplied yet, so this ADR delivers the *mechanism* by which one can be — the real-key end-to-end check (a real chat completion, real token counts, a real non-`null` `estimatedCostUsd` in `GET /api/v1/usage`) remains Phase 2's open item, now one file away instead of blocked. Node's parser handles `KEY=value`, quoted values, `#` comments and blank lines; exotic `.env` dialect features (multi-line values without quotes, `${VAR}` expansion, `export ` prefixes) are not supported and are not worth a dependency.

**Alternatives considered:** `dotenv` — rejected above (a dependency for a built-in, and its override mode is the wrong default for a container). `node --env-file=.env` in the npm scripts — rejected: it is a *hard error* if the file is absent (Node 24 has `--env-file-if-exists`, but the flag lives in `package.json`, so the container's `node dist/index.js` entrypoint and any direct invocation get nothing, and the docker/Cloud Run paths would silently differ from dev). Loading in `index.ts` before importing config — rejected: `loadConfig()` is the documented single point of environment loading (docs/17), and splitting it would leave a second place to forget. Searching upward for the nearest `.env` — rejected as too magical: two explicit, documented locations are easier to reason about than a search that can pick up a file from outside the repository.

**Date:** 2026-09-03
**Impact:** `apps/api/src/config.ts` (`loadDotEnvFiles`, called at the top of `loadConfig()`); `apps/api/src/config.test.ts` (new, 3 tests); `.env.example` rewritten to cover all 24 variables; `README.md` (how to supply a key). 166 tests now pass across 34 files (up from 163/33).

---

## ADR-044: A provider fallback must be structurally visible — found by dry-running the real-key verification before the key existed

**Decision:** `ModelRouter.streamChat` now reports every skipped provider to its caller through an `onFallback` hook — per call (so it can carry a request id) or per router instance — instead of only writing a `console.warn`. `apps/api` logs each fallback as a real structured WARN (`provider`, `stage`, `error`, `status: "fallback"`), and the chat route's `provider call completed` line and `gen_ai.chat` span now carry `fell_back_from`. The mock provider's canned text no longer claims that no real provider is configured.

**How this was found.** ADR-043 made it possible to supply a real key by file, so before asking for one, the verification itself was dry-run with a deliberately **invalid** Google key — the point being to prove the harness, not the key. It failed in a way more interesting than the harness bug it was looking for. The real Gemini call was made, really rejected with a `400 API_KEY_INVALID`, and ADR-024's fallback quietly served a mock answer — and the *only structured record of that request* read:

```
{"level":30,...,"provider":"mock","model":"mock-1","tokens_input":19,"tokens_output":58,"status":"success","msg":"provider call completed"}
```

Zero WARN lines, zero ERROR lines, `status: "success"`. The failure existed only as a `console.warn` on stderr — unstructured text that Cloud Logging would scatter across several unparsed lines. So the two outcomes the user's first real key is meant to distinguish — *"the key works"* and *"the key failed and the mock covered for it"* — were indistinguishable in the JSON logs. That is precisely the failure mode that would have made a "successful" first verification meaningless.

**docs/20 had already required this.** Its §3.3 says the provider-call span must record "critically — which fallback provider (if any) was used, so a trace shows the full retry/fallback path rather than just the call that eventually succeeded." The design doc was right and the implementation had never satisfied it; nothing failed, so nothing surfaced it. Same class of defect as ADR-043's unread `.env` — a documented behaviour the code did not have — which is why both are recorded in `docs/FINAL_AUDIT.md` rather than treated as tidy-ups.

**Why a hook rather than a logger dependency.** `packages/model-router` depends only on `@ai-platform/shared` and `@ai-platform/llm-mock`; wiring the app's Pino logger into it would invert that and make the package untestable without an app. The hook keeps the router a pure library, lets the *chat route* attach the request id that makes a fallback correlatable with the request that caused it, and lets the composition root cover every other caller (today the agent engine's `model_call` nodes) with an instance-wide hook. `console.warn` survives as the default when no hook is supplied, so the library's standalone behaviour is unchanged.

**The mock's message was actively misleading.** It read `[mock response — no real LLM provider is configured] … Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY to talk to a real model instead.` — a sentence that is false in exactly the case where a user most needs the truth: a configured key whose provider call failed. Someone with a valid but rate-limited key would have been told their key was missing. It now says no real model produced the answer (true in both cases) and names the log line that distinguishes them.

**Verified for real:**
- 2 new router tests: a per-call hook receives each skipped provider with the correct `stage` (`no_first_event` for a throw, `error_event` for an error first event) and message, in order, while the surviving provider still serves the request; an instance-wide hook is used when a call supplies none, and a clean call reports nothing at all.
- **Live, the same dry run repeated after the fix**: the invalid key now produces two structured WARN lines naming `provider: "google"`, `stage: "no_first_event"` and the real `API_KEY_INVALID` message — one carrying `request_id: "req-3"` (the chat route's per-call hook), one without (the agent engine's instance hook, a genuinely different caller) — and the completed-call line reads `"fell_back_from":["google"]`. The API key's value appears nowhere in the log, checked explicitly.
- 168 tests now pass across 34 files.

**Also fixed while dry-running the harness** (harness-side, not product): the verification script compared task status case-sensitively against the API's lower-case value, and accepted `estimatedCostUsdThisMonth: 0` as a pass — correct for the unpriced mock, but it would have silently passed a *real* provider whose model has no pricing entry, which is exactly the check that matters.

**Honestly unverified:** no real, valid key has been used yet — the success path (a real provider serving a request with `fell_back_from: []`) is still unproven and remains the one open Phase 2 item. The fallback path is now proven in both directions: it fires, and it is visible.

**Alternatives considered:** Adding `fellBackFrom` to the SSE `done` event — rejected for now: it changes a client-facing contract for something no UI consumes yet, and the `provider` field already tells a client which provider answered. Making the router log directly through `packages/observability` — rejected per the dependency reasoning above. Failing the request outright instead of falling back — that is ADR-024's decision, not this one's to revisit; the complaint here was never that fallback happens, only that it happened silently.

**Date:** 2026-09-03
**Impact:** `packages/model-router/src/router.ts` (`ProviderFallback`, `StreamChatOptions`, per-call and instance hooks; `console.warn` only as the default) + 2 tests; `apps/api/src/index.ts` (instance hook to a structured WARN), `routes/v1/chat.ts` (per-call hook with `request_id`, `fell_back_from` on the completed-call log and the `gen_ai.chat` span); `packages/providers/llm-mock/src/index.ts` (honest wording); `docs/20_OBSERVABILITY.md` field table. 168 tests now pass across 34 files (up from 166/34).

---

## ADR-045: Six defects on the real-key path, found by auditing it before the key arrived — including a production boot that could never have succeeded

**Decision:** Before handing a real Google Gemini key to code that had never served a successful real call, the whole path was audited by independent readers (registration, HTTP shape, token/cost accounting, fallback masking, quota) and every finding put through adversarial verification. Twenty-five candidate findings; three survived verification as blockers, and reading the code settled three more. All six are fixed here.

### 1. A blank `GOOGLE_API_KEY=` line silently shadowed a real key set under the documented alias

`apps/api/src/index.ts` resolved the key with `config.GOOGLE_API_KEY ?? config.GEMINI_API_KEY`. `??` falls through only on null/undefined — never on `""`. And the empty string is exactly what the documented workflow produces: `.env.example` shipped `GOOGLE_API_KEY=` with no value, the reader copies the file, fills in the one line they care about, and leaves the rest. A user following ADR-043's brand-new instructions and using the `GEMINI_API_KEY` alias (which docs/28 and `.env.example` both advertise) would have had their real key silently discarded, watched the mock answer, and had nothing anywhere to tell them why. **The file that made this reachable was written one commit earlier, in ADR-043.**

Fixed at the schema, not the call site, so it covers every optional string variable: an empty or whitespace-only value now parses as *unset*, and values are trimmed (a key pasted with a trailing space is a real and otherwise baffling authentication failure). `index.ts` also uses `||` now, stating the intent where the bug lived, and `.env.example` comments its key lines out rather than shipping them blank.

### 2. The production container could never boot — with or without a valid key

ADR-013 says a mock provider must never serve production traffic, and implements it as a throw in each mock provider's constructor. But the composition root constructed `MockLLMProvider`, `MockImageProvider` and `MockVideoProvider` *unconditionally*, and `apps/api/Dockerfile` sets `ENV NODE_ENV=production`. Every image ever built would have died during boot, holding a perfectly valid API key. Nothing caught it because no image has ever been built or run (ADR-037) — the Dockerfile was reviewed, never executed.

The rule is kept and the enforcement fixed. In production the LLM mock is simply never constructed; if no real provider key is present the process exits with a message naming the three variables that would fix it, which is ADR-013's actual intent. Image and video are harder, because they are mock-**only** (ADR-009) — there is no real provider to fall back to. Refusing to boot would let one mocked feature block the entire deployment, so instead the capability is *absent*: no provider, no workers registered, and `POST /api/v1/images` / `POST /api/v1/videos` answer a real `503` naming the reason rather than queueing work no worker would ever pick up (which would have left a caller polling `pending` forever).

### 3. The SSE parser accepted only one of the three separators the specification allows

`parseSseStream` framed on `"\n\n"` alone. The SSE spec permits `\r\n\r\n`, `\n\n` and `\r\r`, and Google's own JS client matches all three for the very endpoint `packages/providers/llm-google` calls. Against a CRLF-framed stream this parser matches nothing: the entire response body accumulates into one trailing blob, `JSON.parse` fails on it, and the caller gets a flawless-looking HTTP 200 with zero tokens and an empty answer. **Honest about the premise:** whether Google actually emits CRLF on this endpoint could not be established from the outside — one verifier upheld the finding, another refuted it precisely because that premise is unproven. What is *not* in question is that the parser was non-compliant with the specification it implements, that the failure would be silent, and that the fix is seven lines. Frame boundaries and data-line splitting now accept all three forms, and the separator's own length is consumed rather than a hard-coded 2.

### 4. Three ways a Gemini call could fail and be recorded as a success

A safety block (`promptFeedback.blockReason`), an early stop with no text (`finishReason: MAX_TOKENS`), and an unparseable frame all ended the same way: a `done` event with empty content, attributed to `google`, logged `status: "success"`, with a 0-token usage row. The adapter now throws a `ProviderError` naming which of the three happened — which, since ADR-044, means the router falls back *visibly* instead of recording a phantom successful call. It also reads `thoughtsTokenCount`: thinking tokens are billed as output but reported separately, so counting only `candidatesTokenCount` under-reported usage, cost and quota on every reasoning-capable model.

### 5. Missing telemetry was priced as a real $0.00

`estimateLlmCostUsd` returned `0` for all-zero usage on a priced model. A real call always consumes tokens, so all-zero usage means the telemetry was missing, not that the call was free — and a confident "priced, $0.00" row is exactly the fabricated figure the rest of that module refuses to produce. It returns `null` now, which `pricedCallsOnly` on `GET /api/v1/usage` already exists to surface. **This deliberately changed an existing passing test** (`.toBe(0)` → `.toBeNull()`); the change is recorded in the test itself, not silently.

### 6. Nothing said which providers registered, and `packages/shared` ran no tests

A reader who dropped a key into `.env` had no way to confirm it took effect short of sending a chat and inferring from the prose — the exact ambiguity that hid defect 1. Boot now logs the registered providers, the default, and whether any real provider is configured. Separately, `packages/shared` — which owns the SSE parser above — had no `test` script at all, so `npm test` skipped it entirely; adding one revealed its `tsconfig.json` also lacked the `exclude: ["src/**/*.test.ts"]` every sibling package has, so compiled test copies in `dist/` were being collected and run twice. Both fixed.

**Verified for real:**
- 19 new tests (187 total across 35 files, up from 168/34): 7 for the SSE parser across every separator form including mixed and trailing-`\r` cases; 5 for the Gemini adapter's failure modes (thinking tokens counted, safety block / early stop / unparseable frame each throwing with the reason named, and a CRLF-framed stream parsed correctly end to end); 3 for empty-and-whitespace environment values including the exact alias-shadowing scenario; 2 for the cost estimator's null; 2 route tests for the media 503, one asserting nothing was persisted.
- **Live, the alias fix**: booting with `GOOGLE_API_KEY=` blank and `GEMINI_API_KEY` set logs `"providers":["google","mock"],"default":"google","real_provider_configured":true`.
- **Live, the production fix, against `node dist/index.js` with `NODE_ENV=production` — the container's exact entrypoint**: it boots (it could not before), `/api/health` returns 200, `GET /api/v1/files` returns real data, the boot log shows `"providers":["google"]` with no mock and the capitalised image/video-disabled warning, and both media routes return a real 503 naming the reason. With no key at all it exits 1 with ADR-013's message, so the rule still holds.

**Honestly unverified:** still no valid key, so the success path remains unproven — that is unchanged and is the point of the exercise. The Docker image itself has still never been built; running the built entrypoint with `NODE_ENV=production` is the closest available proxy and it is what caught this, but a real `docker build` could still surface something else. The `gemini-3.5-flash` model id remains hard-coded and unvalidated: the audit explicitly declined to call it stale without evidence, and the verification script now lists the key's actually-available models if the first call fails.

**Findings raised but NOT fixed here, recorded rather than quietly dropped:** agent-task model calls (`packages/agent-core`) go through the same real provider but record no usage and check no quota — a real spend hole once a key exists, now a tracked row in `docs/27_RISKS_AND_LIMITATIONS.md` and its own next increment. A stream that fails *after* the first token records no usage row despite being billed. A failed usage-record write surfaces to the client as a provider failure after a successful answer was already sent. These are real; they are also each a separate change, and bundling them here would have made this ADR unreviewable.

**Alternatives considered:** Fixing defect 1 only at the call site (`||`) — rejected as a fix for one line of a whole class; the schema is where "empty means unset" belongs. Refusing to boot in production when image/video are unavailable — rejected: one mocked feature would block every deployment of the six that work. Making the SSE parser tolerant by stripping all `\r` before parsing — rejected: it would corrupt a `\r` legitimately inside a data payload. Adding a real image/video provider to unblock production — out of scope and a spend decision (ADR-009/ADR-011), not an engineering one.

**Date:** 2026-09-03
**Impact:** `apps/api/src/config.ts` (`optionalString`, applied to 10 variables) + 3 tests; `apps/api/src/index.ts` (`||` alias, ADR-013 enforcement for the LLM mock, `mediaGenerationAvailable` gating the media providers and their workers, provider-registration boot log); `apps/api/src/context.ts`, `test-app.ts`, `routes/v1/images.ts` (`MEDIA_UNAVAILABLE`, 503 guard), `routes/v1/videos.ts` (503 guard) + 2 tests; `packages/shared/src/sse.ts` (spec-compliant separators) + 7 tests, `package.json` (a `test` script at last), `tsconfig.json` (exclude tests from the build); `packages/providers/llm-google/src/index.ts` (thinking tokens, blocked/empty/unparseable now throw with the reason) + 5 tests; `packages/model-router/src/cost-estimator.ts` (null for zero usage) + 2 tests and one deliberately changed expectation; `.env.example` (key lines commented, not blank). 187 tests now pass across 35 files (up from 168/34).

---

## ADR-046: Agent-task model calls are metered too — closing the spend hole ADR-045's audit found, before a real key makes it live

**Decision:** `AgentEngine` takes an optional `ModelCallMeter` — `checkTokens(estimated)` before a `model_call` node runs, `record(realUsage)` after it — and `apps/api` wires it to the same `QuotaManager` and `usage_records` ledger that `POST /api/v1/chat` has always used. A refused call fails the node with the quota's own reason rather than throwing past the state machine, so the refusal lands in the node's `errorMessage` and the append-only transition log like any other node failure.

**The hole.** FR-061 and FR-063 are written about LLM calls, not about chat calls — but only the chat route implemented them. The engine's `model_call` nodes went through the *same* `ModelRouter` and the same real provider, checked no quota, and recorded nothing: `runModelToCompletion` read the `done` event's `provider` and `model` and discarded its `usage` outright. So `GET /api/v1/usage` under-reported by exactly the agent system's share, and `DAILY_TOKEN_LIMIT` bounded only half the ways this platform can spend money. It was invisible for as long as every provider was a mock and the numbers were fictional anyway. ADR-043 changed that: a real key is now one file away, and the roadmap's own next step is to run agent tasks against it.

**Why fix it before the key rather than after.** A quota that silently doesn't apply is worse than no quota, because the operator believes they are protected. The person about to supply the key is the same person who set the limits; discovering afterwards that agent tasks ignored them is a bill, not a bug report. This is the same reasoning as ADR-044 and ADR-045 — verify the path before trusting it with something real — and it is why this was split out of ADR-045 instead of being bundled into it: it is a behaviour change to the agent engine, not a defect fix, and it deserved its own tests and its own live proof.

**A structural interface, not a dependency.** `packages/agent-core` does not import `@ai-platform/quota` or a concrete repository; `ModelCallMeter` is two methods it defines itself. The engine stays testable against a scripted double, the composition root remains the only place that knows how quota and the ledger are actually constructed, and an embedder without a ledger simply omits the meter (which is also why every pre-existing engine test kept passing untouched).

**A refusal is a node failure, not an exception.** The chat route answers a refused request with a `429 QUOTA_EXCEEDED`; a task node has no HTTP response to fail, and the engine already has a first-class notion of a node that could not run. Routing the refusal through `handleNodeFailure` means the reason is persisted on the node, appended to `task_transitions`, and visible in `GET /api/v1/agent/tasks/:id` — an operator can see precisely which node was refused and why, rather than finding a task that stopped for no stated reason.

**Verified for real:**
- 2 new engine tests (18 in `packages/agent-core`, 189 total across 35 files): a completed task checks quota exactly once with a positive estimate and records exactly one entry carrying the provider's *real* token counts, the task id, and a node id that genuinely exists in that task's graph; a refused task records **nothing at all**, fails the node, and puts the quota's own message in `errorMessage`.
- **Live, both directions.** With no limits configured: `GET /api/v1/usage` went `tokensToday: 0` → `87` from a single `echo_chat` task, with a structured `provider call completed` line carrying `task_id`, `node_id`, `provider`, `model` and the real counts — none of which existed before. With `DAILY_TOKEN_LIMIT=1`: the same task reached `failed`, its `errorMessage` read `Daily token limit of 1 would be exceeded (0 used so far today).`, and `tokensToday` stayed `0` — the call was refused before it happened, not billed and then complained about.

**Honestly unverified / still open:** the meter is exercised against the mock provider only, like everything else awaiting a real key — but it reads whatever the `done` event reports, so a real provider's counts flow through the same path (and ADR-045 made those counts correct for Gemini's thinking tokens). Two related gaps from ADR-045's audit remain open and are still tracked in `docs/27_RISKS_AND_LIMITATIONS.md`: a stream that fails *after* its first token records no usage despite being billed (true of both the chat route and the engine), and a failed usage-record write surfaces to the client as a provider failure after the answer was already sent. Neither is this ADR's scope; both are real.

**Alternatives considered:** Metering inside `ModelRouter` so every caller is covered automatically — attractive, and rejected: the router is a pure library with two dependencies, quota is an application policy, and a router that silently refuses calls would be a surprising thing for a library to do. Throwing a `QuotaExceededError` out of the engine — rejected: it would surface as an unhandled engine error rather than as a task the operator can inspect. Recording usage but not enforcing quota on agent tasks — rejected as half a fix; visibility without a bound is exactly what made the hole hard to notice. Estimating tokens post-hoc when a provider omits usage — rejected: ADR-045 just finished removing fabricated figures from this ledger.

**Date:** 2026-09-03
**Impact:** `packages/agent-core/src/engine.ts` (`ModelCallMeter`, optional `meter` dep, pre-call check and post-call record on `model_call`, `runModelToCompletion` now returns the usage it used to discard) + 2 tests; `apps/api/src/index.ts` (meter wired to the real `QuotaManager` and `PgUsageRecordRepository`, with a structured `provider call completed` line carrying task and node ids). 189 tests now pass across 35 files (up from 187/35).

---

## ADR-047: Tool calling in the provider contract — the change that makes a model-driven agent possible

**Decision:** `ChatMessage` gained `toolCalls`/`toolCallId`, `ChatStreamEvent` gained a `tool_call` variant and a required `finishReason` on `done`, `ChatRequest` gained `tools`/`toolChoice`/`maxOutputTokens`/`temperature`, and `LLMProvider` gained `model` and `capabilities()`. Every adapter — Anthropic, OpenAI, Google, the self-hosted runtime, and the mock — implements real tool calling in its own idiom.

**Why this is the root change.** The ADR-047 audit's sharpest finding was that the model was never given tools at all: a repo-wide grep for `tool` across `packages/providers` returned nothing. Tools existed, and a deterministic planner invoked them, but no model ever chose one. Every downstream claim about autonomy rested on that gap. Adding tool calling to the *contract* rather than to one adapter is what lets the agent loop be provider-neutral: the loop emits `ToolSpec`s and consumes `tool_call` events, and which vendor produced them is not its concern.

`finishReason` is required, not optional, for the same reason ADR-045 made an empty answer an error: `length` (truncated) and `tool_calls` (the model wants to act) are not the same outcome as `stop`, and a contract that lets an adapter omit the distinction guarantees some adapter will.

**Date:** 2026-09-05
**Impact:** `packages/shared/src/chat.ts` rewritten; all five provider adapters; `packages/model-router`; `packages/agent-core`.

---

## ADR-048: Real semantic embeddings, with width normalization and model tagging

**Decision:** `EmbeddingProvider` moved into `packages/shared`; a new `EmbeddingService` wraps any provider, zero-pads its output to the column's 1536 width, and exposes a `modelTag`. Every stored vector records `embedding_model` and `embedding_dims`, retrieval filters on the model tag, and both vector columns gained an HNSW index.

**Three defects this closes, all from the audit.** (1) Retrieval was lexical feature-hashing presented as semantic search. (2) There was no ANN index anywhere, so every query was a sequential scan of every chunk in the database. (3) Nothing prevented comparing vectors produced by two different models, which is meaningless.

**Why zero-padding rather than a per-model column.** Providers output 384, 768, 1536 or 3072 dimensions. Padding with zeros is *exact* for cosine similarity — it changes neither the dot product nor either norm — so one column serves every model without distorting distances within a model. A vector wider than the column is a hard error, never a truncation, because truncating would silently distort every distance. The model tag is what stops cross-model comparison: switching models makes old rows invisible until re-embedded, rather than corrupting results.

The deterministic hash provider remains as an explicit, `isDeterministicFallback`-marked zero-configuration default, and the API reports which mode is active rather than implying semantic search it is not doing. A real defect in it was also fixed: bucket and sign were derived from the same hash, so with a power-of-two dimension the signed-hashing trick delivered none of its intended benefit.

**Date:** 2026-09-05
**Impact:** `packages/embeddings`, `packages/rag`, `packages/database` schema, `packages/providers/llm-local`.

---

## ADR-049: Identity, tenancy and authorization — enforced in SQL, not after the fetch

**Decision:** A full identity model (`users`, `organizations`, `organization_members`, `projects`, `project_members`, `sessions`, `api_keys`, `audit_log`) and a `packages/security` that owns every authentication and authorization decision. **Every row of user content now carries `project_id`, and every read filters on it in the SQL `WHERE`.**

**The rule that matters.** Authorization is applied as a query predicate, never as a check on a row that has already been fetched. There is deliberately no `documents.get(id)` left to call — the signature is `get(projectId, id)` — so the ownership check a route might forget cannot be forgotten. A resource in another project is reported exactly like one that does not exist.

**A project the caller cannot see is a 404, not a 403.** Telling an outsider that a project id exists is itself a disclosure.

**Sessions and API keys store only a SHA-256.** A database dump cannot be replayed as live credentials. Passwords use scrypt from Node's own crypto (memory-hard, RFC 7914, no native addon) with the cost parameters encoded in the hash so they can be raised later without invalidating anything. Login returns one error for both a wrong password and an unknown email, and does comparable work in both cases, so the endpoint is not a user-enumeration oracle.

**Date:** 2026-09-05
**Impact:** New `packages/security`; `packages/shared/src/auth.ts`; the entire database schema; every repository; every route; `apps/web`.

**Amended (2026-09-13):** The 404 rule does not hold for every credential: an API key that names a project other than its own gets 403 from `requireProject` ("This API key cannot act on a different project"), which discloses nothing because every other id is refused whether it exists or not. The API document's "404, never 403" convention was corrected to say so (ADR-112); the code did not change.

---

## ADR-055: Execution isolation — a timeout that kills, and an environment that does not leak

**Decision:** A pluggable `ExecutionSandbox` with two implementations. `DockerSandbox` (the production posture) runs each command in a container with `--network none`, a read-only root, a tmpfs `/tmp`, `--cap-drop ALL`, `no-new-privileges`, a pid limit and memory/CPU caps. `ProcessSandbox` (development) shares the same API, scrubs the environment and genuinely terminates the process tree. Production refuses process isolation unless explicitly acknowledged — and only for a process that actually runs the agent engine.

**Two real vulnerabilities this fixes**, both found by the audit: the previous terminal tool spawned with no `env` option, so every command inherited the API process's entire environment — provider API keys, `DATABASE_URL`, everything; and its "timeout" only rejected a promise while the child kept running. Both are now asserted against by tests that run real processes.

**Date:** 2026-09-05
**Impact:** `packages/security/src/sandbox.ts` + 9 tests; `packages/tools`; `apps/api` composition root.

**Amended (2026-09-13):** No test constructed a `DockerSandbox` until ADR-111. Its argument list is now unit-tested through `dockerRunArgs`, and a real-container suite runs through `npm run test:docker`, which fails rather than skips without docker. That suite has never run, because this environment has no container runtime, so it is still unverified whether these flags contain a process.

---

## ADR-056: Provider independence through an OpenAI-compatible runtime

**Decision:** A `LocalOpenAICompatibleProvider` speaking `/v1/chat/completions` with streaming and tool calling, plus a matching embedding provider. When `LLM_BASE_URL`/`LLM_MODEL` are set it registers as the **default**, ahead of any hosted key.

**Why that wire format.** It is the de facto standard for self-hosted inference — Ollama, vLLM, llama.cpp's server, LM Studio and every OpenAI-compatible gateway implement it. One adapter therefore gives the platform a complete local AI runtime with no third-party account, and it is the *same code path* production uses, so there is no "local mode" that behaves differently.

Registering it as the default rather than a fallback is the architectural statement: independence from a vendor is only real if the independent path is the one that actually runs.

**Date:** 2026-09-05
**Impact:** New `packages/providers/llm-local` + 12 tests; `apps/api` config and composition root; `.env.example`.

---

## ADR-057: The model-driven agent loop

**Decision:** `runReasoningLoop` implements observe → reason → act → observe, where the **model** decides whether a tool is needed, which one, with what arguments, whether the result suffices, whether to call another, and when the task is done. The harness decides only what the model may not: the iteration ceiling, the token budget, which tools exist, whether a call needs approval, argument validity, isolation and cancellation.

**A tool error is an observation, not a termination.** Recovering from a failed call is exactly the reasoning worth having; only harness-level failures (budget, cancellation, provider outage) stop the run. One self-correction round runs when verification fails — one, because an unbounded correct-then-recheck cycle is how agents burn budget.

This replaces a deterministic `switch` over six hardcoded task types (ADR-018), which is retained for those task types but is no longer the only way work happens.

**Date:** 2026-09-05
**Impact:** `packages/agent-core/src/reasoning-loop.ts` + 18 tests.

---

## ADR-058: Capability-based routing, retry, backoff and circuit breaking

**Decision:** The registry became a real capability registry (tool calling, vision, context window, cost/quality/latency hints) and `select()` returns an ordered candidate list. The router gained per-provider retry with exponential backoff and full jitter, honours `Retry-After` as a floor, classifies errors as retryable or fatal, and opens a circuit after repeated failures.

**Also closed:** a provider that yielded nothing was skipped *without* calling `onFallback` — a real hole in ADR-044's "a fallback is never silent" claim. And a request carrying tools can now only be routed to a provider that can call them, rather than discovering that mid-stream.

**Date:** 2026-09-05
**Impact:** `packages/model-router` rewritten + 16 tests.

---

## ADR-059: The tool registry actually enforces what it declares

**Decision:** `ToolRegistry.call` validates arguments against the tool's `inputSchema` before the handler runs, all four `requiresApproval` modes have distinct behaviour, handlers receive a `ToolInvocationContext` carrying project/user scope and a cancellation signal, and re-registering a tool id is refused rather than silently replacing it.

**Why validation matters more now.** `inputSchema` was decorative — nothing checked arguments against it. That was tolerable when a deterministic planner supplied them; it is not when a *model* does. The validator is a deliberately small, dependency-free subset of JSON Schema so that a model's mistake produces a precise, actionable message.

**Date:** 2026-09-05
**Impact:** `packages/tools/src/registry.ts`, `packages/shared/src/tools.ts` + tests.

---

## ADR-060: The production boot blocker

**Decision:** The mock provider is never constructed in production; a process refuses to start for lack of a chat provider **only if it actually serves chat**; and the sandbox-isolation guard applies only to a process that runs the agent engine.

**What was broken.** `apps/api/Dockerfile` sets `NODE_ENV=production`; ADR-013's guard threw whenever no LLM key was present; and the Cloud Run worker pool deliberately has no LLM key. The worker pool therefore crash-looped on every boot, and in the configuration `terraform.tfvars.example` advertises (no key at all), so did the API. ADR-045 had fixed the API-with-a-key case and verified only that case — this is the regression that audit caught.

`scripts/verify-boot.sh` now exercises all five configurations against the real built entrypoint, so this class of defect fails loudly instead of silently.

**Date:** 2026-09-05
**Impact:** `apps/api/src/index.ts`; `scripts/verify-boot.sh`; `.github/workflows/ci.yml` (which now builds the image and asserts it starts).

---

## ADR-062: A real coding agent — unified diffs, search, and no directives

**Decision:** `code.parse_fix_directive`/`code.apply_literal_fix` are replaced by `code.apply_patch` (a real unified-diff applier), `code.read_lines`, `fs.search` and `fs.glob`.

**What was wrong.** The previous "coding agent" matched a `FIX_NEEDED path=… find=… replace=…` string that the failing test printed *about itself*, then performed one whitespace-free literal replacement. The fix was authored by the test, not the agent, and §37 of the product brief forbids calling that an autonomous coding agent. There was also no search capability at all, so FR-010 ("where is X defined?") was unmeetable.

**Why the patcher is hand-written.** Applying a patch is the most destructive thing this platform does to a user's files, and the failure that matters is silent: a hunk applied to *nearly* the right place. Owning the matching strategy makes it explicit and testable — exact match at the stated line, then a bounded search outward, then refusal. A multi-file patch is atomic: every file is patched in memory first and nothing is written unless every hunk applied.

**Date:** 2026-09-05
**Impact:** `packages/tools/src/native/{patch,search,coding}.ts` + 26 tests.

---

## ADR-063: Memory that actually reaches the model

**Decision:** A `MemoryService` owns the whole loop — store → embed → retrieve → rank → inject → record — and `POST /api/v1/chat` calls it before the model call, so retrieved memories arrive in the message array the provider receives.

**What was wrong.** Memory was a table with a repository and an HTTP endpoint. Nothing read from it on the chat path, so a fact the user stated was stored, was never recalled, and changed no answer. A memory subsystem that does not influence a response is a database, not memory. A second defect compounded it: `POST /api/v1/memory` wrote through the *repository*, so items arrived with no embedding and were permanently unrecallable.

**The threshold had to be derived, not guessed.** Cosine distances differ by embedder. Measured empirically against the deterministic lexical fallback: relevant pairs land at 0.67–0.80 and irrelevant ones at 1.00, so a threshold tuned for a real embedding model (0.55) retrieved nothing at all locally. `maxDistance` now derives from `embeddings.isDeterministicFallback` rather than being a constant that is right in one deployment and silently wrong in the other.

**Thread containment.** Conversation- and task-scoped memories must not leak across threads. `threadScopePredicate` admits a scoped item only when its `subject_id` is one of the current conversation/task ids, in SQL — not by filtering after the fact.

**Date:** 2026-09-05
**Impact:** `packages/memory/*`, `packages/database/src/repositories/memory-item-repository.ts`, `apps/api/src/routes/v1/{chat,rag}.ts`.

---

## ADR-064: One agent path, not two

**Decision:** The deterministic planner and the model-driven loop become a single execution path: the planner emits a `reasoning` node for the `autonomous` task type, and the engine executes it through the same node lifecycle as every other kind.

**What was wrong.** Two independent implementations of "run an agent" existed — one through the task graph, one through `runReasoningLoop` — with separate approval handling, separate cancellation and separate limits. Two paths means one of them is always the less-tested one, while the properties that matter (a human can approve, a run can be cancelled, ceilings hold) have to be true on both.

**Approval resume had to act, not re-ask.** On resume the engine now executes the approved call and appends its tool message *before* re-prompting; previously it re-prompted with no record that the approved action had happened, so the model was asked to decide the same thing again.

**Date:** 2026-09-05
**Impact:** `packages/agent-core/src/{engine,reasoning-loop,planner}.ts`, `packages/shared/src/task-graph.ts`.

---

## ADR-065: Image and video are separate capabilities

**Decision:** `imageGenerationAvailable` and `videoGenerationAvailable` are independent flags, and a real OpenAI-compatible image provider (`/v1/images/generations`) exists alongside the mock.

**Why not one flag.** A deployment can have a real image server and no video one. Reporting both through a single flag either disables something that works or advertises something that does not — and the second is the failure the honesty rule forbids.

**Date:** 2026-09-05
**Impact:** `packages/providers/image-openai/*`, `apps/api/src/{context,index}.ts`, `apps/api/src/routes/v1/{images,videos}.ts`.

---

## ADR-066: Platform introspection routes

**Decision:** `/api/v1/{models,providers,tools,mcp,jobs,admin/*}` report what is really configured, including explicit `available: false` and `isMock: true` states.

**Why.** With a provider-neutral runtime (ADR-056), "which model am I actually talking to, and is it real?" is a question an operator must be able to answer without reading boot logs. An unconfigured capability is reported as unconfigured rather than omitted: a missing row looks like a bug, an explicit `false` looks like a decision, and only one of those is actionable.

The `/admin` endpoints answer **404** to a non-administrator rather than 403 — confirming an endpoint exists is itself a disclosure (ADR-049).

**Date:** 2026-09-05
**Impact:** `apps/api/src/routes/v1/platform.ts`.

---

## ADR-067: A real MCP lifecycle

**Decision:** `McpManager` owns every MCP subprocess's lifetime, with `startAll`/`status`/`reconnect`/`disconnect`/`stopAll`/`checkHealth`, and `parseMcpServerConfigs` skips a malformed entry instead of failing the boot.

**What was wrong.** The previous integration assigned its connection to a local and dropped it, leaking the child process. And a single bad entry in `MCP_SERVERS` took the whole platform down — MCP is optional, and an optional integration must never be able to stop a boot.

**Date:** 2026-09-05
**Impact:** `packages/mcp/src/manager.ts`, `apps/api/src/index.ts`.

---

## ADR-068: The frontend gets tested, and E2E finds three real bugs

**Decision:** `apps/web` gets Vitest + Testing Library for units and Playwright for end-to-end tests against the real API and a real database, both wired into CI.

**Why it mattered.** `apps/web` had no test script at all, so it was invisible to `npm test` and every claim about the UI rested on a manual browser session recorded in prose.

**What the suite found on its first runs** — which is the argument for having written it:

1. `app/lib/api.ts` — all 24 REST functions — called `fetch` directly with no credentials, no CSRF header and no project scope. Fine when the API had no auth; broken the moment it did. Signup succeeded and the very next call was refused, bouncing the user back to sign-in.
2. After a successful signup or login the client-side session state was still "anonymous" — the provider had resolved it when the page mounted — so the redirect effect bounced the user straight back to `/login`.
3. `SameSite=Lax` on the session cookie (see ADR-070).

Also fixed on the way: the client SSE parser framed on `\n\n` only (the same defect ADR-045 fixed server-side, never applied to the client — a CRLF response rendered a permanently empty answer), swallowed the API's error body, and had an unguarded `JSON.parse` that turned one malformed frame into an unhandled rejection.

**Date:** 2026-09-05
**Impact:** `apps/web/{vitest.config.ts,playwright.config.ts,e2e/*,app/lib/*}`, `.github/workflows/ci.yml`.

---

## ADR-069: The ffmpeg branch, executed for real

**Decision:** An integration test runs a real ffmpeg end to end and asserts ffmpeg can decode the result back — and it probes the binary's **capabilities**, not its presence.

**Why capability-probing.** The ffmpeg cached on the authoring machine is Playwright's screencast build (`--disable-everything`), which runs and reports a version and then cannot open a GIF or encode H.264. A presence check would have failed these tests against perfectly correct render code. The probe requires a gif demuxer, libx264 and the mp4 muxer; CI installs a general-purpose build so the branch is genuinely covered, and locally the suite skips loudly.

Round-tripping through the decoder is what distinguishes "wrote bytes" from "wrote a valid video".

**Date:** 2026-09-05
**Impact:** `packages/media/src/video-render.integration.test.ts`, `.github/workflows/ci.yml`.

---

## ADR-070: SameSite derived from Secure

**Decision:** The session and CSRF cookies use `SameSite=None` when `Secure` (production over HTTPS) and `Lax` otherwise, overridable via `COOKIE_SAMESITE`.

**What was broken.** This platform deploys the web app and the API as separate services on different hostnames, so every browser call to the API is cross-**site**, and a `Lax` cookie is never sent on those. Nobody could have signed in to the deployed platform. The bug was invisible locally, where both share a host.

**It does not reintroduce CSRF risk.** The double-submit token is a cookie an attacker's site can cause to be *sent* but still cannot *read*, so it cannot set the matching header.

`AUTH_RATE_LIMIT_MAX` was made configurable at the same time: 5-per-10-minutes is right for a public instance and wrong for a suite that legitimately creates several accounts from one address.

**Date:** 2026-09-05
**Impact:** `apps/api/src/{config,context,index}.ts`, `apps/api/src/routes/v1/auth.ts`.

---

## ADR-071: Rate limiting in Postgres, not in each process

**Decision:** `@fastify/rate-limit` uses a Postgres-backed store shared by every API instance.

**What was wrong.** The default store is a per-process LRU: with N instances behind a load balancer the effective limit is N × max. It degrades in the worst direction — the harder an endpoint is hammered the more instances the autoscaler adds, and the higher the real limit climbs. `infrastructure/terraform` already provisions `max_instance_count > 1`, so this was live rather than hypothetical.

**Why not Redis.** A second piece of mandatory infrastructure to provision, secure, monitor and fail over, in exchange for one small upsert per request against a database the platform already requires and already holds a pool to. The store interface is the entire coupling surface if that trade ever changes.

**Correctness.** One statement: an upsert whose UPDATE branch decides, inside the same statement, whether the stored window has expired (start at 1) or is live (increment). Postgres's row lock serialises every instance — no read-then-write race, no lost update. Counters are namespaced by route, or the global limit and the signup limit would share a row and ordinary reads would consume the signup budget.

**It fails OPEN**, deliberately, and opposite to the malware scanner's fail-closed rule (ADR-042): a scanner that cannot scan must not certify a file clean, whereas a limiter that cannot count would turn a database blip into a total outage. Nothing in the security model rests on it. The synchronous-construction-failure path fails open too — an uncaught throw in a `preHandler` is a 500 on every request.

**Verified live:** with `AUTH_RATE_LIMIT_MAX=3`, five signups returned 201, 201, 201, 429, 429, with the counters visible in the table, namespaced per route.

**Date:** 2026-09-06
**Impact:** `apps/api/src/plugins/rate-limit-store.ts`, `apps/api/src/{server,context,index}.ts`, `packages/database/src/schema/index.ts` (+ migration `0001`).

---

## ADR-072: Dead-letter queues, and the job listing that stole jobs

**Decision:** Every queue is created with a `.dlq` sibling; dead letters are listable **with the failure reason** and replayable, both project-scoped. `listForProject` becomes a read-only SQL query.

**Dead-lettering was a docstring.** `registerWorker` claimed a job "eventually dead-letters once retries are exhausted". It did not, and could not: pg-boss only dead-letters when a queue names a `deadLetter` target, and none did. An exhausted job stopped at `failed`, was archived and then deleted — for `document.scan`, silent data loss that left the document `scanning` forever with no record of why.

The DLQ must be created before the queue that names it, because pg-boss puts a real foreign key on the column; `ensureQueueWithDeadLetter` makes that ordering impossible to get wrong. The dead-letter row carries the payload but not the failure — the failure is on the *original* job's `output` — so the listing joins the two: reporting a dead letter without saying why leaves an operator as blind as having no DLQ at all. Replay **cancels** the dead letter rather than completing it, because pg-boss only completes an `active` job and a dead letter is `created`; completing it silently did nothing and the replayed job stayed on the outstanding list forever.

**Two real bugs found while building it, both in `GET /api/v1/jobs`:**

1. **It stole jobs.** `listForProject` called `boss.fetch()`, which is the primitive `work()` polls with: it transitions every job it returns to `active`. Opening the jobs screen claimed the project's pending work into a process that would never run it; each job then sat active until `expireInSeconds` elapsed, burning a retry, and a few refreshes could exhaust `retryLimit` and fail it for good. Confirmed against a real queue — `created` before the call, `active` after. The types say nothing about this.
2. **And showed nothing anyway.** Three of the four enqueue sites never put `projectId` in the payload, the only field the tenant filter can key on, so image and document jobs were invisible to their owners — and the theft happened with no visible output at all.

**Verified live** under `ROLE=api` with nothing consuming: the image job is now visible, and five consecutive reads leave it `created` with `retries=0`.

**Date:** 2026-09-06
**Impact:** `packages/jobs/src/queue.ts`, `apps/api/src/index.ts`, `apps/api/src/routes/v1/{platform,images,rag}.ts`.

---

## ADR-073: The spans the docstring promised

**Decision:** `tool.call`, `agent.run` and `agent.step` are emitted for real, and `span-coverage.test.ts` asserts the tree they form.

**What was wrong.** `tracing.ts` asserted in its own docstring that "every span this platform actually needs (agent.run, agent.step, tool.call, gen_ai.chat, job processing) is created explicitly at the point that matters". Two of the five existed. A checkable claim that nobody had checked.

**`tool.call` lives in the registry**, not at the call sites: a span added per call site is one a third call site silently skips, and "which tools are slow, and which fail" must not have a blind spot. It covers the rejection paths (unknown tool, disabled, invalid arguments) — those never reach a handler, so an operator watching only executions would see nothing while a model burned its whole iteration budget on them. They are recorded as a `tool.outcome` attribute rather than span ERROR, because a model guessing a tool name is normal in a model-driven loop and marking it ERROR would bury real failures.

**`agent.run` opens in `createAndStart`**, not in `planAndExecute`, so a task that dies *during* planning still produces a span — precisely the case a later span would miss.

**Nesting is the property under test,** not span count: a flat pile of spans cannot answer "where did this run spend its time". Verified live in the running server — `agent.run` (no parent), `agent.step` (parent = the run), `tool.call` (parent = the step), one trace id, `project_id` on every span.

**Date:** 2026-09-06
**Impact:** `packages/tools/src/registry.ts`, `packages/agent-core/src/engine.ts`, `packages/observability/src/{tracing.ts,span-coverage.test.ts}`.

---

## ADR-074: A UI for the platform API

**Decision:** One operations screen at `/platform` consumes the ADR-066 endpoints and the ADR-072 dead-letter list, with a working Replay control.

**Why.** ADR-066 built six endpoint groups and nothing ever called them. An API that needs curl does not answer "which model am I actually talking to, and is it real?" for the person who has to ask it.

The most important cell on the page reads **"MOCK — not a real model"**, and the E2E test asserts that exact string renders — a mock that looks real is the single failure the honesty rule exists to prevent. The health section distinguishes "you may not see this" (the deliberate 404 for a non-administrator) from "this is broken", and the E2E asserts both that the explanation renders *and* that no error banner appears, which is what stops a future change from "fixing" the 404 by widening the permission.

**A build-time trap fixed at the same time.** `NEXT_PUBLIC_API_URL` is inlined by Next at build time, so a web build made without it points the browser at the development port and every E2E test fails with an opaque "Could not reach the server". `start:e2e` now builds what it runs, so the result no longer depends on the environment of an unrelated earlier build.

**Date:** 2026-09-06
**Impact:** `apps/web/app/platform/page.tsx`, `apps/web/app/lib/app-chrome.tsx`, `apps/web/e2e/auth-and-isolation.spec.ts`, `apps/web/package.json`.

---

## ADR-075: Grounding is verified, not requested

**Decision:** A model's RAG answer is checked against the passages retrieval actually returned. Citing a marker that was never offered, or answering substantively when nothing was retrieved, fails the node.

**What was wrong, in the model's own words.** `buildRagContext` already returned a sentence when nothing matched, with a comment explaining that an empty string "would leave the model to fill the silence, which is how 'no relevant documents' turns into an invented answer". That reasoning was right and the mitigation was not enough. Run against a REAL model (qwen2.5 on a local runtime) with zero retrieved passages, the pipeline produced:

> "The rollback procedure ... is mentioned in Document 12, which is titled 'Payments Service Maintenance Procedures.' According to Document 12, ..."

There was no Document 12. There were no documents at all. The prompt had already instructed the model to use only the given context.

**A prompt is a request, not a constraint.** Only the harness can refuse, so the harness checks the answer instead of trusting the instruction. Two mechanical, certain checks: answering with no evidence, and citing a marker that was never offered. Deliberately NOT a faithfulness judgement — that needs a second model and is a weaker kind of evidence.

An honest refusal must pass, or the plan is trained away from the only truthful answer available.

**Date:** 2026-09-11
**Impact:** `packages/rag/src/grounding.ts`, `packages/agent-core/src/{verify,planner}.ts`, `packages/shared/src/task-graph.ts`.

---

## ADR-076: A RAG query endpoint

**Decision:** `POST /api/v1/rag/query` answers a question over the project's documents, with sources, and enforces grounding.

**What was missing.** Documents could be uploaded, scanned, parsed, chunked, embedded and indexed — and there was no way to ASK anything of them. Retrieval existed only inside the agent's `answer_from_documents` task type, so a caller wanting an answer had to create a task, poll a task graph and dig the content out of a node's output, for what is a single request/response question. The entire ingestion half of RAG had no consumer.

**`retrieveOnly`** exists because a UI that renders its own source list should not have to pay for a model call to get one.

**Zero passages means no model call at all** — deterministic, and it cannot fabricate.

**Date:** 2026-09-11
**Impact:** `apps/api/src/routes/v1/rag.ts`.

---

## ADR-077: One execution path, because the other one leaked every secret

**Decision:** `createTerminalTools` takes an `ExecutionSandbox` as a required parameter and delegates to it. The bare `spawn` is gone.

**What was wrong.** It called `spawn(command, args, { cwd, shell: false })`. Node passes the parent's entire `process.env` to a child when no `env` is given, so a command authored by a MODEL — the only kind this tool ever runs — could read every provider key and the database URL by printing them. Demonstrated against this exact code path:

> `stdout: "sk-ant-CANARY-12345 | postgres://u:p@host/db"`

**The real defect was two execution paths.** `ExecutionSandbox` already built a child environment from scratch and never inherited the parent's (ADR-055). The terminal tool simply did not use it, and the tool registry was wired to the unhardened one. `SECURITY.md` had claimed "environment scrubbing" throughout — true of the path nothing called.

**No default parameter.** A caller that supplies no sandbox gets a compile error, not a quiet fallback — that fallback is the bug.

Delegating also picks up output caps, a real timeout, process-tree termination and container isolation for free. A timeout or cancellation is now a tool FAILURE, not an exit code: a model told "exit code 1" concludes the tests failed and starts fixing code that never ran.

**Date:** 2026-09-11
**Impact:** `packages/tools/src/native/terminal.ts`, `apps/api/src/index.ts`.

---

## ADR-078: A local verification toolchain, gitignored

**Decision:** ffmpeg, Ollama (with a real model), Terraform, fake-gcs-server and ClamAV are installed under `.local-tools/`, which is gitignored.

**Why it matters more than it sounds.** Every one of these was previously recorded as an environment blocker, and each blocked a real verification rather than a feature. With them present: the ffmpeg render tests execute for the first time, the Cloud Storage tests run against a real server, the malware tests detect a real EICAR sample through a real `clamd`, Terraform validates the IaC for the first time (and immediately found a `fmt -check` failure that would have broken CI), and — the largest one — a real LLM and a real embedding model serve the platform end to end.

Gitignored because they are binaries, not source. The commands that install them are recorded in the report so the setup is reproducible.

**Date:** 2026-09-11
**Impact:** `.gitignore`, `infrastructure/terraform/main.tf` (the formatting fix).

---

## ADR-079: Narration, with no silent fallback

**Decision:** A `SpeechProvider` abstraction with two real implementations — any server speaking OpenAI's `/v1/audio/speech`, and the operating system's own offline synthesiser via Windows SAPI. No speech provider means no audio track, reported as `skipped_no_narration`.

**Why an abstraction.** The two realistic sources are not alike: an HTTP service (OpenAI, or self-hosted Kokoro-FastAPI / openedai-speech / LocalAI) and the OS synthesiser, which needs no server, no model download and no network. A platform whose promise is "no mandatory hosted AI" cannot make the hosted one the only option.

**What is deliberately absent** is a third implementation that emits silence. Substituting silence for a voice-over is a fake success an operator cannot detect — the same reasoning as `skipped_no_ffmpeg`.

A failed synthesis degrades the scene to silent rather than failing it: the clip is real and already paid for.

**SAPI takes its text as a base64 environment variable**, never interpolated into the PowerShell command. That text is narration a model wrote from a user's prompt; interpolating it is command injection with extra steps, and a quote plus a semicolon would be enough.

**Date:** 2026-09-11
**Impact:** `packages/media/src/speech.ts`, `apps/api/src/{config,context,index}.ts`, `packages/media/src/video-orchestration.ts`.

---

## ADR-080: A script stage that actually writes a script

**Decision:** A model writes the storyboard — one distinct shot description per scene plus the line spoken over it. The deterministic planner remains as a fallback, and the project records which produced it.

**What was there.** `planScenes` produced, as the ENTIRE shot description for every scene, the string `"Scene 3 of 7: <the user's prompt>"`. Its docstring said so honestly and called itself a stand-in. The consequence was that every scene asked the video provider for the same picture and nothing was ever narrated — while `video_scenes.narration` and `video_scenes.audio_asset_id` had existed as columns since ADR-030 with nothing ever writing to them.

**Durations come from the REQUEST, never the model.** Letting a model choose them would let it silently change the length and cost of the render it was asked for.

**`scriptSource` is the point of the whole ADR.** From the scene rows alone, a mechanical decomposition and an authored storyboard are indistinguishable, and one that reads as authored is exactly the kind of fake completion this platform refuses. The field is persisted, returned by the API and rendered on the screen.

Validation is strict and total: a malformed script becomes a failed render several minutes and several provider calls later, so rejecting it costs one retry.

**Date:** 2026-09-11
**Impact:** `packages/media/src/video-script.ts`, `packages/media/src/video-orchestration.ts`, `packages/database/src/repositories/video-project-repository.ts`, `apps/api/src/routes/v1/videos.ts`.

---

## ADR-081: Subtitles timed from measured audio

**Decision:** Cue timings are measured from the synthesised narration with `ffprobe`. SRT muxes into the MP4 as a real `mov_text` track; WebVTT ships as a sidecar.

**Why not estimate.** The obvious implementation guesses each cue's length from a words-per-minute constant. That drifts — voice, requested rate and sentence length all vary — and the error accumulates across scenes until the captions describe a different part of the video. The narration is a real file the pipeline just produced, so its duration can simply be read.

**A cue ends when the SPEECH ends**, not when the shot does: a caption left on screen through seconds of silence reads as a stuck player.

**A failed probe degrades to the planned duration** rather than failing the render — a worse subtitle track is not a reason to throw away a finished video.

**Verified by `ffprobe` on the real output**, not by asserting which ffmpeg arguments were used: an argument assertion passes against a build that writes an unplayable file, which is the failure that matters. One test specifically proves the timings are measured, using two narrations of very different lengths.

**Date:** 2026-09-11
**Impact:** `packages/media/src/subtitles.ts`, `packages/media/src/video-render.ts`.

---

## ADR-082: Metrics, pulled rather than pushed

**Decision:** OpenTelemetry metrics with an on-demand reader, serialised to Prometheus text and served from the system-admin-only `/api/v1/admin/metrics`.

**What was missing.** docs/20 §2.1 has specified a full metrics table since the project began — request rate and duration, provider latency and error rate segmented by type, token and cost counters, queue depth and dead letters, agent iterations, tool failures, media job duration — and not one of them existed. The platform had structured logs and, since ADR-073, a real trace tree. Neither answers the operational question: a trace says what happened in THIS request, and only a metric says whether the error rate is climbing.

**Pull, not push.** A `PeriodicExportingMetricReader` aimed at a Collector that does not exist drops every point silently — the same constraint ADR-036 recorded for tracing. A pull reader can be verified by looking at it.

**Not on its own port.** `PrometheusExporter` starts an unauthenticated server on :9464. These metrics carry token and cost counters, so that would publish spend to anyone who can reach the port.

**Cardinality is a design constraint.** The recorders are named functions rather than exported instruments, so a call site cannot invent a label set. The HTTP metric labels by route PATTERN, never resolved URL; an unmatched request is bucketed as `unmatched`. `project_id` is absent everywhere — per-tenant spend is answerable exactly from the `usage_records` ledger, which is the right tool for a number that must be correct rather than approximate.

**An unpriced model records NO cost**, not zero — ADR-046's rule carried into metrics. The default provider is the self-hosted runtime, which has no researched price, and a zero would read as "free".

**Two bugs in this module, found by a test that restarts the provider** — which is what a worker restart does: the instrument cache outlived the provider, and `setGlobalMeterProvider` is a no-op once a global is set. Both produce a scrape saying "no registered metrics" while the code reads as working.

**Date:** 2026-09-11
**Impact:** `packages/observability/src/metrics.ts`, `apps/api/src/{index,server}.ts`, `apps/api/src/routes/v1/platform.ts`, `packages/tools/src/registry.ts`, `apps/api/src/routes/v1/chat.ts`, `packages/jobs/src/queue.ts`.

---

## ADR-084: Screens for memory, document Q&A, and the script

**Decision:** `/memory` and `/ask` exist, and the video detail screen shows the script, the narration and the synthesised audio.

**Memory needed a screen more than most endpoints do.** `listMemory`/`addMemory`/`deleteMemory` had existed in the API client with nothing rendering them. Memory silently changes what the model answers (ADR-063 injects it into the prompt), so a user who cannot see what is stored cannot explain a surprising answer or remove the fact that caused it. `useCount` — always returned, never declared in the frontend type — distinguishes a fact shaping every answer from one stored and never recalled.

**A not-grounded answer is shown as such.** ADR-075 detects the model answering beyond its evidence; silently substituting the refusal text would reproduce the original bug with better manners, since the user could not tell "nothing matched" from "we caught a fabrication".

**The video screen states who wrote the storyboard, every time** — see ADR-080 on why that distinction is the whole point.

**Date:** 2026-09-11
**Impact:** `apps/web/app/{memory,ask}/page.tsx`, `apps/web/app/videos/[id]/page.tsx`, `apps/web/app/lib/{api.ts,app-chrome.tsx}`.
## ADR-085: A real video provider, and the asynchronous lifecycle it forces

**Decision:** `packages/providers/video-replicate` implements `VideoProvider` against Replicate's real `predictions` API — submit, poll, download, store — and apps/api constructs it when `VIDEO_PROVIDER=replicate` is configured with `VIDEO_API_TOKEN` and `VIDEO_MODEL_VERSION`.

**Why this reverses ADR-065's "no video adapter".** ADR-065 declined to write one because there is no cross-vendor wire format for video the way `/v1/images/generations` is one for images, so an adapter would buy a single vendor. Replicate answers that objection rather than ignoring it: it is *itself* a provider-neutral layer — one `predictions` shape over hundreds of hosted video models ([[05_IMAGE_GENERATION_RESEARCH]] §2.5) — so this one adapter reaches all of them and changing model is a `VIDEO_MODEL_VERSION` change, not a new package. The `VideoProvider` interface stays the seam; a Runway or Veo adapter later is still a new package and no change to apps/api.

**What being genuinely asynchronous forces, and what each thing prevents:**

- **Cancellation POSTs Replicate's cancel endpoint**, not just breaks the loop. [[07_LONG_RUNNING_JOB_ARCHITECTURE]] §1.2 is explicit that cancellation "must propagate to the provider's own cancel endpoint where one exists": a loop that merely stops leaves a prediction on a GPU that bills by the second, with no handle left to stop it. The cancel request deliberately does **not** carry the caller's `AbortSignal` — by then it is aborted, and it would abort the one request whose job is to stop the billing.
- **A hard wall-clock deadline**, not a poll budget. A cold start is 10–60s before generation even starts (§2.5), so a count of polls bounds nothing; only elapsed time bounds what a stuck prediction can cost. Hitting it cancels, then reports failure.
- **The bytes are downloaded and handed to `store`.** Replicate's `output` is an expiring delivery URL; returning it as an `assetId` would produce scenes that quietly 404 later. The account token is *not* sent with that download — the delivery CDN is a different host and has no business seeing the credential.

**Two different kinds of bad news get two different shapes.** A prediction that ran and failed is a per-scene outcome: `status: "failed"` carrying Replicate's own message, which the scene worker records and retries. A rejected token, an exhausted account or a Replicate outage is not an outcome but a condition an operator must act on, so it throws the matching typed error (`UnauthorizedError`, `QuotaExceededError`, `RateLimitError`, `ServiceUnavailableError`) and keeps a distinction a single error string erases — a scene worker that saw "failed" would retry forever against a credential that will never work.

**Dimensions are measured, not assumed.** `GeneratedVideo` needs width, height and duration; a prediction response carries none of them, and "what size does this model emit" is not a property of an adapter fronting hundreds of models. A small MP4 header reader takes them from the bytes that were actually produced, and reports `0` with `dimensionsProbed: false` for a container it cannot read rather than filling in a plausible `1280x720`.

**Unset changes nothing.** No `VIDEO_PROVIDER` is exactly the previous behaviour: the GIF mock in development (ADR-030, still forbidden in production by ADR-013) and a real `CapabilityUnavailableError` in production. A *half*-configured one fails the boot instead, because naming a provider is a statement that this deployment generates real video and a quiet fallback would leave an operator staring at a 501 with nothing saying why.

**Honest verification status:** unit-tested against fixtures of the documented prediction shapes, including both `output` forms, the failure, auth, cancel and deadline paths. No Replicate token was available, so a real end-to-end generation is unverified — the same status every hosted adapter here carries (ADR-023/ADR-024).

**Date:** 2026-09-11
**Impact:** New `packages/providers/video-replicate/*`; `apps/api/src/{config,index}.ts`, `apps/api/src/routes/v1/{images,videos}.ts`, `.env.example`.

---

## ADR-083: MCP over HTTP, and what a remote server may not do

**Decision:** MCP servers may be stdio or HTTP (Streamable HTTP, falling back to SSE). A remote server's tools are registered **disabled**, may not take an id an existing tool already holds, and are **unregistered** when the server disconnects.

**What the transport work uncovered.** `disconnect` only called `setEnabled(id, false)`. Since `ToolRegistry.register` refuses to overwrite an id and nothing could remove one, a reconnect's rediscovery failed with `Tool "..." is already registered` — so **reconnect had never worked**. `unregister` exists now, and disconnect really removes.

**A remote MCP server is untrusted third-party code supplying tool DEFINITIONS.** That is a materially different trust position from a local subprocess an operator launched. Three consequences: an id collision is refused rather than resolved (a server that renames its tool to `fs.write_file` would otherwise impersonate a native one), discovered tools arrive disabled and need an explicit authenticated enable, and both the transport and any refused ids are reported on `/api/v1/mcp` so an operator can see what a server tried to claim.

**Two defects review found in the first implementation, both verified before being fixed:**

1. **`isLoopbackHost` used `/^127\./`** — which matches `127.0.0.1.attacker.tld`, an ordinary DNS name pointing anywhere. A config naming it over plain `http` passed the guard that refuses plaintext credentials, and the bearer token went out in clear to the attacker's server. Now parsed as a real IPv4 literal in `127.0.0.0/8`.
2. **The SSE fallback connect was not time-boxed.** `Client.connect` awaits `transport.start()` *before* sending the timeout-bearing `initialize`, and `SSEClientTransport.start()` resolves only on the server's `endpoint` event — so a server that 405s the POST and then never emits `endpoint` left the promise pending forever. Reproduced at 5016ms against a 500ms timeout. `startAll` awaits this at boot, so one hung optional integration would have stopped the platform from starting: exactly what ADR-067 introduced the manager to prevent.

**Date:** 2026-09-11
**Impact:** `packages/mcp/src/{client,manager}.ts` + 3 new test files, `packages/tools/src/registry.ts`, `apps/api/src/routes/v1/platform.ts`, `apps/api/src/config.ts`.

---

## ADR-086: A lint gate that can fail

**Decision:** ESLint 9 flat config at the repository root, with three type-aware rules, wired into CI.

**What was there.** `npm run lint` ran `npm run lint --workspaces --if-present`, no workspace defined a `lint` script, and no linter was installed anywhere. The command ran nothing and exited 0; CI did not invoke it at all. A gate that cannot fail is not a gate — the same category of defect as a verification method that throws "not implemented" (ADR-075).

**One root config, not 26 per-package scripts.** A per-package script is one a new package can forget, which is precisely the bug being fixed.

**Type-aware linting is on**, scoped to three rules that share one failure mode — dropped async work: `no-floating-promises`, `await-thenable`, `no-misused-promises`. It costs 12s. Making it work was the real engineering: every workspace tsconfig excludes its own tests, so 58 files have no TS program and type-aware parsing fails on them outright. Solved with `projectService` plus an ignore list expressed **by shape** (`**/*.test.ts`, `**/*.config.ts`, `**/*-fixtures.ts`), so a new package's tests and fixtures are handled without anyone remembering to edit the config — a rule that immediately paid for itself when a third fixture builder arrived with the video provider.

**Style rules were measured and rejected, with the counts recorded in the config** so nobody re-measures: `stylisticTypeChecked` (~40 hits, pure formatting), `no-base-to-string` (24 — all `String(args.path ?? "")` on the `Record<string, unknown>` a model hands a tool, where the `String()` *is* the coercion), and four others. A gate reporting a thousand formatting errors is noise everyone learns to skip.

**Proof it can fail:** removing the `await` from `this.boss.start()` made eslint exit 1 on `no-floating-promises` — a defect `tsc` passes clean.

**Two real bugs found on the first run**, both from ADR-082's metrics work: `observeQueueDepth` and `recordDeadLetter` were imported and never called, so `queue_depth` and `job_dead_letter_total` — one of which docs/20 §2.1 attaches an alert to — had never been emitted. Fixed by wiring them, not by deleting the imports. And a dead `setToolEnabledSchema` whose docstring claimed it hardened an endpoint against coercion; the real route and schema live elsewhere, so it was a refactor leftover taking credit for protection it did not provide.

**Date:** 2026-09-11
**Impact:** `eslint.config.mjs`, `package.json`, `.github/workflows/ci.yml`, `apps/api/src/{index.ts,routes/v1/agent.ts}`, `packages/jobs/src/queue.ts`.

---

## ADR-087: Migration validation from an empty database

**Decision:** `scripts/verify-migrations.sh` applies the checked-in migrations to a genuinely empty database, applies them a second time, asserts every application table exists, and asserts `drizzle-kit generate` produces nothing new. CI runs it.

**What was unverified.** "Migration clean from an empty database" was a completion criterion with nothing checking it. The suite calls `runMigrations` constantly, but always against a fresh in-memory PGlite inside a test that would fail for a hundred other reasons too, so a broken migration was never distinguishable from a broken test.

**The drift check is the one that matters.** The schema is edited by hand while migrations are *generated*, so a column added without regenerating passes every test — the test database is built from the migrations AND the ORM agrees with the schema file — and then fails on the first real deployment, where only the migrations exist. Proven to fail: adding a column to `rate_limit_counters` without a migration made the script report drift.

Applying twice must be a no-op, because a retried deploy and two instances starting at once both run it.

**Date:** 2026-09-11
**Impact:** `scripts/verify-migrations.sh`, `.github/workflows/ci.yml`, `.gitignore`.

---

## ADR-088: Symlink containment in the filesystem tools

**Decision:** `resolveSandboxedPath` resolves symlinks before the containment check, by realpath-ing the deepest existing ancestor of the requested path.

**What was open.** It compared `path.resolve()` output as a string. Its own docstring acknowledged it handled only "a symlink-free lexical escape" — while `docs/13_SECURITY_ARCHITECTURE.md` §11 requires "reject ... symlink escapes (resolve symlinks before the containment check)", and `packages/security/src/sandbox.ts`'s `assertContained` had been doing exactly that all along.

**Two containment implementations, and the filesystem tools used the weak one** — the same shape of defect as ADR-077's two execution paths, and found by the same kind of probe rather than by reading:

```
RESULT: {"ok":true,"output":{"content":"TOP SECRET HOST FILE CONTENTS", ...}}
```

A symlink inside the workspace pointing outside it, read through the real `fs.read_file` tool. An agent can create that symlink with the write tools it already holds, or find one in a repository it was asked to work on. The write direction matters at least as much: it is how an agent following a prompt injection would modify a file on the host.

**Why the deepest existing ancestor.** `realpathSync` throws on a path that does not exist, and this must also validate the destination of a write that CREATES a file. A component that does not exist cannot be a symlink, so resolving the deepest existing ancestor and re-appending the lexical tail is exactly as strong as resolving the final path, without requiring it to exist.

**The lexical path is returned, not the real one.** Containment had to be checked against the real destination; the path handed back to `fs` should still be the one the caller named, so a legitimate symlink *inside* the sandbox keeps behaving like a link. The error message deliberately does not echo the resolved destination — the caller is a model, and telling it where its symlink actually pointed hands back the host path the sandbox exists to withhold.

**Date:** 2026-09-11
**Impact:** `packages/tools/src/native/sandbox-path.ts` + `symlink-containment.test.ts` (12 tests).

---

## ADR-089: Tool enablement is a deployment decision, not a project one

**Decision:** `POST /api/v1/tools/:id/enable` requires a system administrator, not the project-scoped `tools:manage`.

**The mismatch.** `ctx.toolRegistry` is a single process-wide instance and `setEnabled` takes no project, so the effect of this route was always deployment-wide — while the permission guarding it was one every user holds in the project their own signup creates. Any self-registered account could disable a tool for every tenant, or ENABLE one of the MCP-discovered tools that ADR-083 deliberately registers disabled, on everyone's behalf. That last one is the escalation that matters: the disabled-by-default rule exists precisely because a remote MCP server is untrusted, and a project-scoped permission could switch it on globally.

**The fix matches the permission to the blast radius** rather than pretending the radius is smaller. 404 to everyone else, like every other admin action (ADR-049).

**Per-project tool policy would be the richer answer** — a project could then enable a tool for itself without affecting anyone — and it is a real schema change that is NOT done. This is deliberately the narrow fix that closes the escalation today, and it is recorded as narrow so nobody mistakes it for the full design.

Found by the final zero-gap audit.

**Date:** 2026-09-11
**Impact:** `apps/api/src/routes/v1/platform.ts`.

---

## ADR-090: One agent workspace per project

**Decision:** Every native filesystem, coding, search and terminal tool resolves paths inside `<SANDBOX_ROOT>/<projectId>/`, derived from the invocation context rather than from a single deployment-wide root.

**What was shared.** `SANDBOX_ROOT` is one directory and every tool factory took it and then ignored the invocation context entirely. So every tenant's agent read and wrote the SAME directory: project A's agent could read a file project B's agent had just written, overwrite it, or delete it, simply by naming it. `ToolInvocationContext.projectId` was threaded all the way to the handlers and never used.

**This was the one place the authorization model had no equivalent.** Every repository takes a project and puts it in the SQL `WHERE` (ADR-049); the filesystem had no `WHERE` at all. Enumeration counts too — the `fs.list_directory` listing leaked other tenants' filenames, which are often sensitive on their own.

**Containment and scoping are separate concerns.** `projectWorkspace` decides which directory a tool operates in; `resolveSandboxedPath` (ADR-088) decides what may not be escaped, and still checks against the deployment root. Narrowing containment to the project directory as well would be stricter and is a separate change; the escape that mattered was leaving the deployment root entirely.

**An ABSOLUTE `context.workspaceRoot` is now ignored.** Before this change the composition root passed the deployment sandbox root in that field, which is now the PARENT of the project workspace — re-resolving it would read as an escape attempt and reject every coding-tool call in production. A RELATIVE one is still honoured, naming a subdirectory within the project's workspace so a run can scope itself to a checkout.

The project id is validated before it becomes a path component. Ids are UUIDs from this platform's own database, so it never fires today — which is why it is there: the day something else supplies one, a `../` in that field would be a traversal in the ROOT, where the per-path containment check is not positioned to catch it.

Found by the final zero-gap audit.

**Date:** 2026-09-11
**Impact:** `packages/tools/src/native/{workspace,filesystem,coding,search,terminal}.ts` + `workspace-isolation.test.ts`; test fixtures in `packages/agent-core` and `apps/api` reseeded.

---

## ADR-050: A capability the deployment does not have is an error, never a substitute

**Decision:** `CapabilityUnavailableError` (501) exists as a distinct typed error for "the request was well-formed and authorized, but this deployment has no provider that can do it". It is never satisfied with a stand-in result.

**Why it needs its own error.** 503 says "temporarily down, retry" — a client that retries an unconfigured capability retries forever. 400 blames the caller for a request that was correct. The honest answer is a fourth thing: the request is fine, the deployment simply cannot serve it, and no amount of retrying changes that.

**The rule it encodes** is the one the whole platform is built around: an image route with no image provider returns this error and queues nothing, rather than returning a placeholder picture; a video route with no video provider does the same. The alternative — a mock result on a path a caller believes is real — is the single failure mode this repository refuses, and giving it a typed error makes the refusal something routes can be audited for rather than a convention.

*Written retrospectively in 2026-09 from the code that cites it: this decision was implemented and referenced but never recorded.*

**Date:** 2026-09-05 (recorded 2026-09-11)
**Impact:** `packages/shared/src/errors.ts`; `apps/api/src/routes/v1/{images,videos}.ts`.

---

## ADR-051: Conversation memory is a rolling summary with a watermark

**Decision:** `conversations.summary` holds a rolling summary of the turns older than the live context window, and `summarized_message_count` records how many messages it covers.

**Why the watermark is the important half.** A summary alone cannot be updated safely: a second summarisation pass has no way to know which turns are already represented, so it either re-summarises everything (expensive, and it drifts each time) or double-counts. Recording how much history the summary covers makes the next pass incremental — summarise from the watermark forward, replace both fields together.

**Status:** the columns and the repository method exist; nothing writes them. This is recorded honestly rather than as a completed feature — `docs/29_FEATURE_MATRIX.md` carries the same status, and FR-030 is not met.

*Written retrospectively in 2026-09 from the code that cites it.*

**Date:** 2026-09-05 (recorded 2026-09-11)
**Impact:** `packages/database/src/schema/index.ts`; `packages/database/src/repositories/conversation-repository.ts`.

**Superseded in part (2026-09-13):** The status line no longer holds, because ADR-103 writes both columns; and the watermark alone was not enough, because a count is a position in whatever history the client sends, so an edited, branched or reloaded history made it point at the wrong turns. ADR-110 stores a SHA-256 fingerprint of the covered turns next to it (migration 0002) and rebuilds the summary when the history does not match.

---

## ADR-052: Node execution state is persisted before dispatch, so another instance can see it

**Decision:** A task node's status, its exact resolved arguments, and `startedAt` are committed to the database *before* the call is dispatched — commit-before-act, per docs/11 §4.1.

**What it buys, and why `startedAt` belongs in the same write.** The obvious reason is crash recovery: a process that dies mid-call leaves a durable record that the attempt happened, so resumption can reconcile rather than blindly re-run a mutating tool. The less obvious reason is that `startedAt` is what `timeoutMs` is measured from — and because it is in the database rather than in memory, *another instance* can see that an attempt is overdue and reclaim it. Held in memory, a node whose process vanished would sit `running` forever with nothing able to notice.

The same reasoning covers retry scheduling: `next_attempt_at` is persisted, so a backoff survives a restart and is visible to every instance sharing the database, rather than living in a timer that dies with the process.

*Written retrospectively in 2026-09 from the code that cites it.*

**Date:** 2026-09-05 (recorded 2026-09-11)
**Impact:** `packages/agent-core/src/engine.ts`; `packages/database/src/repositories/task-node-repository.ts`.

---

## ADR-053: Long-form video is a persisted project of scenes, not one long call

**Decision:** A long-form video is a `video_projects` row with `video_scenes` children, each generated by its own job, with the render as a separate guarded stage.

**Why per-scene rows rather than one job.** Providers cap a single generation at seconds (docs/06), so a minutes-long video is inherently many calls — and if those live only inside one job, a failure at scene 90 discards eighty-nine successful generations that were already paid for. Persisted per-scene state makes resumption real: re-running orchestration re-enqueues only the scenes that still need an attempt, and every succeeded scene's asset is left untouched.

`render_requested_at` guards the assembly stage, because two scenes settling at once would otherwise each enqueue a render — duplicate ffmpeg work and duplicate assets for one video.

The `script` column was reserved here for a model-written script and storyboard; that stage was not built until ADR-080, and until then the storyboard was a deterministic decomposition that said so.

*Written retrospectively in 2026-09 from the code that cites it.*

**Date:** 2026-09-05 (recorded 2026-09-11)
**Impact:** `packages/database/src/schema/index.ts`; `packages/media/src/video-orchestration.ts`; `packages/media/src/video-render.ts`.

---

## ADR-054: Usage is recorded against a natural key, so a retry cannot double-charge

**Decision:** Every `usage_records` row carries an `idempotency_key` derived from the unit of work it paid for, under a unique index.

**Why a natural key rather than a generated one.** At-least-once delivery is the queue's contract: a job that completes and then fails to acknowledge is redelivered, and a worker that re-runs a provider call would write a second ledger row for work the tenant is charged for once. A key derived from the *thing* — the generation id for an image, the scene id for a video scene, the assistant message id for a chat turn — means the second write conflicts on the index instead of double-charging. A random key would make every retry look like new spend.

The choice of key is the whole design: it must name the smallest unit that is really paid for once. That is why an agent's reasoning node keys per *turn* rather than per node — a ten-iteration run bills for ten model calls, and keying on the node id alone silently dropped nine of them (found and fixed later).

*Written retrospectively in 2026-09 from the code that cites it.*

**Date:** 2026-09-05 (recorded 2026-09-11)
**Impact:** `packages/database/src/schema/index.ts`; `packages/database/src/repositories/usage-record-repository.ts`; `apps/api/src/routes/v1/{chat,images,rag}.ts`; `apps/api/src/index.ts`.

---

## A note on the gaps in this sequence

ADR-014, ADR-020 and ADR-061 are absent and are cited by nothing — they were numbers skipped
during drafting, not decisions that went unrecorded. ADR-050 to ADR-054 WERE cited by code and
unrecorded; they are written above, retrospectively, from the code that cites them and marked as
such. Where such an ADR describes something only partly built (ADR-051's conversation summary),
it says so rather than reading as a completed feature.

---

## ADR-092: Physically separate frontend and backend, with an enforced boundary

**Decision:** The repository is `frontend/`, `backend/` (containing `backend/packages/*`), and `shared/` — three independent packages — and `scripts/verify-boundary.sh` enforces the separation in CI.

**What the old layout did not express.** `apps/web` + `apps/api` + a flat `packages/` looked separated and was not legible as such: nothing in the layout said which of the sixteen packages belonged to the backend, and "the two applications are independent" was a convention nobody could check.

**Why `shared/` stays top-level** rather than moving inside the backend: the frontend genuinely imports it, and imports nothing else. Every one of those imports is `import type` — verified, and now enforced — so at build time the frontend has **zero runtime dependency** on it. That is a contract, not a coupling. The other fifteen packages are imported only by the backend, which is why they live inside it: the boundary is visible in the directory listing.

**Paths were recomputed, not hand-edited.** Twenty-six tsconfigs changed depth, some by one level and some by two (a provider reaching `shared` went from `../../shared` to `../../../../shared`). Hand-counting `../` across that many files is how a migration like this quietly breaks, so the new paths were derived from a package-name → directory map. Package-name imports needed no change at all: there is no `paths` block in `tsconfig.base.json`, so resolution goes through the workspace symlinks.

**The boundary check is the point of this ADR.** A layout cannot enforce anything; one `import` re-couples the applications and would typecheck, build and pass every test. Seven properties are checked — no backend package in the frontend, `shared` imported type-only, no database/queue/filesystem/subprocess reach, no frontend import in the backend, no relative path across the boundary, no server secret readable from frontend code, and each application declaring its own dependencies.

**Both failing checks were proven to fail** by injecting the violations they exist to catch. The type-only check initially did *not* fire: `^` inside an ERE alternation group does not anchor reliably, so it matched nothing and reported a pass. A boundary check that cannot fail is worse than no check, which is why each one is exercised against a real violation rather than trusted.

**Verified after the move:** 0 type errors, 0 lint errors, 556/556 tests with zero skips, each application building alone, boot 7/7, migrations 3/3, E2E 7/7.

**Date:** 2026-09-12
**Impact:** the whole tree; `scripts/verify-boundary.sh`, `.github/workflows/ci.yml`, root `package.json`, `eslint.config.mjs`, 26 tsconfigs, both Dockerfiles.

**Superseded in part (2026-09-13):** The seven properties still stand, but the grep checks described here did not reliably enforce them: check 2 again could not fail (ADR-106), the third audit found every grep defeated (single quotes, `import()`, `require()`, `.js` files and bracketed `process.env` reads were among the evasions), and check 7 passed after only confirming that a `package.json` existed. `scripts/check-boundary.mjs` now judges all seven from the TypeScript syntax tree, and `verify-boundary.sh` runs it with `--all`, so its self-test must catch 39 planted violations before the real tree is judged (ADR-111).

---

## ADR-093: A `test_suite` verification runs in the caller's project workspace

**Decision:** `TestSuiteSpec` carries a `projectId`, set by the **engine** from the task, and the composition root resolves the command inside that project's workspace.

**What was wrong.** The runner resolved against the bare `SANDBOX_ROOT`, which after ADR-090 is the *parent* of every project's workspace. Two consequences, one visible and one not:

- The test file could not be found. That is the failure that exposed it — a real coding-agent run reported `Cannot find module '…/data/sandbox/math.test.js'`, missing the project segment.
- A command that *did* resolve would have executed with every other tenant's files in reach. The visible bug was the lesser one.

**The tenant comes from the task, never from the plan.** A plan is data a model can influence, and which project's files a command may see is not negotiable. The engine therefore injects it when it builds the verification context, and the runner **refuses** a spec that arrives without one rather than falling back to the root.

`verifyAndAdvance` takes the project explicitly rather than reading it off the node, because task nodes carry no `project_id` of their own — the repository joins through `tasks`. The crash-recovery path reads the parent task for it, so a re-verification runs in the same workspace the original attempt did.

Found by running the coding agent end to end, not by reading the code.

**Date:** 2026-09-12
**Impact:** `backend/packages/agent-core/src/{verify,engine}.ts`, `backend/src/index.ts`, `backend/packages/tools/src/index.ts`.

---

## ADR-094: An empty model turn is transient, not fatal

**Decision:** `classifyProviderError` treats "returned no content" / "returned an empty stream" / "produced no events" as **retryable**, so the router retries the same provider instead of failing over.

**What it caused.** A local runtime occasionally returns a turn with no content and no tool calls — sampling, not a broken request. The adapters correctly refuse to pass that off as an empty success (ADR-045), but the router classified the refusal as fatal and failed over immediately. On an **agent** request the next provider was the mock: its scripted reply entered the agent's transcript, burned an iteration, and the task failed with a reason that never mentioned the fallback.

Observed rather than reasoned about: a `fix_failing_test` run fell back to the mock on its very first turn, and a replay of the byte-identical request returned `finish_reason: tool_calls` with a real tool call. The request was fine; asking again was all that was needed.

**The mock was not at fault.** Its `toolCalling: true` is honest — it really does emit scripted `tool_call` events — and production never constructs it. The defect was sending a request there that only needed to be repeated.

**Effect, measured on the same task:** iterations went from 1 to 7, and the agent made six real model-chosen tool calls (`terminal.run_command` ×3, `fs.read_file`, `fs.search`, `fs.glob`) against real files with no mock involved.

**Date:** 2026-09-12
**Impact:** `backend/packages/model-router/src/router.ts` + 2 tests.

## ADR-095: `fs.search` and `fs.glob` resolve inside the caller's project workspace

**Decision:** Both search tools resolve through `projectWorkspace(root, context)`, honour a `workspaceRoot` only when RELATIVE, and re-check containment for every entry the directory walk yields.

**What was open.** ADR-090 gave the filesystem and coding tools a per-project workspace and these two were missed. They kept `context.workspaceRoot ? resolveSandboxedPath(...) : root`, and the composition root never injects a `workspaceRoot` — so in production the FALLBACK was the live branch and both tools walked the deployment root: every tenant's workspace at once. Proven before fixing: tenant B searching for a string inside tenant A's file returned `matchCount: 1` with the secret in it, and `fs.glob` listed `tenant-a/notes.txt`.

A read tool with no `WHERE project_id` is a cross-tenant disclosure even though it writes nothing — and this one answers "where is X defined?" across everything it can reach.

**ADR-088 was incomplete in the same file.** Containment was applied once to the search ROOT and never to the entries the walk produced, and the walk used `statSync`, which resolves symlinks. One link inside its own workspace made the host searchable. Containment now runs per entry, reusing ADR-088's check rather than reimplementing it, and a link that stays inside still resolves: a check that rejects everything is not a containment check.

**Why three audits missed it.** `search.ts` contained a raw NUL byte — an unescaped `\0` in its binary-file guard — so `file` reported it as `data` and every `grep -r` over the source tree printed "Binary file ... matches" and moved on. The file no grep could read was the file with the cross-tenant read. `hash-embedding.ts` had the same byte and was fixed with it.

**Date:** 2026-09-12
**Impact:** `backend/packages/tools/src/native/search.ts`, `embeddings/src/hash-embedding.ts` + 9 tests.

## ADR-096: The first administrator is created by a method HTTP cannot reach

**Decision:** `AuthService.bootstrapSystemAdmin` sets `is_system_admin`, and re-checks that the user table is empty INSIDE the transaction. `signup` still hardcodes `false`.

**What was open.** Nothing could set the column. `signup` hardcoded it false, the column defaults false, and no migration seeded a row — so the flag was unreachable, and with it the entire `/admin` surface and the only control that can enable an MCP tool. Every one of those routes answered 404 to every user who could exist, which reads exactly like correct tenant isolation. `bootstrapFirstAdmin` logged "BOOTSTRAPPED THE FIRST ADMINISTRATOR" and had created an ordinary account.

**Why a separate method rather than a flag on `signup`:** so no HTTP-reachable path can ask for the privilege. And why the emptiness check is inside the transaction: the caller's check is an optimisation, that is the guarantee — two processes racing cannot both win, and it can never promote anyone on a database that already has users, which is the one property that makes an unauthenticated bootstrap path safe to have at all.

**Verified live,** not only by test: booting with `BOOTSTRAP_ADMIN_*` on an empty database logged `is_system_admin: true`, then `GET /api/v1/admin/health` and `/admin/stats` answered 200 for that account and 404 for a self-registered one.

**Date:** 2026-09-12
**Impact:** `backend/packages/security/src/auth-service.ts`, `backend/src/index.ts` + 4 tests.

**Amended (2026-09-13):** The emptiness check does not stop two processes racing: it is a plain SELECT under READ COMMITTED, so two replicas booting at once with different bootstrap emails could both win, and no lock has been added (ADR-107). The flag also granted more than the `/admin` surface and the MCP tool control: `authorizeProject` short-circuited on it, so from this change until ADR-108 the bootstrapped administrator held owner+admin on every tenant's project. The flag now gates `/api/v1/admin/*` and the tool-enable and MCP-reconnect controls, and nothing else.

## ADR-097: Authentication is refused by default, not by each route remembering

**Decision:** The auth plugin refuses any request to a MATCHED route outside `publicPaths` that presented no valid credential. `POST /api/v1/mcp/:id/reconnect` moves to `requireSystemAdmin`.

**What was open.** `server.ts` stated that "a route absent from this list requires authentication; there is no ambient authority anywhere else in the API", the plugin's docstring said the same, and `publicPaths` was accepted by the plugin and **never read**. The property rested entirely on all 53 routes remembering their own guard. An audit of every one found that they all did — which is precisely why nothing had noticed.

So the test is not "an existing route refuses an anonymous caller"; every route already did that itself. It is "a route that FORGETS its guard is still refused", with such a route registered to prove it.

**Scoped to matched routes only.** Fastify runs the hook for the not-found handler too, where `routeOptions.url` is undefined — refusing there turned every unknown path into a 401 instead of a 404. The test caught that, which is the second time in this session a test written for one property caught a regression in another.

**The MCP reconnect route** gated a process-global mutation on `mcp:manage`, a PROJECT permission that `signup` grants every self-registered user in the project it creates for them: any account could restart a shared MCP connection and reassign its tool ids deployment-wide. The identical mismatch ADR-089 fixed for `tools:manage`, in the route next door, missed because it was reasoned about per permission instead of per blast radius. Both permissions are now granted but govern nothing, and `shared/src/auth.ts` says so rather than leaving the grant looking like a capability.

**Date:** 2026-09-12
**Impact:** `backend/src/plugins/auth.ts`, `routes/v1/platform.ts`, `shared/src/auth.ts` + 4 tests.

## ADR-098: `request.id` is a UUID, and other single-line correctness fixes

**Decision:** `genReqId: () => randomUUID()`. The error handler uses `request.id` instead of minting its own. Shutdown steps are isolated and named. Subtitle timestamps derive every field from one rounded total. The reasoning-node try/finally covers the approved tool call.

**The request id was not only a log tag.** It is written to audit records, propagated into job payloads, and used as the usage-ledger idempotency key for a RAG query — the one spending path with no persisted row to key off. Fastify's default generator restarts at `req-1` in every process, so two replicas, or one process after a restart, produced the SAME key for different requests. A collision on that unique index DROPS the charge rather than duplicating it: the direction that loses money quietly. The same change makes the id in an error response the id every log line carries; the handler had been minting a separate UUID, so the value handed to a caller matched nothing an operator could grep for.

**Graceful shutdown skipped the step it exists for.** All steps were awaited in one try, so the first rejection jumped to the catch and abandoned the rest — and `closeDb` is last. PGlite is an embedded engine whose unclean close can corrupt on-disk state in a way that surfaces only on a later migration, which is exactly what happened in Phase 8. Each step is now isolated and named, and a shutdown that could not close everything exits non-zero.

**Subtitles could emit a four-digit millisecond field.** The seconds field was floored while the milliseconds were rounded independently, so `9.9996` rendered `00:00:09,1000` — demonstrated by running both algorithms side by side, not inferred. `mov_text` and most players stop at a malformed cue and take the rest of the track with them, and a measured ffprobe duration lands in that band routinely. The renderer had no unit test at all; the integration fixtures all use whole seconds.

**An approved tool call could strand its node.** `inFlight.set` happened, then 72 lines ran — including the approved call, the single riskiest statement in the method — before the try/catch/finally that releases it began. A throw there skipped both `handleNodeFailure` and `inFlight.delete`: the node sat in `waiting_model` forever with its AbortController leaked and the run no longer cancellable. Proven with a `PermissionError`, which the tool registry deliberately re-throws and is what a permission revoked between parking and approval looks like.

**Date:** 2026-09-12
**Impact:** `backend/src/server.ts`, `plugins/error-handler.ts`, `index.ts`, `packages/media/src/subtitles.ts`, `packages/agent-core/src/engine.ts` + 12 tests.

## ADR-099: A multi-call turn parks every un-executed call

**Decision:** `runReasoningLoop` reports `unexecutedCalls` when it stops for approval; the engine persists them and appends a `tool` message for each on resume — the real result for the approved one, an explicit "not executed" for the rest.

**What was open.** The loop stopped at the first call needing approval and parked without appending a `tool` message for it, and the calls the model had requested after it were never executed and never got one either. The parked transcript therefore held an assistant turn with three tool calls and one result — a shape OpenAI, Anthropic and Google all reject outright. So the approval was recorded, the node resumed, and the resumed run's first provider call failed. A capable model asking for two or three tools in one turn is the normal case, not an edge.

**The un-approved calls are reported, not silently run.** A human approved ONE specific action; the others may need approval of their own. Telling the model plainly lets it ask again if it still needs them.

`readResumeState` falls back to the single `pendingCall` when `pendingCalls` is absent, so a node that was already waiting when this deployed still resumes correctly.

**Date:** 2026-09-12
**Impact:** `backend/packages/agent-core/src/reasoning-loop.ts`, `engine.ts` + 1 test (which fails against the old code).

## ADR-100: Test timeouts are sized for real infrastructure, not for fakes

**Decision:** One shared `vitest.config.base.ts` sets `testTimeout: 30s` and `hookTimeout: 60s`; all 25 packages extend it.

**Why.** Vitest's defaults are 5s per test and 10s per hook, sized for unit tests against fakes — and almost nothing in this repository is that. A typical `beforeEach` here creates an embedded PGlite Postgres and runs every migration against it; several suites spawn real subprocesses (MCP servers over stdio, sandboxed commands, ffmpeg).

On an idle machine that fits inside the defaults, which is why it looked fine. Under load it does not, and two independent audit runs — each with a dozen agents competing for the same cores — hit it: `npm test`, the literal CI gate, exited non-zero with between 1 and 8 failures and a **different count each run**, every one of them a hook or test timeout. A hook timeout then cascades into a second spurious failure in `afterEach`, because the fixture it was meant to close never finished being built. Re-running one of those files with a raised hook timeout passed 10/10 in 23.55s.

So the product code was fine and the GATE was broken — the worse of the two, because a gate that goes red on a busy runner teaches everyone to ignore it, and CI runs on a shared runner by definition. These are ceilings for a machine under contention, not budgets to grow into: a genuinely hung test still fails, just later.

**Date:** 2026-09-12
**Impact:** `vitest.config.base.ts` + 25 package configs.

## ADR-101: "No fake implementation in production" is asserted, not grepped

**Decision:** The provider factories are extracted and exported, and a test builds the real provider set from a production config and asserts nothing in it is a mock. The CI step runs that file.

**What was wrong.** The gate was `grep -rn "new Mock" backend/src --include=*.ts | grep -v "NODE_ENV" | grep -v test`, and it failed in BOTH directions. The LLM guard is `if (config.NODE_ENV !== "production") {` on the line ABOVE the construction, so the construction line contained neither word, survived both filters, and the step exited 1 on correct code — which means the `security` job could never pass, falsifying the workflow's own claim that "every step below was chosen to match a command that IS run locally". And a trailing `// NODE_ENV` comment would have defeated it, so it did not reliably catch the real thing either.

Both directions are asserted, because a test that only proves "no mock in production" would also pass if the factories returned nothing at all.

**Date:** 2026-09-12
**Impact:** `backend/src/index.ts`, `.github/workflows/ci.yml` + 7 tests.

**Amended (2026-09-13):** The `security` job still could not pass after this change, because it ran vitest against packages it never built; separately, the test imported `index.ts`, and importing that file boots the server. ADR-108 added the build step and moved the provider factories to `backend/src/providers.ts`, which has no side effects. The workflow has still never executed, because the repository has no remote.

## ADR-102: Account and data deletion (NFR-008)

**Decision:** `DELETE /api/v1/auth/account` deletes the caller's account, destroys organizations they solely own, and returns the storage objects for the caller to remove.

**What was open.** No route, no CLI, no repository call, and no way even to suspend an account — while the status document claimed "P1 remaining: 0". This needs no hosted credential, no container runtime and no GCP project, so it was never part of the declared externally-blocked work; it was missing.

**And it is not achievable by deleting the user row.** Content hangs off the PROJECT, not the user: `conversations`, `tasks`, `documents`, `image_generations`, `video_projects` and `usage_records` all carry `createdByUserId` with `onDelete: "set null"` — deliberately, so an audit trail survives a departing colleague. Deleting the user would leave every message, document and generated asset in place with a null author. The honest unit of deletion is the organization, which cascades to projects and from there to everything.

So the rule is ownership, not membership: an organization where this user is the only member is destroyed entirely; one with other members keeps its content, which is not this user's to destroy, and only their access ends.

**The database commits before the files are removed.** An orphaned object is a privacy problem an operator can finish by hand from the returned list; rows pointing at files that are already gone would be a corrupt database nobody can repair. Each file that cannot be removed is reported in the response and logged — answering 200 while leaving a tenant's bytes on disk is the one failure mode of a deletion endpoint that matters.

Three guards, each for something different: the session (who), the current password (that it is really them and not a stolen cookie — checked without touching the lockout counter, since being locked out of the account you are deleting is worse than the risk), and a typed confirmation. The audit record is written BEFORE the deletion, because `audit_log.user_id` is `set null` and afterwards the foreign key would reject it.

**Date:** 2026-09-12
**Impact:** `backend/packages/database/src/repositories/account-deletion.ts`, `security/src/auth-service.ts`, `media/src/asset-store.ts`, `gcs-asset-store.ts`, `backend/src/routes/v1/auth.ts`, `shared/src/auth.ts` + 12 tests.

**Superseded in part (2026-09-13):** The route and its order (database first, then files) still hold; the ownership rule, the guards and the audit record do not. What is kept is now decided per project — a project someone else can still reach through either membership route survives — and deletion also removes each destroyed project's agent workspace, cancels its queued jobs, scrubs the person's IP and email from the audit trail, and writes its own record after the deletion with a null user id and only a SHA-256 of the address (ADR-107, ADR-109). The guards are now a session only (an API key gets 403), a password re-check that counts toward the account lockout and audits failures, a rate limit of 5 per 15 minutes keyed on the authenticated user, and the typed confirmation (ADR-108).

## ADR-103: A live window plus a rolling summary (FR-030)

**Decision:** Before each provider call, turns beyond a token threshold are replaced by one system message holding an incrementally-maintained summary; the most recent N turns stay verbatim.

**What was open.** The `summary` and `summarized_message_count` columns and `updateSummary` had existed since ADR-051, unused — ADR-051 said so honestly — and the chat route forwarded whatever array the client sent. So a long conversation was neither summarized NOR truncated: it grew until the provider rejected it at its context limit. FR-030's criterion is that a conversation past the threshold "still produces coherent answers referencing early context"; the actual behaviour was an error.

Three details carry the weight:

- **Leading system messages are never summarized.** Long-term memory injects its retrieved facts as a system message ahead of the turns (ADR-063). Folding that in would degrade those facts into a paraphrase of themselves once per request, compounding — memory would decay by the act of being used.
- **Summarization is incremental.** Each pass covers the previous summary plus only the newly aged-out turns, which is what `summarized_message_count` was always for. The alternative costs tokens proportional to the conversation on every request.
- **A failure degrades rather than failing the request.** The worst case is the model seeing less history — the situation that existed before this. It is quota-checked before it spends (ADR-046 applies to bookkeeping too) and recorded in the ledger with its own idempotency key, because it is a real model call.

**Verified live against qwen2.5:7b.** "My access code is NIGHTHAWK-77" in turn 1, then five filler exchanges; the server's log shows `prompt_messages=5` on every later turn with the covered count advancing 1, 3, 5, 7, 9, the stored summary reads "user's access code is NIGHTHAWK-77", and the model answered "NIGHTHAWK-77" from a prompt that no longer contained the turn where it was said.

**The first run of that scenario was a false pass** and is recorded because the shape recurs: the driver read the conversation id from the SSE `done` event, where it does not appear (it is the `X-Conversation-Id` header), so every turn silently created a NEW conversation and resent the full history. The model answered correctly because nothing had been summarized at all. The tell was `summarizedMessageCount: ROW NOT FOUND` printed next to a green result.

Thresholds are configuration, not constants: the right window depends on the deployed model's context size, which this platform does not choose.

**Date:** 2026-09-12
**Impact:** `backend/packages/memory/src/conversation-window.ts`, `backend/src/routes/v1/chat.ts`, `config.ts` + 8 tests.

**Superseded in part (2026-09-13):** A failed pass no longer leaves the model with less history: the turns the summary does not cover are sent verbatim, and each summarization call has its own usage key, where before two calls could share one (ADR-110). `summarized_message_count` counts turns, not prompt positions (ADR-107), and a stored summary is used only when a SHA-256 fingerprint of the turns it covers matches the history the request sent; otherwise it is rebuilt. The live window never begins on a tool result, and an empty or length-truncated summary is refused rather than stored (ADR-110).

## ADR-104: `web.fetch`, and the SSRF guard its absence had deferred

**Decision:** A native `web.fetch` tool at a new `network` permission level, with address validation, a pinned socket, per-hop redirect revalidation and a byte cap.

**What was open.** The platform could not read a URL. No fetch tool, no search tool, and no row for either in the status matrix — so the completion accounting silently omitted a brief-level capability of an AI platform. Worse, the absence was load-bearing for a security decision: docs/13 deferred its SSRF analysis on the grounds that "no URL-fetching tool exists yet". Implementing the feature meant implementing the guard the deferral had postponed.

A model choosing the URL is an untrusted caller choosing a destination from inside the deployment's network. On a cloud host that is one request to 169.254.169.254 from instance credentials; on any host it is a port scanner and a reader of internal services that trust the network they are on.

- **Addresses are validated, not hostnames.** Every resolved address is checked against the private, loopback, link-local, carrier-NAT, multicast and reserved ranges in IPv4 and IPv6 — including the `::ffff:` mapped forms and the NAT64/6to4 prefixes a v4-only check misses. A name blocklist never works: `localtest.me` resolves to 127.0.0.1 and an attacker runs their own DNS.
- **ALL resolved addresses must pass,** or a record set with one public and one private address is fetchable on a retry.
- **The socket is pinned to the validated address** through `http.request`'s `lookup` hook. Otherwise validating and connecting are two separate lookups, and a one-second TTL answers "public" to the first and "127.0.0.1" to the second. Validation done any other way loses to rebinding.
- **Redirects are followed by hand and every hop revalidated** — a public URL that 302s to the metadata endpoint is the most common bypass there is.

**`network` is a new permission level** rather than reusing `read_only`, which reads the sandbox: a tool that can reach the network can reach the network the deployment is on, and calling that read-only understates it in the one place an operator looks. It is not `write_external` either — a GET writes nothing, and demanding first-use approval to read a documentation page would make the capability useless. Crash recovery treats it as the read it is and auto-retries.

The address policy is injectable for one stated reason: the HTTP mechanics can only be tested against a real server, and a server a test can start is on loopback. A test therefore supplies a policy permitting only its own port — stricter than an "allow private" switch, and it lets the redirect test reach the local server on hop one while still proving 169.254.169.254 is refused on hop two. Nothing reads it from configuration.

**Web SEARCH is not built.** It needs a search provider's credentials, which this environment does not have, and the matrix says so rather than implying the row is complete.

**Amended the same day.** The first version of `isBlockedAddress` compared IPv6 string PREFIXES, and a prefix is not a property of an address: `[::ffff:127.0.0.1]` normalises to `::ffff:7f00:1`, which the decimal-only mapped-address regex missed, so loopback and the metadata endpoint were reachable through their hex spellings. It was masked by an accident — a bracketed literal did not reach the literal branch at all, so it fell through to `dns.lookup`, which refused a bracketed name on this platform; the guard looked correct because something else failed first. The prefix checks are now a real parse (`expandIpv6`), with `::ffff:0:0/96` and `::/96` unwrapped to their embedded IPv4 address so the two families cannot disagree. Found by the test written to prove the decimal encodings were refused.

**Verified live:** `https://example.com/` returns HTML converted to text and `https://api.github.com/zen` returns plain text, while the metadata endpoint, `localhost` (refused via `::1`), `10.0.0.1` and `file://` are each refused with a specific reason.

**Date:** 2026-09-12
**Impact:** `backend/packages/tools/src/native/web.ts`, `shared/src/tools.ts`, `agent-core/src/engine.ts`, `backend/src/index.ts`, `config.ts` + 24 tests.

**Amended (2026-09-13):** The guard's design stands; ADR-107 blocked three IPv6 ranges it missed (SIIT `::ffff:0:0:0/96`, Teredo `2001::/32` and site-local `fec0::/10`). ADR-108 made every hostname refusal one identical message, whether the name resolved to a private address or did not resolve at all (a literal address in the URL may still be echoed, since the caller wrote it), and replaced the socket idle timer with one deadline spanning DNS, every redirect hop and the body, which the invocation's abort signal also reaches. It also destroys redirect bodies instead of draining them, and strips HTML with a single linear-time scanner instead of backtracking regexes (ADR-108).

## ADR-105: E2E always starts its own servers

**Decision:** `reuseExistingServer: false` for both Playwright web servers.

**Why.** It was `!process.env.CI`, a real local convenience, and it turned out to be a gate defect. A backend left listening on 8790 by an earlier session was silently reused, so a full E2E run exercised code from before the day's changes: six of seven tests failed against a contract that no longer existed, and diagnosing that cost more than every boot the reuse had ever saved.

The direction that matters is the other one. A stale server can just as easily PASS — reporting green for code that is not the code under test — and an E2E suite exists precisely to be the thing that cannot be fooled that way. Twenty seconds of boot per run is the correct price.

**Date:** 2026-09-12
**Impact:** `frontend/playwright.config.ts`.

## ADR-106: Boundary check 2 is a parser; a test that cannot run is reported as skipped

**Decision:** `scripts/check-shared-imports.mjs` judges each import/export statement whole; `verify-boundary.sh` delegates check 2 to it. The file-symlink containment case uses `it.skipIf(!FILE_SYMLINKS_SUPPORTED)`, probed at collection time.

**Check 2 could not fail, for the third time.** The first version anchored with `^` inside an ERE alternation group, which does not anchor. The second was `grep "@ai-platform/shared" | grep -E "import|require" | grep -v "import type"` — and a multi-line import puts the package name on the `} from "@ai-platform/shared";` line, which contains neither `import` nor `require`, so the second filter discarded the only line that mattered. A real value import split across lines passed, proven by planting one. A statement that spans lines cannot be judged by a tool that reads one line at a time, so this one no longer tries: whitespace is normalised, each statement is matched whole, and an import is type-only when the statement is `import type` or every named binding carries an inline `type`. Proven against eight planted shapes: single-line, multi-line, re-export, default and mixed value+type imports are caught; `import type`, `{ type A, type B }` and multi-line `import type` are allowed.

**A test passed with zero assertions.** On a platform that refuses file symlinks it caught the error, logged, and `return`ed — which vitest counts as a pass, on the platform this repository is developed on. Reported as a skip instead, it is visible locally, and on Linux CI it runs; the zero-skip gate fails the build if it ever skips there. The honest local count is therefore 1 skipped, and the documents say so rather than keep a "0 skipped" that was only true because a test lied.

**Date:** 2026-09-13
**Impact:** `scripts/check-shared-imports.mjs` (new), `scripts/verify-boundary.sh`, `backend/packages/tools/src/native/search-isolation.test.ts`.

**Superseded in part (2026-09-13):** `scripts/check-shared-imports.mjs` has been removed: the third audit showed that check 2 still passed real runtime imports of `shared`, and `scripts/check-boundary.mjs` now judges it and the other six checks from the TypeScript syntax tree (ADR-111). The skip half stands, but "on Linux CI it runs" was not enough for the zero-skip gate to pass there: the long-form video suite skipped on every non-Windows platform, so the gate would have failed every Linux run until ADR-111 gave that suite a deterministic PCM tone for machines with no synthesiser. The workflow has still never executed; the repository has no remote.

## ADR-107: Fixes to the fixes — a second audit of this phase's own diff

**Decision:** Five defects in code written this phase are fixed, and one false comment corrected, each proven against the old code.

A second independent audit read only this phase's diff rather than the old tree. It confirmed seven findings; ADR-106 covers two. The rest:

**Account deletion destroyed an invited collaborator's work (P1).** The sole-ownership test (ADR-102) queried only `organization_members`. But `addProjectMember` — the API's only way to invite someone — writes a `project_members` row and no organization row, and `authorizeProject` grants full access from that row alone. So an invited collaborator was invisible, and deleting the inviter cascade-deleted the shared project and every message in it. The covering test passed only because it hand-inserted the organization row the API never writes. "Member" now means either route, and the test uses the real invite path.

**Summarization permanently dropped a turn (P2).** ADR-103 stored `covered` as a prompt-array position (`lead + aged.length`) and read it back as a turn offset (`covered - lead`). Those cancel only when `lead` is equal on both requests, and it is not — long-term memory prepends its system message only when retrieval matched something. On a 1 -> 0 transition one aged turn was in neither the summary nor the live window. The count is now in turns.

**The SSRF guard missed three IPv6 ranges (P2).** ADR-104's parser unwrapped `::ffff:0:0/96` and `::/96` but not SIIT's `::ffff:0:0:0/96` (`::ffff:0:7f00:1` is loopback), and did not name Teredo `2001::/32` or site-local `fec0::/10`. All three are blocked, with Teredo's `2001:1::/32` neighbour asserted not blocked.

**The deletion audit row asserted success before the deletion ran (P2).** A rollback would have left a permanent record of a deletion that never happened. It is now written after, with a null user id, the email, and the counts of what was actually destroyed; a failed deletion writes nothing, asserted by test.

**A comment claimed a race guarantee the code did not have (P2).** `bootstrapSystemAdmin`'s emptiness check is a plain SELECT under READ COMMITTED; two replicas booting at once with different bootstrap emails could both win. The comment now says exactly that, and SECURITY.md lists it. An advisory lock would close it and was deliberately not added in the same change that discovered the claim was false.

The lesson is ADR-104's amendment again, generalised: new code written to close a gap gets the same suspicion as the code it replaces, because six of these seven were in exactly that code.

**Date:** 2026-09-13
**Impact:** `backend/packages/database/src/repositories/account-deletion.ts`, `backend/packages/security/src/auth-service.ts`, `backend/packages/memory/src/conversation-window.ts`, `backend/packages/tools/src/native/web.ts` + 9 tests.

## ADR-108: One approval is one call; no implicit tenant access; `web.fetch` bounded in time and CPU

**Decision:** Fixes to seventeen defects a third independent audit confirmed in this phase's own diff, excluding account deletion (ADR-109). Each has a test written to fail on the old code, or was verified live.

**An approval was reusable (P1).** The engine remembered approved tool calls by id. Adapters synthesise those ids — `gemini-call-1`, `call_0` — and they repeat every turn, so one human approval let a *different* destructive call with a recycled id skip the gate later. The id set is gone: every call goes through `approvalFor`, and a parked task resumes from its transcript.

**A system administrator held owner+admin on every tenant's projects (P1).** `authorizeProject` short-circuited on `isSystemAdmin`. That was invisible until ADR-096 made the flag reachable; from then on the bootstrapped administrator could read, spend in and mint API keys for any tenant's project. Membership is now the only route into a project. The administrator role gates `/api/v1/admin/*` and tool/MCP controls, and nothing else.

**Re-authentication could be brute-forced (P2).** The password re-check before account deletion ignored the lockout and never counted a failure, and its route's rate limit keyed on `request.ip` — at the time the client-written `X-Forwarded-For` (ADR-112). Twelve guesses with a rotated header got twelve 401s and no 429; a locked account still accepted the right password. It now counts toward the account lockout and audits failures, and the route limit is keyed on the authenticated user, evaluated after authentication.

**An API key could delete the account (P2).** Deletion is session-only; a bearer request gets 403.

**`web.fetch`.** Five defects, all in code ADR-104 added:

- *Quadratic HTML stripping (P1).* The regex pipeline backtracked: 64 KB of `<` took 1.4 s, about 90 s at the byte cap, on the API process's event loop — every tenant frozen by one page. Replaced by a single forward scanner; 512 KB of hostile input is asserted under 2 s.
- *A DNS oracle (P2).* A refusal named the private address an internal name resolved to, and an unresolvable name returned the raw `ENOTFOUND` — so a prompt-injected model could map internal DNS. Private and unresolvable names now get one identical message.
- *No deadline (P2).* `timeout` was a socket idle timer, which a server sending a byte every few seconds resets forever, and the registry's timeout only raced a promise. One deadline now spans DNS, every redirect hop and the body, and the invocation's abort signal reaches the socket.
- *A redirect body kept downloading (P1).* It was drained with `resume()`, not closed — 7 GB in six seconds after the tool had returned, measured. It is destroyed.
- *Truncation split a character (P2).* The byte cap could end the content in U+FFFD; the incomplete sequence is dropped.

**Gates and shutdown.** Every worker-role shutdown threw on an MCP manager that role never constructs, and exited 1 (verified live: SIGINT now exits 0). The CI `security` job ran vitest against packages it never built, so it could never pass. `no-fake-in-production.test.ts` imported `index.ts`, whose import boots the server; the provider factories moved to a side-effect-free `providers.ts`.

**Date:** 2026-09-13
**Impact:** `agent-core/src/engine.ts`, `security/src/auth-service.ts`, `tools/src/native/web.ts`, `backend/src/{index,providers}.ts`, `routes/v1/auth.ts`, `.github/workflows/ci.yml` + 21 tests.

## ADR-109: Account deletion decides per project, and leaves nothing behind

**Decision:** Deletion considers every organization the user reaches by either membership route, keeps exactly the projects someone else can still reach, and removes everything else the deleted projects owned — rows, files, agent workspaces, queued jobs and the person's data in the audit trail.

This corrects ADR-102 and ADR-107 a second time. What the third audit found, all reproduced through the real app:

- **A private project survived, unreachable (P1).** "Shared" was decided per organization: one collaborator on ANY project kept the whole organization, so a project only the deleter could reach — "alice's private diary" — outlived her, ownerless. Each project is now judged on its own; an organization with another organization member is kept whole, because an organization role reaches every project in it.
- **The last collaborator's deletion kept everything (P2).** A kept organization was only ever considered through `organization_members`, so when the collaborator who had kept it deleted their own account, nothing looked at it again. Organizations reachable through `project_members` are considered too.
- **Agent workspaces stayed on disk (P1).** Everything the agent wrote lived under `SANDBOX_ROOT/<projectId>`, the route reported 200, and with the project row gone no path could ever reach the directory again. Each deleted project's workspace is removed after the commit, through a helper that validates the id and refuses anything but a direct child of the root; a failure is reported in the response.
- **The audit trail kept the person (P2).** `audit_log.user_id` is `set null`, which clears the id and nothing else: every login IP, and the email on every denied login, survived — while a comment claimed "no personal data". Those rows are scrubbed inside the deletion transaction, including denied logins that recorded the address with no user id. The erasure record itself stores a SHA-256 of the address, not the address or an IP.
- **In-flight work left orphans (P2).** A job running at deletion wrote its bytes, failed the row insert at the foreign key, and left a file nothing referenced. Both asset stores now delete the bytes when the row cannot be written. And queued jobs for the deleted projects are cancelled, so no paid provider is called for an account that no longer exists; work already started cannot be stopped, which is why the asset stores' cleanup is still needed.
- **A test could not tell audit-first from audit-after (P2).** The "no deletion record when the deletion fails" test now fails the transaction from a trigger, after the lookup.

**Date:** 2026-09-13
**Impact:** `database/src/repositories/account-deletion.ts`, `security/src/auth-service.ts`, `media/src/{asset-store,gcs-asset-store}.ts`, `tools/src/native/workspace.ts`, `jobs/src/queue.ts`, `routes/v1/auth.ts` + 10 tests.

## ADR-110: A summary is trusted only for the history it was built from

**Decision:** The turns a rolling summary covers are fingerprinted (SHA-256, migration 0002). A request whose history does not match the fingerprint rebuilds the summary instead of trusting it. The live window never begins on a tool result, turns a failed pass did not cover are sent verbatim, and each summarization call has its own usage key.

**A count is a position, not an identity (P1/P2).** ADR-107 made `summarized_message_count` a count of turns rather than prompt positions, which fixed one trigger. But it is still a position in whatever array the client sends. The web client keeps a failed turn's error text in its list while the server stores nothing for it, so after a reload the history is one message shorter and the stored count points past a turn that then appears in neither the summary nor the prompt. An API client that edits or branches its history got a summary of turns no longer in the conversation. The fingerprint turns both into a detectable mismatch; the first-party client also stops sending error placeholders.

**Tool calls were cut in half (P1).** The cut at `turns.length - liveWindowMessages` could land between an assistant turn carrying `toolCalls` and its results, summarizing the call away and sending results with no call — a shape OpenAI and Anthropic both reject with a 400, and one a client retrying the same history hits forever. The cut moves back until the live window starts on something other than a tool result. The summarizer's transcript now records calls and results; it used to render such a turn as `assistant: ` with every name, argument and id gone.

**A bad summary was stored as a good one (P2).** An empty reply advanced the count past turns it never covered. A summary cut off at the output limit (`finishReason: "length"`) became the base of every later pass. Both are refused.

**A failed pass dropped turns (P2).** When summarization failed, the prompt was the stale summary plus the live window, and the turns between them were simply absent. They are now sent verbatim: a larger prompt is recoverable, a silently shorter history is not.

**A charge could be dropped (P2).** The usage idempotency key was the conversation id plus the stored count, which two real calls share whenever they start from the same count — two tabs, or a pass whose summary failed to persist — and a conflict on that unique index discards the second call's tokens. One key per call; `summarize` runs once per request and is never retried, so this cannot double-charge.

Each fix is killed by a mutant of it: reverting any one makes a test fail. One guard did not survive that test — refusing a live window that begins on an orphaned tool result after a failed pass — and was removed as unreachable: a stored count is always a previous tool-safe split point, and the fingerprint proves the history is the same one.

**Date:** 2026-09-13
**Impact:** `memory/src/conversation-window.ts`, `database/src/schema/index.ts`, `migrations/0002_*`, `conversation-repository.ts`, `routes/v1/chat.ts`, `frontend/app/lib/chat-history.ts`, `ChatView.tsx` + 9 tests.

## ADR-111: A boundary check that reads syntax, and suites that run where CI runs

**Decision:** `scripts/check-boundary.mjs` replaces every grep in `verify-boundary.sh` with the TypeScript compiler's syntax tree and must pass a self-test of planted evasions before it judges the real tree. The long-form video suite and the Docker sandbox get tests that can actually run.

**Every grep had been defeated.** ADR-106 made check 2 a statement parser; the third audit then showed it and its neighbours still passed real violations: a comment containing "import type" ahead of a value import, a default binding before `{ type X }`, a file without semicolons, `import()`, `require()`, single quotes, `node:fs/promises`, bare `fs`, `process.env["X"]` and destructuring, a bare `../../shared`, and any `.js`/`.jsx`/`.mjs`/`.cjs` file at all. Check 7 printed a pass after testing only that a `package.json` existed. A module specifier is a property of the syntax tree, so the checker now reads the tree: comments are not in it, statements are delimited by the parser, and every import form is its own node kind.

**It proves it can fail.** `--self-test` builds a throwaway repository with 39 planted violations — every evasion above — and 10 clean files, and requires each violation to be reported under the right rule and nothing in the clean files. Each of 15 mutants that disables one rule or one import form is killed by that self-test. `verify-boundary.sh` runs `--all`, so a checker that cannot detect its own fixtures never reports the real tree green. An internal error exits 2, never 0.

Rule 7 now checks every package manifest, not only the three applications. Widened, it found `drizzle-orm` imported by `backend/src` and `uuid` by quota's tests, neither declared — both resolved only because npm hoisted another package's dependency. Both are declared.

**The long-form suite could never run on Linux (P1).** It skipped unless `SapiSpeechProvider.isAvailable()`, which is `process.platform === "win32"`, so on CI's ubuntu runner it always skipped and the zero-skip gate failed the build on every run — while the documents said the gate passed. What the suite verifies is composition: narration and subtitles muxed into a playable MP4 with timings from the measured audio. That needs real audio of a known length, not a particular voice, so where no synthesiser exists it uses a deterministic PCM tone, declared `isMock` and constructed only in that file. Verified here on both paths, SAPI and forced tone: 3/3 each.

**No test built a DockerSandbox (P1).** The status documents said "unit only" and "flag construction verified", and the documented verification command passed on a machine with no Docker. `dockerRunArgs` is extracted and every isolation flag, the single workspace mount, environment scrubbing and the containment refusal are asserted. A real-container suite runs only through `npm run test:docker` and fails, rather than skips, when docker is unusable — confirmed here, where docker is not installed. Whether those flags contain a process in a real container therefore remains unverified in this environment.

**Date:** 2026-09-13
**Impact:** `scripts/check-boundary.mjs` (new), `scripts/verify-boundary.sh`, `scripts/check-shared-imports.mjs` (removed), `backend/package.json`, `quota/package.json`, `media/src/video-longform.integration.test.ts`, `security/src/sandbox.ts`, `security/vitest*.config.ts` + 13 tests.

## ADR-112: The client's address is the deployment's to state; the API document is checked against the server

**Decision:** `request.ip` trusts exactly `TRUST_PROXY_HOPS` proxies (default 0). `docs/API.md` is generated from each route's own registration, and a test sends a real request for every row it documents. CI fails if the file drifts from the routes.

**`trustProxy: true` let a caller choose its address.** Fastify then takes the LEFTMOST `X-Forwarded-For` entry, which is the one the client writes. Every per-IP rate limit — signup, login, generation — could be sidestepped by rotating a header, and every audit row recorded whatever address a caller claimed. ADR-108 keyed one route on the user; this fixes the source. A hop count trusts only what the deployment's own proxies appended. 0 uses the socket's address, which is right when nothing sits in front; Terraform sets 1 for Cloud Run's front end, which appends the caller's address. Asserted through the audit row a failed login writes, at 0, 1 and 2 hops, and killed by restoring `trustProxy: true`. The Cloud Run value is not verified against a live service; this environment has no GCP project.

**The generated API document was wrong in six rows.** The generator labelled each route from a fixed 1400-character window after its path, so routes inherited their neighbour's guard and rate limit: dead-letter replay was published as administrator-only (any editor can replay, and replays spend quota), login and logout as needing a credential, `me` and both `projects` routes as `project:admin`, and a 300/minute route as its neighbour's 30. It also hard-coded this machine's checkout path, and its conventions said another tenant's resource is "404, never 403" when an API key naming a foreign project gets 403. The generator now reads each route's own options object and handler, takes public paths from `server.ts` instead of inferring them from a missing guard, and stops rather than guesses when a route has neither.

Regenerating cannot catch a generator that is wrong, so `backend/src/routes/api-contract.test.ts` checks the document against the server: an anonymous request to every row (public rows must admit it, every other row must answer 401), a viewer's request to every protected row (403 naming exactly the documented permission when the viewer lacks it; the administrator guard's own 404 for administrator rows; neither 401 nor 403 otherwise), and the `x-ratelimit-limit` the server applies. Run against the previous document, it fails and names each wrong row.

**Each application now starts from a fresh clone.** `cd backend && npm run dev` failed there: every workspace package exports only `dist/`, which is gitignored, and only the root `dev` script built them. The backend's `predev` and the frontend's `prebuild` build what each imports.

**Date:** 2026-09-13
**Impact:** `backend/src/{config,server}.ts`, `infrastructure/terraform/main.tf`, `.env.example`, `scripts/generate-api-docs.py`, `docs/API.md`, `.github/workflows/ci.yml`, `backend/package.json`, `frontend/package.json` + 5 tests.

## ADR-113: The API listens on loopback outside production

**Decision:** `HOST` is configuration. Unset, the API listens on `127.0.0.1` outside production and on `0.0.0.0` in production.

`app.listen` hard-coded `host: "0.0.0.0"`. On a developer's machine that published the whole platform to every network the machine was attached to, with development's own defaults: open signup, process-level isolation for agent commands (ADR-055 refuses that only in production), and a self-registered user who owns their project and can therefore approve their own tool calls. Anyone on the LAN could have model-authored commands run on that machine.

It was found by the fresh-clone check written for a different finding: its log read `Server listening at http://172.16.18.22:8799` - a corporate LAN address, from `npm run dev`.

A container still has to accept its platform's traffic, so production keeps `0.0.0.0`; the Dockerfile and Cloud Run both set `NODE_ENV=production`. Every in-repo client already addresses `127.0.0.1` or `localhost`, so nothing else changed.

**Verified live** against the built server in development mode: `netstat` shows only `127.0.0.1:8797` LISTENING, that address answers `/api/health`, and the machine's LAN address is refused. `resolveListenHost` is unit-tested in both directions and for an explicit override.

**Date:** 2026-09-13
**Impact:** `backend/src/config.ts`, `backend/src/index.ts`, `.env.example` + 3 tests.

## ADR-114: Speech is a capability, and it exists on Linux

**Decision:** `piper` joins `SPEECH_PROVIDER`, and text-to-speech becomes a first-class feature: `POST /api/v1/audio` records a row, a queue worker synthesises it, the result is a stored asset with a MEASURED duration, and the spend is metered in characters against an optional quota.

**Two gaps, one cause.** Speech existed only inside the long-form video pipeline, so a user could not ask this platform for audio at all — no route, no screen, no usage kind. And the only offline provider was `SapiSpeechProvider`, whose `isAvailable()` is `process.platform === "win32"`: every Linux deployment, which is every deployment the Dockerfiles and Terraform target, had no speech unless an operator separately stood up an HTTP TTS server. A capability that exists only on the developer's operating system is a development-only capability wearing a production interface.

piper is one static binary plus an ONNX voice, published for Linux x86_64/aarch64/armv7, macOS and Windows. The provider spawns it with **the text on stdin, never in the argument vector** (arguments are where a model-authored string meets the operating system's own parsing — ADR-032 was this project's argument-injection RCE) and with a minimal environment, like the sandbox and SAPI: a process spawned to read model-authored text has no business seeing the API's keys.

**The duration is measured, not estimated.** ffprobe reads the produced file; a words-per-minute guess is the kind of number that looks right in a list and is wrong in the player, which this project already got wrong once in subtitles (ADR-081). With no ffmpeg configured the column stays null — "not measured", not a fabricated figure.

**Metered in characters,** the unit every synthesiser bills in, with `checkSpeechCharacters` gating before the job is created and the usage row written only on success, keyed by generation id so a retry cannot charge twice.

**Verified live:** piper produced a 3.1 s 22 kHz WAV that ffprobe decodes; the job test stores a real asset and asserts the stored duration matches ffprobe's to within half a second; the route tests cover 202-and-queued, validation, 401, a viewer's 403, 429 on quota, cross-tenant 404 and cancellation.

**Date:** 2026-09-14
**Impact:** `media/src/speech-piper.ts`, `media/src/audio-generation.ts`, `database` (table `audio_generations`, migration 0003, repository, `speech` usage kind), `quota/src/quota-manager.ts`, `shared/src/audio.ts`, `backend/src/{config,index,context,server}.ts`, `routes/v1/audio.ts` + 26 tests.

## ADR-115: The last server component could not work as one

**Decision:** `/chat/[conversationId]` is a client component that loads its history in the browser.

It was the only `async` server component left in the app, and it called `getConversationMessages` → `apiFetch`, which lives in a `"use client"` module: React refuses to call a client export from the server, so the route was a hard error. Even without that it could not have worked — `apiFetch` sends `credentials: "include"` and reads the selected project from `localStorage`, and the Next server holds neither the browser's cookie nor its storage, so the API would have answered 401.

The impact was larger than "a broken link": `ChatView` redirects to this route as soon as the first message of a NEW conversation finishes streaming, so a first-time user watched their answer arrive and then landed on an error page, and every conversation in the sidebar was dead. `/agent/[id]` and `/coding/[id]` had the identical defect and were converted earlier; this one was missed, which is why the reasoning is written out here rather than left as a one-line pragma.

The page renders `ChatView` only once the history has arrived, because `ChatView` seeds its transcript from `initialMessages` on mount — handing it an empty array first would leave the conversation permanently blank, which is the bug a careless fix introduces.

**Date:** 2026-09-14
**Impact:** `frontend/app/chat/[conversationId]/page.tsx`.

## ADR-116: The model's regular expression runs in a thread that can be killed

**Decision:** `fs.search` walks and enforces containment in the main thread, and runs the pattern match in a worker with a deadline and cancellation.

`^(a+)+$` against a single 60-character line backtracked for a measured **117.7 seconds** inside the API process, with **zero event-loop ticks**: no HTTP request, SSE stream or health check was served for any tenant, and the tool's own 30 s timeout could not fire because it is a `setTimeout`. The pattern is chosen by a model, so a prompt injection in any file, RAG chunk or fetched page is enough to trigger it — a whole-deployment availability failure from one tool call.

A blocked regex cannot be interrupted from the thread it is blocking, so the matching moved to a worker, which `terminate()` stops mid-match. **Only the matching moved.** The walk stays in TypeScript because it is what enforces sandbox containment — `resolveSandboxedPath` per entry with symlinks resolved (ADR-088, ADR-095) — and a second implementation of "inside the workspace" is the exact defect class ADR-088 exists to record. The worker receives already-validated paths and does nothing but read and match.

The worker is plain `.mjs` because it must load identically from `dist/` in production and from `src/` under vitest, and Node 22 (what CI runs) cannot load TypeScript in a worker; the package build copies it next to the compiled output.

**Proven by test:** the catastrophic pattern now rejects at its deadline while a 20 ms interval keeps firing — more than 10 ticks where the old code produced none.

**Date:** 2026-09-14
**Impact:** `tools/src/native/search.ts`, `tools/src/native/search-worker.mjs` (new), `tools/package.json` + 4 tests.

## ADR-117: Process isolation now contains the child

**Decision:** `ProcessSandbox` runs a `node` child under Node's permission model, granted the workspace and nothing else.

**What "process isolation" used to mean.** `spawnChild` set a working directory and a scrubbed environment, and applied no filesystem containment at all. An audit proved the consequence end to end through the real tools: `fs.write_file` wrote a script, `terminal.run_command` ran `node` on it, and the script read a host file outside the sandbox root, wrote a new one beside it, listed every tenant's workspace under the deployment root, and resolved DNS. Both tools are `write_local`, whose default approval is `never`, so no human gate was crossed — and `SANDBOX_RUNTIME=process` is the default and the only mode available without Docker, which is the normal local posture.

The argument guards in `terminal.run_command` (no flag-shaped arguments, every argument resolved through the sandbox boundary) were sound and irrelevant: the payload was in the SCRIPT, not the arguments. Containment had to come from the runtime.

`--permission` (Node 23+; `--experimental-permission` on 20–22) with `--allow-fs-read`/`--allow-fs-write` scoped to the workspace denies reads and writes anywhere else, and denies child processes, worker threads and native addons — so a confined script cannot spawn an unconfined one. The same exploit now answers `ERR_ACCESS_DENIED` at every step, while ordinary work inside the workspace still runs.

**What it does not do: the network.** The permission model has no network dimension, so a script can still open sockets and resolve DNS — verified, and stated here rather than left for someone to discover. `--network none` under Docker remains the production posture, and a runtime with no permission model at all reports that through `supportsPermissionModel` instead of pretending.

**Date:** 2026-09-14
**Impact:** `security/src/sandbox.ts` + 9 tests.

## ADR-118: The platform adopts the model runtime already running on the machine

**Decision:** With no `LLM_BASE_URL`/`LLM_MODEL` and outside production, the API probes Ollama's default endpoint at boot and registers what it finds as the default chat model — and its embedding model, when no embedder was configured. It says so in the boot log.

**What a first run used to be.** With no `.env`, the platform registered the MOCK language model and the lexical hash embedder, while Ollama sat on 127.0.0.1:11434 with `qwen2.5:7b` and `nomic-embed-text` loaded. So a new user's first chat was answered by a stub, retrieval ranked by shared vocabulary rather than meaning, and nothing on the screen said which. The variables that would have fixed it were not in `.env.example` either — they are now, with every one of the 70 settings tagged REQUIRED / OPTIONAL / LOCAL / PROD / CREDENTIAL / SECRET.

Three properties keep detection from becoming a surprise:

- **Explicit configuration always wins.** If a runtime was named, nothing is probed.
- **Production never probes.** What answers real users is an explicit decision; silently adopting whatever listens on a port is how a staging model ends up serving traffic. `NODE_ENV=production` skips it.
- **It is announced.** The boot log names the runtime, the chat model, the embedding model, and the variables that override them. A failure — nothing listening, a timeout, only embedding models pulled — is logged as "nothing to adopt" and leaves the platform exactly where it was.

**Verified live, with no `.env` at all:** the boot log reads `local model runtime detected … chat_model qwen2.5:7b … embedding_model nomic-embed-text:latest`, `/api/v1/models` reports `local/qwen2.5:7b` as the default with `isMock: false`, `embeddings: a real semantic model is configured`, and `POST /api/v1/chat` answered "The capital of France is Paris." in 11.8 s with real token usage from `provider: local`. The mock was still registered, as a non-default fallback, exactly as ADR-013 requires outside production.

**Date:** 2026-09-14
**Impact:** `backend/src/local-runtime.ts` (new), `backend/src/providers.ts`, `backend/src/index.ts`, `.env.example` + 11 tests.

## ADR-119: Nothing spends without a gate, a record, or a way to stop

**Decision:** Four holes closed, each of which let a project spend past its budget, spend unrecorded, or keep spending after nobody was listening.

**A cancelled stream kept the provider generating.** `ModelRouter.streamChat` drove the provider's iterator by hand (`[Symbol.asyncIterator]()`) at two levels, and neither closed it. When a consumer abandons the stream — the chat route's `for await` ends the moment a browser disconnects, and a cancelled agent node does the same — JavaScript calls `return()` on the router's generator, but that was never forwarded, so the adapter's own `finally`, which aborts the upstream HTTP request, never ran. The provider went on generating, and billing, into a stream nobody was reading. Both layers now close what they opened; the test abandons a stream mid-flight and asserts the provider's `finally` ran and that it stopped producing.

**Retrieval embedded for free, and off the books.** `POST /api/v1/rag/query` embeds the question on every call. There was no quota check and no ledger row, so a project with an exhausted budget could still drive an embedding endpoint, and no one could see what retrieval cost. The budget is checked before the call and the row written after it — and only for a real embedder, because the lexical fallback is local arithmetic and charging for it would be fiction. `PgUsageRecordRepository.sumEmbeddingTokensSince` now exists, without which a configured embedding limit made `checkEmbeddingTokens` fail closed and refuse every query — correct, and useless.

**Two routes re-enqueued paid work with no gate.** `POST /api/v1/videos/:id/retry` re-runs exactly the scene generation the create route gates, and had neither the quota check nor the per-route limit that route has. `POST /api/v1/jobs/dead-letter/:queue/:id/replay` enqueues real work from one click, with nothing bounding it. Both now carry a rate limit, the retry checks the video-seconds budget for the scenes it would regenerate, and a replayed image generation is checked against the daily image budget.

**A provider's error text reached the caller.** `ServiceUnavailableError(event.message)` handed a tenant whatever the upstream said — which can name its host, model and account. The caller gets a stable sentence and the request id; the detail goes to the log.

**Date:** 2026-09-14
**Impact:** `model-router/src/router.ts`, `database/src/repositories/usage-record-repository.ts`, `embeddings/src/embedding-service.ts`, `routes/v1/{rag,videos,platform}.ts`, `docs/API.md` + 8 tests.

## ADR-120: Images are generated locally, by a real diffusion model

**Decision:** A `SdCppImageProvider` that runs stable-diffusion.cpp on the CPU — one binary, one weights file, no server — is preferred over the mock whenever `IMAGE_SD_CLI_PATH` and `IMAGE_SD_MODEL_PATH` are set, in every environment.

**What a local user got before.** With no image credentials the platform returned `MockImageProvider`'s placeholder: a real SVG, honestly labelled "MOCK IMAGE", of the words rather than the thing. That was the right answer to "we have no provider" and the wrong answer to "can this platform generate an image", because a real one needed a hosted account. The other real adapter speaks the OpenAI images wire format and needs either that account or a separate server — and, as an audit measured, could not have driven a local CPU backend anyway: it hard-codes 1024-pixel sizes, sends no step or guidance controls, and gives up at 180 s, while SD-Turbo at 512 px wants exactly one step and about 45 s.

stable-diffusion.cpp removes the account and the server. The provider spawns the binary with an argv array and `shell: false` (the prompt is model-authored text and a shell is a parser — ADR-032), a minimal environment (a renderer has no business seeing provider keys — ADR-077), and a deadline with a kill. It requests dimensions that are multiples of 64, because that is what diffusion models accept, and spends more sampling steps only when a higher quality was asked for. Output that is not a PNG is a failure, never a substituted placeholder (ADR-050).

It is preferred over the mock in production too, because it is not a mock.

**Verified end to end, through the API and the queue:** `POST /api/v1/images` with "a red lighthouse on a cliff at dawn, oil painting" returned 202; the job ran on `stable-diffusion.cpp` and succeeded in **42.2 s**; `GET /api/v1/assets/:id` served **607,047 bytes** of `image/png` that decode as a real **512×512** picture of a cliff at dawn. The provider's own suite additionally generates a 256×256 image from the real model and reads its size back out of the PNG's IHDR chunk.

**What it is not.** A 4-core CPU is not a GPU: 512 px takes tens of seconds, and SD-Turbo's licence is non-commercial, which `.env.example` says next to the download link. A deployment that wants speed or other licensing points `IMAGE_BASE_URL` at a real server instead.

**Date:** 2026-09-14
**Impact:** `backend/packages/providers/image-sdcpp` (new), `backend/src/{config,providers}.ts`, `.env.example`, root and backend tsconfig, `backend/package.json` + 10 tests.

## ADR-121: A real video clip, from a real still — and it says that is what it is

**Decision:** `ImageMotionVideoProvider` generates one frame with the configured REAL image provider and animates it with ffmpeg into an H.264 MP4. It is chosen when there is no video credential, there is a real image provider, and ffmpeg exists; otherwise the mock stands as before.

**It is not a video model, and every surface says so.** The name is `image-motion`, the provider's `technique` string reads "a generated still … animated by ffmpeg — motion, not a video model", and that sentence is attached to every clip's metadata. Nothing in the scene moves; the motion is a slow push or drift, alternating direction by scene so a sequence does not pulse.

**Why build it at all.** Without a Replicate token the only option was `MockVideoProvider`: a 160×90 animated GIF of coloured bars, which every screen played as though it were video. A real MP4 built from a real generated image of the scene's own prompt is genuinely useful — it is what makes the long-form pipeline produce something watchable, with real narration and real captions over real pictures — and, unlike the GIF, it is honest about its ceiling. A deployment with a video model sets `VIDEO_PROVIDER=replicate` and this steps aside.

**Verified end to end, locally, with no credentials of any kind.** `POST /api/v1/videos` ("a lighthouse keeper's morning by the sea", 6 s in two scenes) finished in **58 s**: two stills generated by stable-diffusion.cpp and animated, narration synthesised by piper, captions timed from the measured audio, and one render. `GET /api/v1/assets/:id` served **135,279 bytes** of `video/mp4`, and ffprobe reports three real streams — **video/h264, audio/aac, subtitle/mov_text** — with a 5.92 s duration. The muxed subtitle track reads back as "Morning just waking up." and "First light ignites the lighthouse."

The first run also exposed a real defect: clips were square while the render targets 16:9, so the finished video had black bars down both sides. Clips are 16:9 now.

**Date:** 2026-09-14
**Impact:** `backend/packages/providers/video-motion` (new), `backend/src/providers.ts`, `backend/src/index.ts`, root and backend tsconfig, `backend/package.json` + 9 tests.

## ADR-122: Cancellation something observes, and captions something can play

**Decision:** Image and video work can be cancelled from the API and the interface, the workers settle cancelled work without calling a provider, and a narrated render's captions are stored on the project row and offered to the player as a WebVTT track.

**Cancellation existed and was unreachable.** `ImageGenerationRepository.requestCancel` and `VideoProjectRepository.requestCancel` shipped with their `cancelled` statuses, documented as "the worker observes it and settles the row". No route ever called them and no worker ever read them, so the state could not occur: a user who started a long video had no way to stop it, and on a billed provider every scene of a mistaken 900-scene project would be generated and paid for. `POST /api/v1/images/:id/cancel` and `POST /api/v1/videos/:id/cancel` record the request; both workers check it before the provider call and settle the row; both screens offer the button. The route records a REQUEST rather than claiming a terminal state, because work already inside a provider call has to finish — the same shape as the audio path (ADR-114).

**Captions were generated and thrown away.** Every narrated render stored an SRT and a WebVTT as real assets and returned their ids; `updateRender` accepted only a render status, asset and error, so the ids went nowhere. The bytes survived as assets nothing referenced, and the player had no track: the MP4's `mov_text` stream is muxed, which browsers do not display in a `<video>` element, and the WebVTT that exists precisely for a `<track>` was unreachable. Two columns (migration 0004) now hold them, the render persists them, and the player offers the VTT as a default captions track — with `crossOrigin="use-credentials"`, because the captions come from the same authenticated asset route as the video and the track would otherwise silently 401.

**Date:** 2026-09-14
**Impact:** `database` (two columns, migration 0004, repository), `media/src/{image-generation,video-orchestration,video-render}.ts`, `routes/v1/{images,videos}.ts`, `frontend/app/images/page.tsx`, `frontend/app/videos/[id]/page.tsx`, `frontend/app/lib/api.ts`, `docs/API.md` + 7 tests.

## ADR-123: The chat journey is verified in a browser, because only a browser could have caught this

**Decision:** The E2E suite sends a message and reads the answer off the screen. Streamed responses carry `Access-Control-Allow-Credentials`, a send that fails says why, and a send in flight can be stopped.

**Three defects, one blind spot.** The E2E suite navigated to `/chat` and stopped there. Everything downstream of pressing Send was covered only by `app.inject()` and unit tests, and all three of these live in the gap between "the server produced the bytes" and "the user saw them":

- **The answer was thrown away by the browser.** The hijacked SSE response set `Access-Control-Allow-Origin` but not `Access-Control-Allow-Credentials`. The client sends the request with `credentials: "include"` (`frontend/app/lib/chat-stream.ts`), and the CORS rules then *require* that header — so the browser discarded a response the server had already fully generated and billed. Nothing in Node can see this: `fetch` from a script, `curl` and `app.inject()` all ignore CORS entirely. Both hijacked streams (`chat.ts`, `agent.ts`) now send it.
- **A failed send said nothing at all.** `handleSubmit` was a `try`/`finally` with no `catch`, and the `error` event it did handle only covers errors the *server* managed to send. Anything that threw out of the generator — a dropped connection, this CORS refusal, an abort — left behind the empty assistant bubble the send had optimistically added. The screen showed a blank answer and no reason for it, which is the worst available outcome: the user cannot tell a broken deployment from a quiet model. Every exit from a send now renders what became of the answer, keeping whatever text had already arrived.
- **Stop was unreachable.** An `AbortController` was constructed on every send and nothing could ever call it, so a wrong or endless answer had to be waited out. The composer now offers Stop while streaming; aborting releases the reader, which is what actually stops the server streaming into a page nobody is reading — and stops the billing with it. A stop is not an error: partial text is kept and marked no differently.

**The test is checked against the defect, not just written.** Removing the header and re-running fails the spec, which is the only evidence that a green test means anything. Doing so also exposed a weak assertion in the first draft: `not.toBeEmpty()` passed against the in-flight `…` placeholder, so the spec went green against a transport that never delivered a word. It asserts a *word character* now, which the placeholder does not contain, and that no error bubble is present. With the header removed the browser renders "The answer could not be delivered: Failed to fetch"; with it, the answer arrives, the redirect to `/chat/<id>` lands, and the conversation survives a reload and a fresh navigation.

**A stale quota test, corrected rather than deleted.** `PgUsageRecordRepository.sumEmbeddingTokensSince` was implemented in ADR-119, which made "the ledger cannot measure this" untrue of the real repository and turned the fail-closed test red. The guarantee still matters for every other `QuotaUsageLedger` implementation, so the test now stands where those implementations stand — on a ledger with the aggregate genuinely stripped — and the metering test was moved onto the real repository aggregate, where a hand-written copy of the SQL had been proving only that the copy worked.

**Date:** 2026-09-14
**Impact:** `backend/src/routes/v1/{chat,agent}.ts`, `frontend/app/chat/ChatView.tsx`, `frontend/e2e/chat-and-history.spec.ts` (new), `frontend/app/chat/ChatView.test.tsx` (new, 5 tests), `backend/packages/quota/src/quota-manager.test.ts`, `backend/package.json` (`start:e2e` pins the runtime probe at a closed port so E2E is deterministic on the mock).

## ADR-124: The binaries the platform shells out to, and the truth about which provider ran

**Decision:** CI installs every binary its gated suites need, the API image ships ffmpeg and piper, and `/api/v1/providers` reports the real media provider — name, mock flag, and the provider's own statement of its ceiling.

**The zero-skip gate could not pass.** CI installs fake-gcs-server, clamd and ffmpeg precisely so the suites that need them run rather than quietly skipping, and asserts afterwards that nothing skipped. But four suites need binaries CI never installed — the two piper suites, the stable-diffusion.cpp suite and the motion-video suite — so each printed its skip notice and the gate failed the build. The premise of the gate ("every gated binary is installed above") has to be true for the gate to mean anything, so piper and stable-diffusion.cpp are installed now, the weights cached on a key that changes only when the pinned model does. The archives were downloaded and listed rather than guessed at: the sd.cpp release extracts flat and its binary is `sd-cli`, not `sd`, which as a `find … -name sd` would have failed as an empty variable rather than an error. Locally, with every gated binary present, the whole suite reports one skip — a file-symlink case that needs elevation on Windows and runs without ceremony on Linux.

**The image could not do what the product claims.** Neither container carried ffmpeg or piper, so every render in every deployment of that image settled `skipped_no_ffmpeg` and no speech provider could run at all: the other offline one is Windows-only (ADR-114). Both are installed now, and the runtime base moved from Alpine to Debian slim because piper's released Linux binary is linked against glibc and on musl does not run — builder and runtime share the base so anything compiled during `npm ci` is loaded by the libc that built it. `SPEECH_PROVIDER` defaults to `piper` in the image alone, where the binary and the voice are guaranteed to be at a known path; everywhere else the operator still opts in.

**A screen cannot tell the truth it is not told.** `/api/v1/providers` answered `{ available: true }` for image and video and nothing more, so the Videos page filled the gap with fixed prose: clips came from "a mock clip provider" and each scene was "a real, playable animated GIF". Written when the mock was the only option, false the moment ADR-120 and ADR-121 landed — and the failure runs both ways, hiding a real capability behind a stale disclaimer just as easily as presenting a placeholder as a result. Chat models have carried `isMock` since ADR-065; media does now too, read off the providers actually constructed at boot so it cannot drift, and carrying the video provider's `technique` line so "motion, not a video model" reaches the person reading the screen. Where nothing is configured the fields are absent rather than defaulted, and the page then claims nothing at all.

**Date:** 2026-09-14
**Impact:** `.github/workflows/ci.yml`, `backend/Dockerfile`, `backend/src/{context,index,test-app}.ts`, `backend/src/routes/v1/platform.ts`, `frontend/app/lib/api.ts`, `frontend/app/videos/page.tsx` + 8 tests (`media-providers.test.ts`, `frontend/app/videos/page.test.tsx`). The CI workflow and the image build are not runnable in this environment (no Docker, no git remote): the download URLs, archive layouts and binary names were verified by hand, the workflow run itself is BLOCKED_EXTERNAL.
