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

## ADR-015: GCP service selection detail — deferred to Phase 14, tracked here as a pointer

**Decision:** No new decision needed now; recorded only so this file stays the single index of pending architectural calls. See [[18_CLOUD_ARCHITECTURE]] for the current recommendation (Cloud Run + Cloud SQL + Cloud Storage + Cloud Tasks(deferred, see ADR-012) + Secret Manager + Artifact Registry, GKE/AlloyDB/Pub-Sub explicitly deferred).

**Date:** 2026-08-31
**Impact:** None yet — Phase 14 is documentation/IaC only per ADR-011 and is not authorized to provision anything.
