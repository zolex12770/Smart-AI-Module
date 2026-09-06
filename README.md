# AI Agent Platform

A modular, model-agnostic AI agent platform: chat, autonomous multi-step tasks, a coding agent, tool calling and MCP integration, memory, RAG, and (initially mocked) image/video generation — built as a staged program, not a single release.

**Status: chat, a full agent task engine, tool/MCP calling, a narrow coding agent, real LLM provider adapters, retrieval-augmented document Q&A, a real async job system, async image generation (mocked), a long-form video generation pipeline (mocked), and a real, browser-verified web frontend for all of it are all working, on real PostgreSQL.** Streamed chat over SSE with a multi-conversation UI; a state-machine-driven agent task engine with persistence, crash-recovery, and human-approval gating, rendered live in the browser via SSE; sandboxed native tools plus a real connection to an external MCP server; a coding agent that runs a real failing test, fixes it, and re-verifies, with its own UI showing the real commands run and files changed; real Anthropic/OpenAI/Google adapters alongside the mock, with automatic fallback; document ingestion (a real background job, not a blocking request) — plain text/Markdown, real PDF, and real DOCX all parse for real — + pgvector similarity search backing retrieval-augmented answers; pg-boss-backed jobs with genuine crash recovery; a provider-agnostic image generation pipeline (submit → async job → real, inspectable output) running on a mock provider until real image credentials are supplied; a long-form video pipeline (prompt → deterministic scene planner → per-scene async jobs → real ffmpeg assembly when available) with proven per-scene resumability; a security-hardening pass (rate limiting, structural prompt-injection delimiting, argument-validated sandboxed tool execution) that found and fixed a real, live-exploited remote-code-execution vulnerability; real observability (structured logging + OpenTelemetry tracing, verified to correlate one request id across the API, a job worker, and a provider call); real cloud-deployment groundwork (Dockerfiles, Terraform IaC, a real standalone-Postgres connection path alongside the local PGlite default) — written and locally validated as far as this environment allows, not provisioned; and real, live-verified cost/quota enforcement (real per-token pricing for every real LLM provider's default model, daily/monthly limits on tokens/images/video-seconds, a real `429` on overage). See [PROJECT_STATUS.md](PROJECT_STATUS.md) for exactly what's done, in progress, and next.

## Start here

- [docs/00_PROJECT_VISION.md](docs/00_PROJECT_VISION.md) — what this is and the guiding principles
- [docs/01_REQUIREMENTS.md](docs/01_REQUIREMENTS.md) — formal, prioritized requirements
- [docs/25_IMPLEMENTATION_ROADMAP.md](docs/25_IMPLEMENTATION_ROADMAP.md) — the phase-by-phase plan
- [docs/26_DECISIONS.md](docs/26_DECISIONS.md) — every architectural decision, with reasons and alternatives
- [docs/29_FEATURE_MATRIX.md](docs/29_FEATURE_MATRIX.md) — honest, current status of every capability
- [PROJECT_STATUS.md](PROJECT_STATUS.md) — what to read before starting any work session

## Stack (decided, see [docs/26_DECISIONS.md](docs/26_DECISIONS.md))

TypeScript/Node.js monorepo (npm workspaces) · Fastify API · Next.js web frontend · real PostgreSQL + Drizzle ORM + pgvector, via PGlite locally (an embedded WASM Postgres — see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-025 for why, no Docker/hosted DB required) or a real standalone Postgres (e.g. Cloud SQL) when `DATABASE_URL` is set (ADR-037) · self-hosted session auth · LLM providers: Anthropic, OpenAI, Google Gemini/Vertex, each with a mock fallback that requires no credentials.

## Running locally

Verified working end-to-end (2026-09-02) — real headless-browser (Playwright) and API sessions covering every screen: chat, agent/coding task detail with live SSE and human-in-the-loop approval, image and video generation, document retrieval, and memory settings, all persisted to real PostgreSQL:

```
npm install     # installs and builds every workspace package (predev hook)
npm run dev     # starts the API (port 8787) and the web app (port 3000)
```

Then open http://localhost:3000 — you'll land on `/chat`; the nav bar links to Chat, Tasks, Images, Videos, Files, and Settings. **No Docker, no separately-installed database server, and no API keys are required** — the app runs on a real embedded PostgreSQL instance (PGlite, auto-created and auto-migrated on boot at `apps/api/data/pgdata`) and a mock LLM provider that clearly labels its own responses as mock.

Other useful commands: `npm run typecheck`, `npm run build` (production build of every app), `npm test` (**429 test cases across 50 files — 416 passing, 13 skipped when an optional binary is absent, 0 failures**; overwhelmingly integration tests against real infrastructure rather than mocks: a real embedded PostgreSQL with real migrations and pgvector, real pg-boss queues, real HTTP through Fastify's `inject()`, real spawned processes, real PDF/DOCX/ZIP parsing, a real `clamd` with a real EICAR sample, a real `fake-gcs-server`, and real OpenTelemetry span-tree assertions), `npm test --workspace=@ai-platform/web` and `npx playwright test` in `apps/web` (**7 end-to-end tests in a real browser** against the real API and a real database, including cross-tenant isolation), `bash scripts/verify-boot.sh` (**7/7** boot checks against the real built entrypoint), `npm run db:generate -w @ai-platform/database` (after a schema change, to create a new migration file).

`.github/workflows/ci.yml` runs the same typecheck/build/test/audit commands, plus a `gitleaks` secret scan, on every push/PR — every step was verified locally from a genuinely fresh build state, but this repo has no GitHub remote in the environment that authored it, so the workflow itself has never actually run in GitHub Actions (see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-035).

Long-form video assembly (the final MP4 step) needs a real `ffmpeg` on `PATH` (override with `FFMPEG_PATH`); without one, every scene still generates successfully and each clip is individually downloadable, but the project's `renderStatus` honestly reports `skipped_no_ffmpeg` instead of fabricating a video file — see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-030.

If the API ever fails to boot with a PGlite `RuntimeError: Aborted()`, the local dev database was corrupted by a prior forceful process kill (see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-029) — delete `apps/api/data/pgdata` and restart; it's disposable local data and will re-migrate from scratch.

## Configuring real providers

Real providers activate automatically when their environment variable is set — no code changes needed. Put it in a `.env` file (copy `.env.example` to `.env` at the repo root, or create `apps/api/.env`; both are gitignored and loaded natively at boot, ADR-043) or export it in your shell — a real environment variable always wins over a file value. Each is built against the raw documented API (not the official SDK — see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-023) and has been confirmed to reach the real live endpoint correctly (a deliberately invalid key gets back a real, correctly-shaped error from each provider), but the success path has not been verified end-to-end since no real key exists in this environment — that's the one thing a real key from you would let us finally confirm.

| Provider | Env var |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` (optionally `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`) |
| Google (Gemini Developer API) | `GOOGLE_API_KEY` (alias `GEMINI_API_KEY` also accepted) |
| Google (Vertex AI) | Not yet implemented — only the Gemini Developer API path is built |

With no key set, chat runs on the mock provider (clearly labels its own responses as such). With a real key set, the router uses that provider and automatically falls back to the mock if the real call fails before producing any output.

Image and video generation ship mock-only until real provider credentials are supplied — see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-009. Cloud deployment is documentation/IaC only until explicitly authorized — see ADR-011.

## Cloud deployment

`apps/api/Dockerfile`, `apps/web/Dockerfile`, and `infrastructure/terraform/` exist and are documented in [infrastructure/DEPLOYMENT_RUNBOOK.md](infrastructure/DEPLOYMENT_RUNBOOK.md) — real, reviewed artifacts, not provisioned or built (no Docker/GCP project in the environment that authored them; see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-037 for exactly what was and wasn't verified, including a real `terraform validate`/`plan` and a real Postgres connection-attempt test). The job worker is a separately deployable role of the same image: `ROLE=api` on the Cloud Run service, `ROLE=worker` on a Cloud Run worker pool, `ROLE=all` (the default) for local dev where PGlite allows only one process (ADR-039 — each role verified live, but the two have never yet run concurrently against a shared database here). Generated assets go to a real Cloud Storage store when `ASSETS_BUCKET` is set (ADR-040 — one `AssetStore` interface, local disk by default; verified byte-for-byte through the real client against a `fake-gcs-server` emulator, which CI downloads, never yet against real GCS). RAG documents arrive by real multipart upload into that same store (ADR-041), so the only local-disk use left is the coding agent's per-run scratch directory — a legitimate scratch space, tracked in docs/27 but no longer a deploy blocker.

## Cost & quota

Real, dated per-token pricing exists for each real provider's current default model (`packages/model-router/src/cost-estimator.ts`, see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-038) — `null`, never a fabricated number, for anything unpriced (the mock provider, image/video generation until a real provider is chosen). Optional, single-operator quota limits (unset by default) are enforced *before* any LLM call, image generation, or video project is created: `DAILY_TOKEN_LIMIT`, `MONTHLY_TOKEN_LIMIT`, `DAILY_IMAGE_LIMIT`, `MONTHLY_VIDEO_SECONDS_LIMIT`. Exceeding a configured limit returns a real `429 QUOTA_EXCEEDED` with the exact running total, never a silent overage. `GET /api/v1/usage` reports current token/image/video totals against whatever limits are configured.

## Security

The API rate-limits every route (300 req/min default; images 10/min, videos 5/min, agent task creation 30/min — see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-032). The coding agent's terminal tool validates every command argument, not just the command name — a real argument-injection RCE was found and fixed here during Phase 11's security hardening pass; see ADR-032 for the full writeup. Authentication, authorization and multi-tenancy are real (ADR-049): scrypt passwords, hash-only storage of session tokens and API keys, CSRF double-submit, RBAC and an audit log. Authorization is a SQL predicate rather than a check — every content table carries `project_id`, repositories expose `get(projectId, id)` and there is no `get(id)` to call by mistake — so a resource in another tenant returns **404, never 403**, which a browser-driven end-to-end test asserts. Rate-limit counters are shared across API instances via Postgres (ADR-071), so N instances enforce one limit rather than N. There are still no SSRF protections, because no URL-fetching tool exists; that is deliberately deferred, not silently missing — see [docs/27_RISKS_AND_LIMITATIONS.md](docs/27_RISKS_AND_LIMITATIONS.md). File uploads (`POST /api/v1/files/upload`, ADR-041) apply docs/13 §12 for real: an allow-list of exactly the four ingestible types, a declared-type check, a real content sniff (PDF signature, a structural DOCX check, valid UTF-8 for text), a 25 MiB cap returning a real `413`, generated storage keys, attachment-only read-back, a per-route rate limit, and — when `CLAMD_HOST` is set — a real clamd malware scan (ADR-042: uploads are held in `scanning`, never ingested or served, until the worker's scan clears them; infected uploads are rejected and their bytes deleted; `UPLOAD_SCAN_REQUIRED=true` makes uploads fail closed, which the deployment Terraform sets). Without a scanner configured, uploads are accepted with a durable `skipped_no_scanner` mark and a loud boot warning.

## Observability

Every log line is structured JSON (a shared, redacting Pino logger — see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-033) with a `request_id` that's propagated from the originating HTTP request into any job it enqueues, so you can grep one id across the API log, a job worker's log, and the provider-call log it produced. Real OpenTelemetry spans (`gen_ai.chat` for chat, `job.process` for jobs) print to the console — there's no Collector/Grafana running here (no Docker), so `ConsoleSpanExporter` is the honest local-dev substitute; swapping in a real OTLP exporter later is a one-line change in `packages/observability`, not an application-code change. Metrics and full agent-run trace coverage aren't built yet — see ADR-033 for why.

## Contributing to this repo (for the agent/engineer picking this up later)

Read `PROJECT_STATUS.md` first, then the roadmap and decision log, then inspect actual repo state before assuming anything in the docs is still current — the feature matrix is the one file expected to be updated every phase. [docs/FINAL_AUDIT.md](docs/FINAL_AUDIT.md) records an independent, point-in-time re-verification of that feature matrix and the target-state spec against the real repository — read it for what's been directly confirmed vs. inherited from each phase's own account.
