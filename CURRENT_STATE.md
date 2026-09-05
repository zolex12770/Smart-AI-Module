# CURRENT_STATE.md — Repository Audit

**Audit date:** 2026-09-05
**Commit audited:** `3989631` (26 commits total, working tree clean at audit start)
**Method:** read-only. Ten independent subsystem auditors read the real source, then adversarial
verifiers re-checked every status claim against the code. No file in the repository was modified,
created, or deleted during the audit except this report.

> **How to read a status.** The rubric is applied against what the code *does*, not what the docs
> *say*. A deliberately-mocked provider sitting behind a real, working pipeline is recorded as a
> narrowed scope, not a missing feature — but where a document claims a behaviour the code does not
> have, that is recorded as a divergence and counted against the status.

| Status | Meaning |
|---|---|
| **IMPLEMENTED** | Works end to end for its stated scope; real code, no stubs. |
| **PARTIALLY IMPLEMENTED** | Real working core, but a named part of the intended scope is absent or narrowed. |
| **SKELETON** | Types/routes/scaffolding exist; the behaviour behind them is absent or trivial. |
| **MISSING** | Not built. |
| **BROKEN** | Code exists but does not work — throws, cannot boot, or produces wrong results. |

### Honesty caveats about this audit itself

- **One of three verification lenses did not run.** The lens assigned to hunt *under*-claiming and
  undiscovered `BROKEN` subsystems terminated on a session limit. Statuses were therefore checked
  hard for over-claiming and for completeness, but less hard for the possibility that something is
  *worse* than reported. Treat every status as an upper bound on badness, not a lower one.
- **The audit is static.** The test suite was executed earlier in the same session (189 passed,
  35 files, clean tree at `3989631`), and several live boots were run before the audit began; the
  auditors themselves ran no code.
- Test counts here were verified independently by counting `it(`/`test(` blocks file by file:
  **189 blocks across 35 files**, matching the suite's own reported total exactly.

---

## 1. Exact current directory tree

261 tracked files. Build outputs (`dist/`, `.next/`), `node_modules/`, and the gitignored
`apps/api/data/` runtime directory are excluded — this is `git ls-files`, the authoritative set.

```
|-- .github/
|   `-- workflows/
|       `-- ci.yml
|-- apps/
|   |-- api/
|   |   |-- src/
|   |   |   |-- plugins/
|   |   |   |   `-- error-handler.ts
|   |   |   |-- routes/
|   |   |   |   |-- v1/
|   |   |   |   |   |-- agent.test.ts
|   |   |   |   |   |-- agent.ts
|   |   |   |   |   |-- chat.ts
|   |   |   |   |   |-- images.test.ts
|   |   |   |   |   |-- images.ts
|   |   |   |   |   |-- rag.test.ts
|   |   |   |   |   |-- rag.ts
|   |   |   |   |   |-- usage.test.ts
|   |   |   |   |   |-- usage.ts
|   |   |   |   |   `-- videos.ts
|   |   |   |   `-- health.ts
|   |   |   |-- config.test.ts
|   |   |   |-- config.ts
|   |   |   |-- context.ts
|   |   |   |-- index.ts
|   |   |   |-- role.test.ts
|   |   |   |-- role.ts
|   |   |   |-- server.ts
|   |   |   `-- test-app.ts
|   |   |-- Dockerfile
|   |   |-- package.json
|   |   |-- tsconfig.json
|   |   `-- vitest.config.ts
|   `-- web/
|       |-- app/
|       |   |-- agent/
|       |   |   |-- [id]/
|       |   |   |   `-- page.tsx
|       |   |   `-- TaskDetail.tsx
|       |   |-- chat/
|       |   |   |-- [conversationId]/
|       |   |   |   `-- page.tsx
|       |   |   |-- ChatView.tsx
|       |   |   `-- page.tsx
|       |   |-- coding/
|       |   |   `-- [id]/
|       |   |       `-- page.tsx
|       |   |-- files/
|       |   |   `-- page.tsx
|       |   |-- images/
|       |   |   `-- page.tsx
|       |   |-- lib/
|       |   |   |-- api.ts
|       |   |   |-- chat-stream.ts
|       |   |   |-- status-badge.tsx
|       |   |   `-- use-task-events.ts
|       |   |-- settings/
|       |   |   `-- page.tsx
|       |   |-- tasks/
|       |   |   `-- page.tsx
|       |   |-- videos/
|       |   |   |-- [id]/
|       |   |   |   `-- page.tsx
|       |   |   `-- page.tsx
|       |   |-- globals.css
|       |   |-- layout.tsx
|       |   `-- page.tsx
|       |-- AGENTS.md
|       |-- CLAUDE.md
|       |-- Dockerfile
|       |-- next-env.d.ts
|       |-- next.config.mjs
|       |-- package.json
|       `-- tsconfig.json
|-- docs/
|   |-- 00_PROJECT_VISION.md
|   |-- 01_REQUIREMENTS.md
|   |-- 02_AI_AGENT_RESEARCH.md
|   |-- 03_EXISTING_AGENT_ARCHITECTURES.md
|   |-- 04_MODEL_PROVIDER_RESEARCH.md
|   |-- 05_IMAGE_GENERATION_RESEARCH.md
|   |-- 06_VIDEO_GENERATION_RESEARCH.md
|   |-- 07_LONG_RUNNING_JOB_ARCHITECTURE.md
|   |-- 08_MEMORY_ARCHITECTURE.md
|   |-- 09_RAG_ARCHITECTURE.md
|   |-- 10_TOOL_AND_MCP_ARCHITECTURE.md
|   |-- 11_AGENT_LOOP.md
|   |-- 12_MODEL_ROUTING.md
|   |-- 13_SECURITY_ARCHITECTURE.md
|   |-- 14_DATABASE_ARCHITECTURE.md
|   |-- 15_API_ARCHITECTURE.md
|   |-- 16_FRONTEND_ARCHITECTURE.md
|   |-- 17_BACKEND_ARCHITECTURE.md
|   |-- 18_CLOUD_ARCHITECTURE.md
|   |-- 19_DEPLOYMENT_ARCHITECTURE.md
|   |-- 20_OBSERVABILITY.md
|   |-- 21_TESTING_STRATEGY.md
|   |-- 22_COST_AND_QUOTA_STRATEGY.md
|   |-- 23_FAILURE_RECOVERY.md
|   |-- 24_PROJECT_STRUCTURE.md
|   |-- 25_IMPLEMENTATION_ROADMAP.md
|   |-- 26_DECISIONS.md
|   |-- 27_RISKS_AND_LIMITATIONS.md
|   |-- 28_API_PROVIDER_MATRIX.md
|   |-- 29_FEATURE_MATRIX.md
|   |-- 30_FINAL_SYSTEM_SPEC.md
|   `-- FINAL_AUDIT.md
|-- infrastructure/
|   |-- terraform/
|   |   |-- .terraform.lock.hcl
|   |   |-- main.tf
|   |   |-- outputs.tf
|   |   |-- terraform.tfvars.example
|   |   `-- variables.tf
|   `-- DEPLOYMENT_RUNBOOK.md
|-- packages/
|   |-- agent-core/
|   |   |-- src/
|   |   |   |-- engine.test.ts
|   |   |   |-- engine.ts
|   |   |   |-- index.ts
|   |   |   |-- planner.test.ts
|   |   |   |-- planner.ts
|   |   |   |-- template.ts
|   |   |   |-- trust-boundary.ts
|   |   |   `-- verify.ts
|   |   |-- package.json
|   |   `-- tsconfig.json
|   |-- database/
|   |   |-- migrations/
|   |   |   |-- meta/
|   |   |   |   |-- 0000_snapshot.json
|   |   |   |   |-- 0001_snapshot.json
|   |   |   |   |-- 0002_snapshot.json
|   |   |   |   |-- 0003_snapshot.json
|   |   |   |   |-- 0004_snapshot.json
|   |   |   |   |-- 0005_snapshot.json
|   |   |   |   `-- _journal.json
|   |   |   |-- 0000_empty_annihilus.sql
|   |   |   |-- 0001_heavy_raza.sql
|   |   |   |-- 0002_loving_mister_fear.sql
|   |   |   |-- 0003_slow_reptil.sql
|   |   |   |-- 0004_concerned_dreadnoughts.sql
|   |   |   `-- 0005_good_living_tribunal.sql
|   |   |-- src/
|   |   |   |-- repositories/
|   |   |   |   |-- asset-repository.ts
|   |   |   |   |-- conversation-repository.ts
|   |   |   |   |-- document-chunk-repository.ts
|   |   |   |   |-- document-repository.ts
|   |   |   |   |-- image-generation-repository.ts
|   |   |   |   |-- memory-item-repository.ts
|   |   |   |   |-- message-repository.ts
|   |   |   |   |-- task-node-repository.ts
|   |   |   |   |-- task-repository.ts
|   |   |   |   |-- task-transition-repository.ts
|   |   |   |   |-- usage-record-repository.ts
|   |   |   |   |-- video-project-repository.ts
|   |   |   |   `-- video-scene-repository.ts
|   |   |   |-- schema/
|   |   |   |   `-- index.ts
|   |   |   |-- client.test.ts
|   |   |   |-- client.ts
|   |   |   |-- index.ts
|   |   |   |-- migrate-cli.ts
|   |   |   `-- migrate.ts
|   |   |-- drizzle.config.ts
|   |   |-- package.json
|   |   `-- tsconfig.json
|   |-- embeddings/
|   |   |-- src/
|   |   |   |-- hash-embedding.test.ts
|   |   |   |-- hash-embedding.ts
|   |   |   `-- index.ts
|   |   |-- package.json
|   |   `-- tsconfig.json
|   |-- jobs/
|   |   |-- src/
|   |   |   |-- index.ts
|   |   |   |-- queue.test.ts
|   |   |   `-- queue.ts
|   |   |-- package.json
|   |   `-- tsconfig.json
|   |-- mcp/
|   |   |-- src/
|   |   |   |-- client.ts
|   |   |   `-- index.ts
|   |   |-- package.json
|   |   `-- tsconfig.json
|   |-- media/
|   |   |-- src/
|   |   |   |-- asset-store.integration.test.ts
|   |   |   |-- asset-store.ts
|   |   |   |-- gcs-asset-store.ts
|   |   |   |-- image-generation.ts
|   |   |   |-- index.ts
|   |   |   |-- video-orchestration.ts
|   |   |   |-- video-pipeline.integration.test.ts
|   |   |   |-- video-render.ts
|   |   |   `-- video-storyboard.ts
|   |   |-- package.json
|   |   `-- tsconfig.json
|   |-- model-router/
|   |   |-- src/
|   |   |   |-- cost-estimator.test.ts
|   |   |   |-- cost-estimator.ts
|   |   |   |-- index.ts
|   |   |   |-- registry.ts
|   |   |   |-- router.test.ts
|   |   |   `-- router.ts
|   |   |-- package.json
|   |   `-- tsconfig.json
|   |-- observability/
|   |   |-- src/
|   |   |   |-- index.ts
|   |   |   |-- logger.test.ts
|   |   |   |-- logger.ts
|   |   |   |-- logging.ts
|   |   |   |-- tracing.test.ts
|   |   |   `-- tracing.ts
|   |   |-- package.json
|   |   `-- tsconfig.json
|   |-- providers/
|   |   |-- image-mock/
|   |   |   |-- src/
|   |   |   |   |-- index.test.ts
|   |   |   |   `-- index.ts
|   |   |   |-- package.json
|   |   |   `-- tsconfig.json
|   |   |-- llm-anthropic/
|   |   |   |-- src/
|   |   |   |   |-- index.test.ts
|   |   |   |   `-- index.ts
|   |   |   |-- package.json
|   |   |   `-- tsconfig.json
|   |   |-- llm-google/
|   |   |   |-- src/
|   |   |   |   |-- index.test.ts
|   |   |   |   `-- index.ts
|   |   |   |-- package.json
|   |   |   `-- tsconfig.json
|   |   |-- llm-mock/
|   |   |   |-- src/
|   |   |   |   `-- index.ts
|   |   |   |-- package.json
|   |   |   `-- tsconfig.json
|   |   |-- llm-openai/
|   |   |   |-- src/
|   |   |   |   |-- index.test.ts
|   |   |   |   `-- index.ts
|   |   |   |-- package.json
|   |   |   `-- tsconfig.json
|   |   `-- video-mock/
|   |       |-- src/
|   |       |   |-- gif-encoder.test.ts
|   |       |   |-- gif-encoder.ts
|   |       |   |-- index.test.ts
|   |       |   `-- index.ts
|   |       |-- package.json
|   |       `-- tsconfig.json
|   |-- quota/
|   |   |-- src/
|   |   |   |-- index.ts
|   |   |   |-- quota-manager.test.ts
|   |   |   `-- quota-manager.ts
|   |   |-- package.json
|   |   `-- tsconfig.json
|   |-- rag/
|   |   |-- src/
|   |   |   |-- parsers/
|   |   |   |   |-- docx.test.ts
|   |   |   |   |-- docx.ts
|   |   |   |   |-- pdf.test.ts
|   |   |   |   |-- pdf.ts
|   |   |   |   |-- sniff.test.ts
|   |   |   |   |-- sniff.ts
|   |   |   |   |-- zip-fixtures.ts
|   |   |   |   |-- zip.test.ts
|   |   |   |   `-- zip.ts
|   |   |   |-- chunking.test.ts
|   |   |   |-- chunking.ts
|   |   |   |-- index.ts
|   |   |   |-- ingest.ts
|   |   |   |-- rag.integration.test.ts
|   |   |   |-- retrieve.ts
|   |   |   |-- scan.test.ts
|   |   |   |-- scan.ts
|   |   |   `-- tool.ts
|   |   |-- package.json
|   |   `-- tsconfig.json
|   |-- scanning/
|   |   |-- src/
|   |   |   |-- clamav-scanner.test.ts
|   |   |   |-- clamav-scanner.ts
|   |   |   |-- index.ts
|   |   |   `-- scanner.ts
|   |   |-- package.json
|   |   `-- tsconfig.json
|   |-- shared/
|   |   |-- src/
|   |   |   |-- chat.ts
|   |   |   |-- errors.ts
|   |   |   |-- image.ts
|   |   |   |-- index.ts
|   |   |   |-- sse.test.ts
|   |   |   |-- sse.ts
|   |   |   |-- task-graph.ts
|   |   |   |-- tools.ts
|   |   |   `-- video.ts
|   |   |-- package.json
|   |   `-- tsconfig.json
|   `-- tools/
|       |-- src/
|       |   |-- native/
|       |   |   |-- coding.ts
|       |   |   |-- filesystem.ts
|       |   |   |-- sandbox-path.test.ts
|       |   |   |-- sandbox-path.ts
|       |   |   |-- terminal.test.ts
|       |   |   `-- terminal.ts
|       |   |-- index.ts
|       |   `-- registry.ts
|       |-- package.json
|       `-- tsconfig.json
|-- .dockerignore
|-- .env.example
|-- .gitignore
|-- package-lock.json
|-- package.json
|-- PROJECT_STATUS.md
|-- README.md
|-- tsconfig.base.json
`-- tsconfig.json
```

**Note:** an empty, untracked `scripts/` directory exists at the repo root. There is no
`.gitattributes` file (this matters — see finding X-7).

### Repository facts

| Metric | Value |
|---|---|
| Tracked files | 261 |
| npm workspaces | 21 (2 apps, 13 packages, 6 providers) |
| Source lines (tracked `.ts`/`.tsx`, excluding tests) | ~9,660 |
| Test files / test blocks | 35 / 189 |
| HTTP route paths / handlers | 24 / 29 |
| Database tables / migrations | 13 / 6 |
| ADRs recorded | 44 |
| Commits | 26 |
| Node engine | `>=20` declared; v24.13.0 in use |

---

## 2. Status summary

| # | Subsystem | Status |
|---|---|---|
| 2 | Frontend | **PARTIALLY IMPLEMENTED** |
| 3 | Backend API | **PARTIALLY IMPLEMENTED** |
| 4 | Database | **IMPLEMENTED** *(contested — see note)* |
| 5 | Agent Core | **PARTIALLY IMPLEMENTED** |
| 6 | Model / Provider | **PARTIALLY IMPLEMENTED** |
| 7 | Coding Agent | **PARTIALLY IMPLEMENTED** |
| 8 | Tool System | **PARTIALLY IMPLEMENTED** |
| 9 | MCP | **PARTIALLY IMPLEMENTED** |
| 10 | Memory | **SKELETON** |
| 11 | RAG | **PARTIALLY IMPLEMENTED** |
| 12 | Image Generation | **PARTIALLY IMPLEMENTED** |
| 13 | Video Generation | **PARTIALLY IMPLEMENTED** |
| 14 | Long-Form Video | **PARTIALLY IMPLEMENTED** |
| 15 | Job / Queue | **PARTIALLY IMPLEMENTED** *(downgraded from IMPLEMENTED)* |
| 16 | Storage | **IMPLEMENTED** |
| 17 | Authentication | **MISSING** |
| 18 | Security | **PARTIALLY IMPLEMENTED** |
| 19 | Testing | **PARTIALLY IMPLEMENTED** *(downgraded from IMPLEMENTED)* |
| 20 | Deployment | **BROKEN** |

**Not on the requested list, but real shipped subsystems** (flagged by the completeness verifier):

| Subsystem | Status |
|---|---|
| Observability (logging + tracing) | **PARTIALLY IMPLEMENTED** |
| Quota / usage metering | **PARTIALLY IMPLEMENTED** |

### Contested and adjudicated statuses

- **Job / Queue — downgraded to PARTIALLY IMPLEMENTED.** The auditor rated it IMPLEMENTED by
  defining the core as "enqueue, claim, retry, backoff, crash recovery". `docs/07 §1.2` is literally
  titled *Core primitives* and names Idempotency, Cancellation, Dead-Letter Queue, Progress and
  Heartbeat alongside those; four are absent outright. Downgrade accepted.
- **Testing — downgraded to PARTIALLY IMPLEMENTED.** `docs/21 §2.9` and `§2.10` name frontend
  component tests and Playwright E2E as pyramid layers; both have zero code. Two packages
  (`packages/mcp`, `packages/providers/llm-mock`) have no test file *and no `test` script*, so
  `npm test` skips them silently. Downgrade accepted.
- **Database — kept at IMPLEMENTED, with dissent recorded.** A verifier argued for a downgrade
  because `docs/14` specifies ~22 tables and only 13 exist. I rejected that specific reasoning:
  9 of the missing tables (`users`, `sessions`, `api_keys`, `projects`, `project_members`, …) belong
  to features that do not exist, so their absence is consistent, not incomplete. The genuine
  in-scope gaps (zero indexes, zero transactions, no delete path) are recorded as limitations
  below. A reader who measures against documented scope rather than shipped scope should read this
  as PARTIALLY IMPLEMENTED.

---

## 3. Subsystem detail

### 2. Frontend — PARTIALLY IMPLEMENTED

Every screen that exists is real and wired to the live API; chat genuinely streams, and the agent
view genuinely consumes SSE. It is not IMPLEMENTED because 6 of the 14 routes in `docs/16` do not
exist, none of the three libraries that document names (TanStack Query, Tailwind, react-markdown)
is installed, and there are **zero frontend tests of any kind**.

**Files** — `apps/web/app/lib/api.ts` (the whole REST client, 24 exports), `lib/chat-stream.ts`
(hand-written SSE parser over a POST body), `lib/use-task-events.ts` (the only `EventSource` hook),
`agent/TaskDetail.tsx` (plan checklist, approve/reject card, cancel, coding tabs),
`chat/ChatView.tsx`, `tasks/page.tsx`, `files/page.tsx`, `images/page.tsx`, `videos/page.tsx`,
`videos/[id]/page.tsx`, `settings/page.tsx`, `lib/status-badge.tsx`, `globals.css` (409 lines of
hand-written CSS — the entire styling system), `layout.tsx` (6-item nav).

**APIs** — 11 Next routes: `/` (redirect to `/chat`), `/chat`, `/chat/[conversationId]`, `/tasks`,
`/agent/[id]`, `/coding/[id]`, `/images`, `/videos`, `/videos/[id]`, `/files`, `/settings`. Three
are async Server Components that fetch before render.

**Tests** — **none.** No `*.test.tsx`, no vitest/jest/playwright config, no `test` script in
`apps/web/package.json`, and no testing library installed anywhere. The 189-test suite contains
zero frontend assertions. The only browser verification on record is a one-off manual Playwright
session described in prose in ADR-031; nothing from it was committed.

**Limitations**
- No `error.tsx`, `not-found.tsx`, `loading.tsx`, or `middleware.ts` anywhere — a failed server-side
  fetch in the three Server Components surfaces as an unstyled Next error page.
- `ChatView.handleSubmit` has `try`/`finally` with **no `catch`** — a transport failure escapes as an
  unhandled promise rejection.
- Quota rejections show as a bare `Request failed (429)`; `chat-stream.ts:31-33` discards the
  explanatory JSON body.
- **The browser SSE parser splits only on `"\n\n"`** (`chat-stream.ts:48`) — the server-side parser
  was hardened to accept all three spec separators in ADR-045, but the client was not.
- `JSON.parse` is unguarded in `chat-stream.ts:54` and in four places in `use-task-events.ts`.
- No abort control: an `AbortController` is created and its signal passed down, but `.abort()` is
  never called. No SSE reconnection (`onerror` is deliberately swallowed).
- Unconditional 2-second polling on `/images`, `/videos`, `/videos/[id]`, `/files` — never backs off,
  never stops when everything is terminal.
- No state management beyond component-local `useState`; no Markdown rendering; no accessibility
  attributes; the coding "diff" is a `-`/`+` prefix on two raw strings.
- **Backend features with no UI at all:** `GET /api/v1/usage` (the entire cost/quota feature),
  `GET /api/v1/tools` and `POST /api/v1/tools/:id/enable` (the tasks page instructs the user to
  `POST` by hand, as literal text in a `<code>` block).

---

### 3. Backend API — PARTIALLY IMPLEMENTED

A real Fastify app: 29 handlers with real persistence, Zod validation on the four heavyweight
routes, real per-route rate limits (proven by a 429 assertion at the HTTP layer), a central typed
error mapper, a real `ROLE` split, and graceful shutdown.

**APIs** — 24 paths / 29 handlers. Highlights with their real status codes:
`GET /api/health` · `POST /api/v1/chat` (SSE, 400/429 quota/429 rate) ·
`GET /api/v1/conversations`, `/:id/messages` · `POST|GET /api/v1/agent/tasks`, `GET /:id`,
`GET /:id/events` (SSE), `POST /:id/approve|reject|cancel` · `GET /api/v1/tools`,
`POST /api/v1/tools/:id/enable` · `POST|GET /api/v1/files`, `GET /:id`, `POST /files/upload`
(400/413/503) · `GET|POST /api/v1/memory`, `DELETE /:id` · `POST|GET /api/v1/images`, `GET /:id` ·
`GET /api/v1/assets/:id` · `POST|GET /api/v1/videos`, `GET /:id`, `POST /:id/retry` ·
`GET /api/v1/usage`.

**Tests** — 41 across 6 files, all driving a real `buildServer()` app via `app.inject()`:
`rag.test.ts` (16), `images.test.ts` (6), `usage.test.ts` (5), `agent.test.ts` (5),
`config.test.ts` (6), `role.test.ts` (3).

**Limitations**
- **No authentication on any route** (see §17).
- Ten route groups documented in `docs/15` have no code: `/api/v1/auth`, `/api-keys`, `/jobs`,
  `/projects`, `/models`, `/providers`, `/mcp`, `/admin/*`.
- Zod validates only 4 of the 12 body-taking routes; the rest use hand-rolled truthiness checks.
- `agent.ts:66,76` destructure `request.body` with no null guard — a literal `null` body yields a
  500 instead of a 400.
- Rate limiting is in-memory, keyed on `request.ip`, with **no `trustProxy`** — behind Cloud Run's
  front end every client shares one bucket.
- `POST /api/v1/chat` registers no client-disconnect handler and no abort signal reaches the
  provider — an aborted client still drives the stream to completion and still records usage.
- `GET /api/health` returns a hardcoded literal; it never touches the database or queue, so a health
  check passes against a dead or unmigrated database.
- Graceful shutdown is installed only *after* `app.listen()` — a SIGTERM during boot exits without
  closing PGlite, the exact failure that handler exists to prevent.
- The error body's `requestId` is a fresh UUID per error, not Fastify's `request.id` used everywhere
  else, so errors cannot be correlated with request logs by id. No `x-request-id` header is ever set.

---

### 4. Database — IMPLEMENTED *(contested)*

Real drizzle-kit-generated Postgres schema, 13 repositories of real query-builder code, migrations
applied on every boot, and real pgvector `<=>` cosine search exercised by an integration test
against genuine embedded Postgres.

**Files** — `packages/database/src/schema/index.ts` (13 tables), `client.ts` (PGlite + node-postgres
branches), `migrate.ts`, `migrate-cli.ts`, 13 repositories, 6 migrations.

**Tables** — `conversations`, `messages`, `tasks`, `task_nodes`, `task_transitions`, `documents`,
`document_chunks`, `memory_items`, `assets`, `image_generations`, `video_projects`, `video_scenes`,
`usage_records`.

**APIs** — `createDb()`, `createPostgresDb()`, `runMigrations()`, `runPostgresMigrations()`,
`DrizzleDb` (the dialect-agnostic type every repository accepts), 13 repository interfaces +
`Pg*` implementations, `npm run db:generate` / `db:migrate`.

**Tests** — `client.test.ts` (3; two assert a *real* node-postgres connection attempt failing with
`ECONNREFUSED`/`ENOTFOUND`), plus heavy transitive coverage: `rag.integration.test.ts` (real pgvector
ranking), `engine.test.ts` (12), `quota-manager.test.ts` (7), and all 32 API route tests run against
real in-memory PGlite. **No `*-repository.test.ts` exists** — repository correctness is only ever
covered transitively.

**Limitations**
- **Zero transactions anywhere** — `grep '\.transaction('` returns nothing. Document ingestion writes
  the row, then N chunk rows, then the status update, non-atomically.
- **Zero secondary indexes** — no `CREATE INDEX` in any migration and no `index()` in the schema.
  `document_chunks.document_id`, `messages.conversation_id`, `video_scenes.project_id` are all
  unindexed, and the vector column has no ANN (HNSW/IVFFlat) index, so every RAG search is a full scan.
- The real-standalone-Postgres path has **never successfully executed a statement** against a real
  server; only the connection-failure path is proven.
- In-memory full-table scans stand in for SQL in `listNonTerminal()`, `listInFlight()`, and
  `countImagesSince()`.
- No cascade deletes; `DocumentRepository` has no `delete()` at all, so a document row can never be
  removed. `deleteByDocument` exists but is never called — dead code.
- `image_generations.result_asset_id`, `video_scenes.asset_id`, `video_projects.render_asset_id` are
  plain text with **no FK**, so they can dangle silently (`documents.asset_id` *is* a real FK).
- `PgVideoSceneRepository.updateStatus()` increments `retryCount` read-then-write — a lost update
  under concurrency.
- All timestamps are `timestamp` **without** time zone — safe under PGlite, driver/local-time
  dependent on a real server, which would affect quota day/month windows.
- `memory_items` has **no embedding column** — there is no vector search over memory.
- pg-boss's job tables are outside this schema entirely; `drizzle-kit` will never see them.
- Embedding dimensionality is hardcoded `vector(256)`; any real embedding model needs a migration
  and a full re-embed.

---

### 5. Agent Core — PARTIALLY IMPLEMENTED

Tasks genuinely execute end to end against real Postgres with real repositories, real tool side
effects on disk, real crash-recovery reconciliation, and 18 automated tests.

**APIs** — `AgentEngine` (`createAndStart`, `approve`, `reject`, `cancel`, `resumeAll`, `subscribe`),
`ModelCallMeter`, `AgentEngineDeps`, `planTask()`, `resolveNodeInput()`, `verifyNodeOutput()`,
`wrapUntrustedContent()`, plus the 8 agent HTTP routes.

**Tests** — `engine.test.ts` (12, all against real PGlite with real repositories, a real
`ToolRegistry`, real sandboxed filesystem tools, and crash-recovery scans), `planner.test.ts` (6,
four of which assert the trust boundary), `agent.test.ts` (5 over HTTP, including a real
approve-then-file-actually-deleted assertion).

**Limitations**
- **Only `atomic` nodes are ever produced, and the dispatcher never reads `node.type` at all** —
  it branches solely on `node.kind`. So `sequential_group`, `parallel_group`, `conditional`, `loop`,
  and `sub_agent` are not merely "not executed": a node of those types would be silently run as an
  atomic node rather than rejected.
- **The planner is fully deterministic** — `planTask` is a bare `switch` over 6 task types; there is
  no LLM call in `planner.ts`. This is a documented decision (ADR-018), not an accident.
- **Retry has no backoff.** `backoff` is written by the planner, persisted, and never read; the
  recursive tick re-dispatches immediately.
- Node `timeoutMs` is set on all 10 planner nodes and **never read by the engine**.
- 3 of 13 declared task states and 3 of 14 declared node statuses are never written. The
  `{type:"transition"}` SSE event variant is never emitted.
- `schema_check` verifies key *presence* only — not type or shape. `deterministic_compare` with an
  empty spec returns `pass: true`. Three of six verification methods throw explicitly rather than
  silently passing (a good design).
- Parallel dispatch is implemented (`Promise.all`) but never exercised — every planner shape is a
  strictly linear chain.
- Concurrency control is an in-memory per-task promise chain, so **two API instances against one
  shared Postgres would both dispatch the same task**.
- `ModelCallMeter` covers `model_call` nodes only — `tool_call` nodes are never metered.
- Latent bug: if two approval-required nodes became ready in the same tick, approving one would not
  pick up the other. Not reachable with today's linear plans.

---

### 6. Model / Provider — PARTIALLY IMPLEMENTED

Three raw-`fetch` adapters constructing correct requests against the real Anthropic/OpenAI/Gemini
endpoints, a working registry, a commit-on-first-event fallback chain, and a real dated pricing table.

**APIs** — `ModelRegistry` (`register`/`get`/`getDefault`/`list`), `ModelRouter.streamChat(request,
callOptions)`, `StreamChatOptions.onFallback`, `ProviderFallback`, `estimateLlmCostUsd()`,
`estimatePromptTokens()`, `AnthropicProvider`, `OpenAIProvider`, `GoogleProvider`, `MockLLMProvider`,
`parseSseStream()`. **No HTTP route** — there is no `/api/v1/providers` or `/api/v1/models`.

**Tests** — `router.test.ts` (7, scripted fakes), `cost-estimator.test.ts` (9),
`llm-anthropic` (3), `llm-openai` (3), `llm-google` (8), `sse.test.ts` (7).
**`packages/providers/llm-mock` has no tests and no `test` script** — `MockLLMProvider`, including
its ADR-013 production guard, has zero coverage. `apps/api/src/index.ts` has no test either, so the
provider-registration branches are only ever verified by live boots.

**Limitations**
- **No real provider call has ever succeeded.** Every adapter is verified only against hand-written
  fixtures plus a live endpoint reached with a deliberately invalid key returning a correctly-shaped
  error.
- `docs/12`'s CapabilityRegistry does not exist — `registry.ts` is a bare `Map`. No model scoring, no
  task-type routing, no structured-output hard filter.
- **No retry and no backoff anywhere in the router** — a transient 429 or 503 immediately falls back
  or fails; `Retry-After` is never read.
- **ADR-045's "an empty answer must not look like a success" hardening was applied to Google only.**
  Anthropic and OpenAI still yield a `done` event with empty content and zero tokens.
- `router.ts:85`'s `if (first.done) continue;` skips a silent provider **without** calling
  `report()` — a hole in ADR-044's "a fallback is REPORTED, never silent" claim.
- The model per provider is effectively hardcoded: the `model` option exists but the composition root
  never passes it, and no env var sets it.
- `provider`/`model` on the chat schema are unvalidated free-form strings.
- Anthropic's `max_tokens` is hardcoded to 4096 and `stop_reason` is never read, so a truncated answer
  is indistinguishable from a complete one.
- The pricing table covers exactly 3 model ids, is static, and is dated 2026-08-31/09-02.

---

### 7. Coding Agent — PARTIALLY IMPLEMENTED

Real: `terminal.run_command` spawns a real child process and captures real exit code and stdout;
`code.apply_literal_fix` really rewrites a file on disk; the four-node plan really re-runs the test
and gates on `exitCode === 0`. **The "agent" half is absent by design.**

**APIs** — `createCodingTools()`, `createTerminalTools()`, tools `code.parse_fix_directive`,
`code.apply_literal_fix`, `terminal.run_command`, task type `fix_failing_test`. No dedicated HTTP
route — driven through `POST /api/v1/agent/tasks`.

**Tests** — `terminal.test.ts` (7, including the real `--eval=` exploit rejection).
**`coding.ts` has no test file, and no test anywhere exercises the coding agent end to end** —
grepping every test for `fix_failing_test`, `parse_fix_directive`, or `apply_literal_fix` returns
zero matches. The only evidence is a manual run recorded in prose in `PROJECT_STATUS.md`, and the
fixture it used (`data/sandbox/coding-demo/`) **no longer exists in the working tree**.

**Limitations**
- **The fix is not reasoned — it is dictated by a directive the failing test prints about itself:**
  `/FIX_NEEDED path=(\S+) find=(\S+) replace=(\S+)/`. No model is consulted at any point.
- `(\S+)` means find/replace cannot contain whitespace; `String.replace` with a string pattern
  replaces only the **first** occurrence in **one** file per run.
- Path-base mismatch: the fix resolves against `SANDBOX_ROOT` while the test ran with `cwd = testDir`.
- **Zero human approval on the whole pipeline** — all three tools are `read_only`/`write_local`, and
  `write_local` defaults to `requiresApproval: "never"`.
- No repository search capability at all (no grep/glob/symbol tool), so FR-010's "where is X defined"
  is unmet.
- **The spawned child is never killed on timeout** — the 30s bound only rejects the promise; a runaway
  `node` process outlives its own task.
- **No environment scrubbing:** `spawn(..., { cwd, shell: false })` with no `env`, so the child
  inherits the API process's full environment — provider API keys, `DATABASE_URL`, everything.
- Only `node` is allow-listed, and any argument starting with `-` is rejected outright.

---

### 8. Tool System — PARTIALLY IMPLEMENTED

A real registry with a real permission-tier table, real sandboxed native tools, a real approval gate
proven by both engine and HTTP tests, and a real path-containment function with a regression suite.

**APIs** — `ToolRegistry` (`register`/`get`/`list`/`setEnabled`/`call`), `createFilesystemTools`,
`createTerminalTools`, `createCodingTools`, `createRagTools`, `GET /api/v1/tools`,
`POST /api/v1/tools/:id/enable`. Registered ids: `fs.read_file`, `fs.list_directory`,
`fs.write_file`, `fs.delete_file`, `terminal.run_command`, `code.parse_fix_directive`,
`code.apply_literal_fix`, `rag.search_documents`.

**Tests** — `sandbox-path.test.ts` (6), `terminal.test.ts` (7), plus the approval gate in
`engine.test.ts` and `agent.test.ts`. **No test for `registry.ts` itself** — `setEnabled`, the
disabled-tool rejection, the timeout path, and the unknown-tool path are all uncovered.

**Limitations**
- **The model is never given tools.** There is no `ToolDefinition` → provider-schema adapter and no
  `tool_use` parsing anywhere — tools are invoked only by the deterministic planner's graph.
- **`inputSchema` is decorative** — `ToolRegistry.call` never validates args against it.
- `retryPolicy.backoff` is stored, propagated, persisted, and never applied.
- `requiresApproval` collapses from a 4-value enum to a boolean (`!== "never"`), so `first_use` and
  `risk_threshold` have no distinct behaviour.
- The registry's own docstring claims it is "the one enforcement point for the permission gate"; the
  code checks only `enabled`. The gate actually lives in the engine.
- **Enable/disable state is process memory only** — no `tools` table; every restart re-registers
  native tools enabled and MCP tools disabled, discarding operator decisions.
- **Sandbox containment is lexical only** — `resolve()` + `startsWith`, never `realpath`. A symlink
  inside the sandbox pointing outside it passes the check.
- A tool timeout rejects the promise but never kills the work.
- `register()` is a bare `Map.set` — a second registration of the same id silently replaces the first.

---

### 9. MCP — PARTIALLY IMPLEMENTED

A real MCP client using the official SDK, spawning the real `@modelcontextprotocol/server-filesystem`
binary as a genuine subprocess over stdio, doing a real `tools/list` discovery.

**APIs** — `connectMcpServer(registry, config)`, `McpServerConfig`, `McpConnection`. Discovered tools
register as `mcp.<serverId>.<toolName>`.

**Tests** — **none.** `packages/mcp` has no test file *and no `test` script*, so `npm test` skips it
entirely. No test asserts the disabled-by-default behaviour that is MCP's entire safety net.

**Limitations**
- Stdio transport only; exactly one hardcoded server in the composition root.
- **The subprocess is not sandboxed** — same OS user, no container, no seccomp (a tracked risk).
- **MCP tool arguments never pass through `resolveSandboxedPath`** — containment rests entirely on
  the external server's own allow-list.
- The trust heuristic is three regexes on the tool *name*.
- **The `McpConnection` is discarded** — `mcp.close()` is never called; shutdown closes only the app,
  queue, and database.
- No reconnection or health monitoring; if the server dies, enabled MCP tools silently start failing.
- Only `tools/list` and `tools/call` are used — no resources, prompts, sampling, or
  `list_changed` handling.
- **Planning is coupled to a successful connection**: `planner.ts:50` hardcodes
  `mcp.reference-filesystem.read_text_file` and throws if absent, immediately failing the task.
- The MCP block logs via bare `console.log`/`console.warn` rather than the structured logger.

---

### 10. Memory — SKELETON

A real table, a real repository, three real HTTP routes and a real settings UI genuinely persist,
list, and delete rows. **The behaviour a memory subsystem exists to provide is entirely absent.**

**APIs** — `GET /api/v1/memory`, `POST /api/v1/memory`, `DELETE /api/v1/memory/:id`,
`MemoryItemRepository` (`create`/`listByOwner`/`delete`).

**Tests** — 3, inside `rag.test.ts`; they assert CRUD plumbing and CORS/Content-Type, not memory
semantics.

**Limitations**
- **Nothing reads memory into a prompt.** A repo-wide grep shows the only readers of memory items are
  the three route handlers themselves and the DI wiring. No memory item is ever embedded, retrieved
  by relevance, or injected into any model call.
- No embedding column and no similarity retrieval; `docs/08 §6`'s entire embedding design is unbuilt.
- `scope` is stored but never used — `listByOwner` selects on owner alone and returns every scope.
  It is also unvalidated, so any string is accepted.
- `ownerId` is the literal `"local-user"` because no auth exists.
- No update path; FR-030 (conversation summarization) is entirely absent.
- Of `docs/08`'s six memory levels, one undifferentiated table exists.
- `DELETE` returns `{ok:true}` for a nonexistent id.

---

### 11. RAG — PARTIALLY IMPLEMENTED

A genuinely working end-to-end core with no mocks in it: two ingestion ingresses, real PDF
(`pdfjs-dist`) and real DOCX (hand-rolled ZIP + WordprocessingML) extraction, real chunking, real
deterministic embeddings, a real pgvector cosine query, exposure as a real agent tool, and a real
clamd malware gate.

**APIs** — `POST /api/v1/files` (path-based), `POST /api/v1/files/upload` (multipart),
`GET /api/v1/files`, `GET /api/v1/files/:id`, agent tool `rag.search_documents`,
`DocumentChunkRepository.search()`.

**Tests** — ~44 across 9 files: `rag.integration.test.ts` (2, real pgvector ranking with strictly
ascending distances), `rag.test.ts` (16), `scan.test.ts` (4), `pdf.test.ts` (3, a real byte-correct
minimal PDF with computed xref offsets), `docx.test.ts` (6), `zip.test.ts` (5), `sniff.test.ts` (5),
`chunking.test.ts` (3), `hash-embedding.test.ts` (3).

**Limitations**
- **The embedding is deterministic feature hashing, not a learned semantic model.** It captures
  lexical overlap only — a question phrased differently from the source retrieves nothing. This is a
  documented decision (ADR-026), and it is the single biggest constraint on answer quality.
- The signed part of the hashing trick is effectively dead: with a power-of-two dimension,
  `bucket = h % dimensions` and `sign = h & 1` are correlated, so the sign never varies independently.
- **No ANN index on the vector column** — every search is a full scan.
- **Retrieval has no filter of any kind**: no document scoping, no ACL, no distance threshold. A query
  with zero overlap still returns the top-K.
- **Citations do not resolve to a source** — `[1] <chunk text>` is a positional marker; `documentId`
  and `chunkIndex` exist in the results array but are never interpolated into the prompt, so FR-031's
  acceptance criterion is unmet.
- Chunking is character-count paragraph packing (500/50), not `docs/09`'s ~512-token
  structural-then-sentence strategy; an oversized paragraph becomes one oversized chunk.
- No hybrid/BM25 search, no reranking, no OCR (an image-only PDF fails with an explicit message).
- **Documents can never be deleted or cleanly re-ingested** — no DELETE route, and `deleteByDocument`
  is never called.
- **The path-based route bypasses every upload control** — no allow-list, no sniff, no malware scan.
- Malware scanning is fail-open by default (durably marked `skipped_no_scanner`); `UPLOAD_SCAN_REQUIRED`
  flips it to fail-closed.
- The agent tool handler and the full `answer_from_documents` path have no automated coverage.

---

### 12. Image Generation — PARTIALLY IMPLEMENTED

The pipeline is entirely real — route → quota → row → pg-boss job → provider → AssetStore → serve —
but **no image is ever generated**.

**APIs** — `POST /api/v1/images`, `GET /api/v1/images`, `GET /api/v1/images/:id`,
`GET /api/v1/assets/:id`, `MockImageProvider`, `processImageGeneration()`.

**Tests** — `image-mock/index.test.ts` (4, asserting real dimensions, mime, and `<svg` in the stored
bytes), `images.test.ts` (6, including a real rate-limit test). **`processImageGeneration` has no
test** — the test harness deliberately registers no workers.

**Limitations**
- **No real image provider exists anywhere** — not even a skeleton adapter. Output is always an SVG
  placard reading "MOCK IMAGE — not a real generation". *(Independently confirmed: the SVG is real,
  valid, browser-openable markup, not opaque placeholder bytes.)*
- `negativePrompt` is advertised as supported and passed in, but the renderer never reads it.
  `quality` is accepted and only echoed into metadata.
- `maxImagesPerCall` is 1 and only `images[0]` is stored — batch generation is unsupported end to end.
- No retry or delete path; a failed generation is terminal.
- In production the whole capability is absent by design (503) — see §20.
- Cost is never estimated for images (`estimatedCostUsd: null`).

---

### 13. Video Generation — PARTIALLY IMPLEMENTED

**APIs** — `MockVideoProvider.generateVideo()`, `encodeGif()`/`decodeGif()`. **No HTTP route
generates a single clip** — the only path is through the long-form project pipeline.

**Tests** — `gif-encoder.test.ts` (4, a real encode→decode round-trip comparing every pixel index),
`index.test.ts` (4).

**Limitations**
- Output is an **animated GIF, not video** — `image/gif`, 160×90, 6fps, hard 8-second ceiling.
- **No real video provider exists** anywhere in the repo.
- *(Independently confirmed: `gif-encoder.ts` is a genuine 351-line GIF89a encoder — real header,
  logical screen descriptor, global colour table, and a spec-valid LZW code stream — plus a
  general-purpose LZW decoder, so the round-trip test is not self-confirming. It deliberately skips
  dictionary compression, emitting a Clear Code per pixel.)*
- Prompt text is never rendered into the pixels — two prompts differ only in palette hue.
- **Capability is not enforced at the API boundary**: the schema allows `sceneClipSeconds` up to 30
  while the provider ceiling is 8.
- The "determinism" test asserts only that metadata matches; the encoded buffers are discarded.
- `encodeGif`/`decodeGif` are not exported from the package entry point.

---

### 14. Long-Form Video — PARTIALLY IMPLEMENTED

The best-tested of the three media subsystems: deterministic scene decomposition, per-scene pg-boss
jobs with bounded concurrency, real status reconciliation, and **resumability proven against real
PGlite and real pg-boss**.

**APIs** — `POST /api/v1/videos`, `GET /api/v1/videos`, `GET /api/v1/videos/:id`,
`POST /api/v1/videos/:id/retry`, queues `video.generate_scene` (retryLimit 1, expire 60s,
localConcurrency 3) and `video.render` (retryLimit 1, expire 300s), `planScenes()`,
`orchestrateVideoProject()`, `processVideoScene()`, `processVideoRender()`.

**Tests** — `video-pipeline.integration.test.ts` (2, real Postgres + real queue + a `FlakyVideoProvider`
proving per-scene resumability). **`processVideoRender` has no test at all**; neither does the create
route or the retry route.

**Limitations**
- **The ffmpeg assembly stage has never executed.** *(Independently confirmed: `spawn` with argument
  arrays and `shell: false` — a real invocation; and no ffmpeg is on PATH here, so only the
  `skipped_no_ffmpeg` branch has ever run. The function's own docblock says so.)*
- `succeededScenes.length === allScenes.length ? "succeeded" : "partially_succeeded"` is dead code —
  render is only ever enqueued from the all-succeeded branch.
- **Duplicate render jobs are possible** — `checkProjectCompletion` enqueues with no `singletonKey`
  and is called by every settling scene under concurrency 3.
- **Retry on an already-succeeded project** re-runs orchestration and enqueues another render;
  retry also re-enqueues `pending` scenes, causing duplicate provider calls and duplicate usage rows.
- **The retry route has no `mediaGenerationAvailable` guard**, unlike the create route — in production
  it would enqueue jobs no worker will ever pick up.
- The `video.render` worker is registered unconditionally, including in production — inconsistent with
  the image/scene worker gates.
- `retry_count` is incremented and never read; no cap, no orchestration-layer backoff.
- Scene descriptions are a template with an index prefix — no script stage, no cross-scene consistency.
- No audio, music, subtitles, or timeline. Capped at 30 minutes by the API schema.

---

### 15. Job / Queue — PARTIALLY IMPLEMENTED *(downgraded)*

Real pg-boss 12.29.0 against real Postgres — embedded PGlite locally via pg-boss's own `fromPglite`
adapter, a connection string against a standalone server — with five real queues, real retry/backoff/
expiry policies, real worker registrations, and real role gating.

**APIs** — `JobQueue.start/stop/ensureQueue/enqueue/registerWorker/getJob`, `fromPglite`,
`roleRuns(role)`. Queues: `document.ingest` (retryLimit 2, expire 120s), `document.scan`,
`image.generate`, `video.generate_scene` (localConcurrency 3), `video.render`.

**Tests** — `queue.test.ts` (4, real integration against real in-memory PGlite),
`role.test.ts` (3), `video-pipeline.integration.test.ts` (2), `scan.test.ts` (4).

**Limitations**
- **`stop()` is not graceful** — hardcoded `stop({ graceful: false })`, which skips the pending-cleanup
  wait. In-flight jobs are killed rather than drained; recovery depends on queue expiry.
- **No dead-letter queue exists.** The wrapper's own comment claims a job "eventually dead-letters",
  but no `ensureQueue` call passes `deadLetter`.
- **Idempotency is supported, tested, and used by nothing.** The test proving `singletonKey` works
  uses `policy: "exclusive"`; **no production queue sets a policy**, so pg-boss's default `standard`
  policy ignores it.
- A job whose worker is not registered in this process sits in `created` indefinitely — not detected,
  rejected, or dead-lettered. No `retentionSeconds` is set, so the 14-day default applies.
- **In production the image and video workers are never registered** (see §20).
- The `"job workers registered"` boot log is a hardcoded array — it omits `document.scan` and still
  lists `image.generate`/`video.generate_scene` in production where they are not registered.
- No job-level cancellation and no job-status API.
- **No test exercises the production queue configuration** — the harness ensures all five queues with
  no retry/expiry options at all.
- The api+worker split has never run concurrently against one database.

---

### 16. Storage — IMPLEMENTED

Both `AssetStore` implementations are real, non-trivial code; both are selected by a real config
branch at boot; every producer and consumer goes through the interface; and the GCS implementation is
round-tripped **byte-for-byte against a real emulator through the real client**, including the exact
production constructor path.

**APIs** — `AssetStore` (`store`/`read`/`delete`), `LocalAssetStore`, `CloudStorageAssetStore`,
`parseGsUri()`, `GET /api/v1/assets/:id`, `POST /api/v1/files/upload`; env `ASSETS_ROOT`,
`ASSETS_BUCKET`, `GCS_API_ENDPOINT`.

**Tests** — `asset-store.integration.test.ts` (7, of which **only 3 run unconditionally**; 4 require
`FAKE_GCS_SERVER_BIN`), `scan.test.ts` (4, exercising real delete), `video-pipeline.integration.test.ts`
(2), plus the rename-on-upload assertion in `rag.test.ts`.

**Limitations**
- **`CloudStorageAssetStore` has never touched real Google Cloud Storage.** The no-argument
  `new Storage()` branch — Application Default Credentials, the exact path production uses — is the
  one path no test exercises.
- The GCS suite needs an external 35 MB binary; on a default checkout 4 of 7 tests skip (loudly).
- `LocalAssetStore` records an **absolute** path — changing `ASSETS_ROOT` or remounting breaks every
  pre-existing row's `read()` with `ENOENT`.
- The two stores lay out objects differently: local is flat `${id}.${ext}`; GCS is `${kind}/${id}.${ext}`.
- **Everything is fully buffered in memory** — no streaming, no HTTP Range, no `Cache-Control`/`ETag`.
- No signed URLs — every byte is proxied through the API container.
- **`GET /api/v1/assets/:id` is completely unauthenticated**; knowing a UUID is sufficient.
- `video-render.ts:72` parses `asset.storagePath` directly, violating the interface's own stated rule.
- Checksums are written at store time and never re-verified on read.
- `assets.size_bytes` is a 4-byte integer, capping an asset at ~2 GB.
- `SANDBOX_ROOT` is **not** behind `AssetStore` — still genuine local disk.

---

### 17. Authentication — MISSING

Not SKELETON: there is no scaffolding to be a skeleton of.

**Evidence** — no Fastify auth hooks anywhere; no auth plugin or dependency in
`apps/api/package.json`; no `AuthProvider` type; no `packages/security` directory; no `users`,
`sessions`, or `api_keys` tables; no password hashing, session store, cookie signing, CSRF token,
API-key hashing, or role model in any form.

**APIs** — none.

**Tests** — none. No test sends a credential or asserts a 401/403.
`packages/shared/src/errors.ts` defines a `PermissionError` (403) that **nothing ever throws** — dead
code for a layer never built.

**Limitations**
- **Every route is fully public**, including chat (which spends real provider tokens once a key is
  set), agent task creation (which executes sandboxed filesystem/terminal tools), file upload, memory
  CRUD, and asset download. The only inbound controls are rate limits and the malware gate.
- No per-user, per-project, or per-tenant boundary anywhere. The owner id is the hardcoded
  `"local-user"`, and every list endpoint returns the whole table.
- **The approval actor is an unauthenticated, unvalidated client-supplied string** persisted as the
  human-in-the-loop audit record — the gate records who *claimed* to approve, not who did.
- The Terraform grants `allUsers` `roles/run.invoker` on the API service, so the intended deployment
  posture is a fully public, unauthenticated API. That IaC has never been applied, so nothing is
  currently exposed — the exposure is planned, not live.

---

### 18. Security — PARTIALLY IMPLEMENTED

A genuine, working set of controls: Zod-validated config and bodies, global + per-route rate limiting,
a central error handler that never leaks internals, a lexical sandbox boundary, a command allow-list
with a real argument-injection fix, the full `docs/13 §12` upload chain, and a real clamd INSTREAM
client.

**Tests** — the densest security coverage in the repo: `terminal.test.ts` (7, incl. the real `--eval=`
exploit and traversal in both script arguments), `sandbox-path.test.ts` (6, incl. the `<root>-evil`
prefix-sibling false positive), `rag.test.ts` (16 upload-control tests), `clamav-scanner.test.ts` (7,
five against a **real spawned clamd** with a self-written EICAR signature DB), `planner.test.ts` (6
trust-boundary tests), `engine.test.ts` (approval gate), `logger.test.ts` (4 redaction tests incl. a
negative case), `images.test.ts` (a real 429 rate-limit assertion), `config.test.ts` (6 secret-handling
tests).

**Limitations**
- **No authentication** — every control below is enforced against an anonymous caller.
- **No OS-level sandbox isolation**, contrary to `docs/13 §6`'s microVM/gVisor requirement. Commands
  run as a child of the API process with **the parent's full environment** (provider keys included)
  and full network access.
- **Sandbox containment is lexical** — no `realpath`, so a symlink escapes.
- **Command execution requires no human approval** (`write_local` ⇒ `requiresApproval: "never"`).
- Of `docs/13 §9.2`'s six prompt-injection measures only structural delimiting is built; there is no
  provenance tracking at all.
- **No HTTP security headers whatsoever** — no helmet, no CSP, no `X-Content-Type-Options`. The asset
  route serves stored bytes with a stored content-type.
- **`POST /api/v1/chat` has no per-route rate limit** — the endpoint that spends real tokens is the
  one with only the global 300/min, while images (10/min), videos (5/min), tasks (30/min) and uploads
  (10/min) are all tighter.
- Rate limiting is in-memory and per-IP with no `trustProxy`; the deployed config runs up to 3 instances.
- `POST /api/v1/memory` has no Zod schema and writes an unvalidated `scope`.
- Secrets reach the process as environment variables; `docs/13 §3` explicitly prefers the Secret
  Manager client library.
- The error handler itself has **no test** — nothing asserts a 500 body omits stack traces.

---

### 19. Testing — PARTIALLY IMPLEMENTED *(downgraded)*

Real and substantial for its backend scope: **189 blocks across 35 files**, dominated by genuine
integration tests against real in-memory Postgres, real pg-boss, real multipart HTTP through Fastify
`inject()`, a real spawned clamd, and a real fake-gcs-server. Very few mocks; no paid-API calls.

**Per package** — `apps/api` 6 files/41 · `packages/rag` 7/32 · `agent-core` 2/18 · `model-router` 2/16 ·
`providers/*` 6/26 · `media` 2/9 · `scanning` 1/7 · `quota` 1/7 · `shared` 1/7 · `tools` 2/13 ·
`observability` 2/7 · `jobs` 1/4 · `database` 1/3 · `embeddings` 1/3.

**Limitations**
- **Zero frontend tests, zero E2E tests** — `docs/21 §2.9` and `§2.10` describe both layers; neither
  has any code. No Testing Library, no jsdom, no Playwright installed.
- **Two packages have no test file *and* no `test` script**, so `npm test` skips them silently:
  `packages/mcp` (including the security-relevant disabled-by-default default) and
  `packages/providers/llm-mock` (including the ADR-013 production guard).
- **The coding agent has zero automated coverage** — the highest-risk code path in the repo.
- **9 of 189 tests are environment-gated** (5 clamd + 4 GCS) and skip without external binaries, so a
  default checkout runs 180.
- `packages/database` has 18 source files and 3 tests, all about connection establishment.
- No test covers `error-handler.ts`, `video-render.ts`, `processImageGeneration`, the SSE task-event
  endpoint, the `DATABASE_URL` path beyond a connection error, or real GCS.
- No coverage tooling is installed anywhere.
- **CI has never executed** — `git remote -v` is empty and the workflow's own header says so.

---

### 20. Deployment — BROKEN

The artifacts are real and substantive — but **the configuration as committed cannot stand the
platform up.** This is a deterministic boot failure traced line by line, not a risk.

**Files** — `apps/api/Dockerfile`, `apps/web/Dockerfile`, `.dockerignore`,
`infrastructure/terraform/{main.tf,variables.tf,outputs.tf,terraform.tfvars.example}`,
`infrastructure/DEPLOYMENT_RUNBOOK.md`, `.github/workflows/ci.yml`.

**Tests** — none. No test builds an image, renders Terraform, or asserts anything about deployment.
CI contains no `terraform validate`, no `docker build`, and no deploy job.

#### The blocker

1. `apps/api/Dockerfile:36` sets `ENV NODE_ENV=production`.
2. `main.tf:447` gives the **worker pool** that same `var.api_image`.
3. `main.tf:454-480` sets `ROLE`, `ASSETS_BUCKET`, `DATABASE_URL`, `CLAMD_HOST` — and
   **deliberately sets no LLM key** (`main.tf:453`: *"No LLM provider keys here on purpose"*).
4. `apps/api/src/index.ts:130-136` throws whenever `NODE_ENV === "production"` and no provider key is
   present.

⇒ **The worker pool crash-loops on every boot.** And because the API service's keys come from
*dynamic* blocks that emit nothing when the variables are blank — which is exactly what
`terraform.tfvars.example:14` and `variables.tf:38` tell the operator to do ("leave blank to deploy on
the mock LLM provider, same as local dev") — **the API service crash-loops too in the documented
default configuration.**

> **This is a regression from work committed earlier in this same session.** ADR-045 correctly
> identified that the old code constructed the mock provider unconditionally and therefore could never
> boot under `NODE_ENV=production`. Its fix made *API-with-a-key* boot — but left the worker pool,
> which by design never receives a key, failing on the very same line, and left the documented
> no-key configuration failing for both units. The ADR's live verification exercised
> `node dist/index.js` with a key present and did not test the keyless or worker configuration.

**Other limitations**
- **Terraform has no backend block** — state defaults to a local file that would contain
  `var.db_password` and the composed `DATABASE_URL` in plaintext.
- Only the sidecar container carries a `name`; the app container has none, which Cloud Run's
  multi-container API may reject (unverified).
- The web image needs `NEXT_PUBLIC_API_URL` baked in at build time, pointing at a URL that only exists
  after apply — a two-pass bootstrap Terraform cannot express (the runbook documents the manual dance).
- `POST /api/v1/videos/:id/retry` has no production guard and would enqueue jobs no worker will run.
- No CI/CD: no image build, no terraform check, no deploy job. `infrastructure/docker/` is empty.
- Cost: the Cloud SQL instance and the worker pool are both always-on (worker pools cannot scale to
  zero); the clamd sidecar reserves 3 GiB.
- **Never verified:** `docker build` (no Docker present), `terraform apply` (no GCP project), CI (no
  remote). What *was* verified: `terraform init` (a real lock file with provider hashes) and
  `terraform validate`/`plan` against a fake project id.

---

### Addendum — two subsystems not on the requested list

**Observability — PARTIALLY IMPLEMENTED.** `packages/observability` (5 source files, 7 tests) builds a
genuine `NodeTracerProvider` with an AsyncLocalStorage context manager, and real structured Pino
logging with tested redaction. **But three of the five spans its own docstring promises
(`agent.run`, `agent.step`, `tool.call`) are never created in production code** — only `gen_ai.chat`
and job spans exist. `LOG_LEVEL` is read directly via `process.env`, escaping the config module's
"single point of env loading" guarantee. There is no metrics pipeline and no exporter configured.

**Quota / usage metering — PARTIALLY IMPLEMENTED.** `packages/quota` (7 tests) is genuinely wired at
every spending point: chat, images, videos, and — since ADR-046 — agent-task model calls via
`ModelCallMeter`. Spend persists to `usage_records` and surfaces at `GET /api/v1/usage`. Gaps:
tool-call nodes are unmetered; a stream that fails *after* its first token records nothing despite
being billed; image and video usage rows carry `estimatedCostUsd: null`; and **the feature has no UI**.

---

## 4. Cross-cutting findings

- **X-1 — The deployment cannot boot (see §20).** The single most consequential finding, and a
  regression from this session's own ADR-045.
- **X-2 — No authentication anywhere**, while the IaC grants `allUsers` invoker on the API. Every
  other control is enforced on an anonymous caller.
- **X-3 — The frontend is entirely untested**, and its SSE parser has exactly the LF-only bug that was
  fixed server-side in ADR-045.
- **X-4 — The highest-risk code paths are the least covered**: the coding agent (real process spawn,
  full parent environment inherited) has zero tests; `packages/mcp` has zero tests and is skipped
  silently by `npm test`.
- **X-5 — Zero database indexes and zero transactions.** Every RAG search is a full scan; multi-row
  writes are non-atomic.
- **X-6 — Declared-but-inert configuration is a recurring pattern**: `node.type` (never read),
  `timeoutMs` on nodes (never read), `retryPolicy.backoff` (never applied), `inputSchema` (never
  validated), `requiresApproval` (4 values collapsed to 2), `singletonKey` (works, used nowhere),
  `classifyFailureAs` (persisted, never read), `retry_count` (incremented, never read).
- **X-7 — Line-ending fragility in a test.** `packages/shared/src/sse.test.ts` correctly uses
  two-character `\r\n` escapes and is portable. The Gemini adapter's duplicate CRLF test instead
  embeds **actual CR bytes** in its template literal; with `core.autocrlf=true` and **no
  `.gitattributes`**, what that test actually exercises depends on the checkout's line endings. The
  parser's CRLF behaviour is still locked in portably by the 7 `sse.test.ts` cases, so the risk is
  confined to a duplicated assertion.
- **X-8 — Silent-skip surfaces.** Two packages are skipped by `npm test` for lack of a `test` script;
  9 tests skip without external binaries. "189 passing" means 180 executed on a clean checkout.

## 5. Documentation divergences worth acting on

The repository is unusually honest overall — `docs/27`, `docs/29`, and `docs/FINAL_AUDIT.md` track
most gaps accurately. These are the claims the code contradicts:

| Claim | Reality |
|---|---|
| `README.md:18` — stack includes "self-hosted session auth" | No auth exists (`README.md:64` in the same file says so correctly) |
| `docs/15:33` — "Every response carries an `x-request-id` header" | No such header is set anywhere |
| `docs/15:30` — "All bodies validated against a Zod schema" | 4 of 12 body-taking routes |
| `docs/15:45-47` — OpenAPI at `/api/v1/openapi.json` + Swagger UI | Neither dependency is installed |
| `docs/15:32` — error body `{code, message, request_id}` | Implementation emits `requestId` (camelCase) |
| `docs/29:41`, `README.md:31` — "163 real tests across 33 files" | 189 across 35 |
| ADR-018 — "the full 13-state task state machine" | 10 of 13 states are ever entered |
| ADR-008 — "`packages/security` implements the `AuthProvider` interface" | `packages/security` does not exist |
| `docs/14` — ~22 tables, `memory_items` with an embedding column, `project_id` on every content table | 13 tables, no memory embedding, no tenant column anywhere |
| `docs/FINAL_AUDIT.md:28` — the router "matches docs/12 exactly" | It implements §4.2's fallback ordering only |
| `packages/jobs/queue.ts:90` — a job "eventually dead-letters" | No dead-letter queue is configured |
| `docs/24` — shows `apps/worker`, `packages/security`, `packages/memory` | None exist |
| `terraform.tfvars.example:14` — "leave blank to deploy on the mock LLM provider" | That configuration cannot boot (§20) |

## 6. What this audit did *not* verify

- No code was executed by the auditors; statuses rest on reading plus the suite run earlier in the
  session at this commit.
- The under-claiming / undiscovered-`BROKEN` verification lens did not run (session limit). Something
  rated PARTIALLY IMPLEMENTED here could be worse than stated.
- `docker build`, `terraform apply`, a real GCP deployment, real Google Cloud Storage, a real
  standalone Postgres, a real LLM provider success path, and CI have all still never run.
