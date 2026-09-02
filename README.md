# AI Agent Platform

A modular, model-agnostic AI agent platform: chat, autonomous multi-step tasks, a coding agent, tool calling and MCP integration, memory, RAG, and (initially mocked) image/video generation — built as a staged program, not a single release.

**Status: chat, a full agent task engine, tool/MCP calling, a narrow coding agent, real LLM provider adapters, retrieval-augmented document Q&A, a real async job system, async image generation (mocked), a long-form video generation pipeline (mocked), and a real, browser-verified web frontend for all of it are all working, on real PostgreSQL.** Streamed chat over SSE with a multi-conversation UI; a state-machine-driven agent task engine with persistence, crash-recovery, and human-approval gating, rendered live in the browser via SSE; sandboxed native tools plus a real connection to an external MCP server; a coding agent that runs a real failing test, fixes it, and re-verifies, with its own UI showing the real commands run and files changed; real Anthropic/OpenAI/Google adapters alongside the mock, with automatic fallback; document ingestion (a real background job, not a blocking request) + pgvector similarity search backing retrieval-augmented answers; pg-boss-backed jobs with genuine crash recovery; a provider-agnostic image generation pipeline (submit → async job → real, inspectable output) running on a mock provider until real image credentials are supplied; a long-form video pipeline (prompt → deterministic scene planner → per-scene async jobs → real ffmpeg assembly when available) with proven per-scene resumability; and a security-hardening pass (rate limiting, structural prompt-injection delimiting, argument-validated sandboxed tool execution) that found and fixed a real, live-exploited remote-code-execution vulnerability. See [PROJECT_STATUS.md](PROJECT_STATUS.md) for exactly what's done, in progress, and next.

## Start here

- [docs/00_PROJECT_VISION.md](docs/00_PROJECT_VISION.md) — what this is and the guiding principles
- [docs/01_REQUIREMENTS.md](docs/01_REQUIREMENTS.md) — formal, prioritized requirements
- [docs/25_IMPLEMENTATION_ROADMAP.md](docs/25_IMPLEMENTATION_ROADMAP.md) — the phase-by-phase plan
- [docs/26_DECISIONS.md](docs/26_DECISIONS.md) — every architectural decision, with reasons and alternatives
- [docs/29_FEATURE_MATRIX.md](docs/29_FEATURE_MATRIX.md) — honest, current status of every capability
- [PROJECT_STATUS.md](PROJECT_STATUS.md) — what to read before starting any work session

## Stack (decided, see [docs/26_DECISIONS.md](docs/26_DECISIONS.md))

TypeScript/Node.js monorepo (npm workspaces) · Fastify API · Next.js web frontend · real PostgreSQL + Drizzle ORM + pgvector, via PGlite (an embedded WASM Postgres — see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-025 for why, no Docker/hosted DB required) · self-hosted session auth · LLM providers: Anthropic, OpenAI, Google Gemini/Vertex, each with a mock fallback that requires no credentials.

## Running locally

Verified working end-to-end (2026-09-02) — real headless-browser (Playwright) and API sessions covering every screen: chat, agent/coding task detail with live SSE and human-in-the-loop approval, image and video generation, document retrieval, and memory settings, all persisted to real PostgreSQL:

```
npm install     # installs and builds every workspace package (predev hook)
npm run dev     # starts the API (port 8787) and the web app (port 3000)
```

Then open http://localhost:3000 — you'll land on `/chat`; the nav bar links to Chat, Tasks, Images, Videos, Files, and Settings. **No Docker, no separately-installed database server, and no API keys are required** — the app runs on a real embedded PostgreSQL instance (PGlite, auto-created and auto-migrated on boot at `apps/api/data/pgdata`) and a mock LLM provider that clearly labels its own responses as mock.

Other useful commands: `npm run typecheck`, `npm run build` (production build of every app), `npm test` (54 real tests: provider adapters, embeddings, the mock image/video providers, agent-core's prompt-injection defenses, the tools package's sandbox/terminal security checks, and genuine end-to-end integration tests for RAG, the job queue, and the long-form video pipeline's resumability against real in-memory Postgres/pg-boss — no mocks), `npm run db:generate -w @ai-platform/database` (after a schema change, to create a new migration file).

Long-form video assembly (the final MP4 step) needs a real `ffmpeg` on `PATH` (override with `FFMPEG_PATH`); without one, every scene still generates successfully and each clip is individually downloadable, but the project's `renderStatus` honestly reports `skipped_no_ffmpeg` instead of fabricating a video file — see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-030.

If the API ever fails to boot with a PGlite `RuntimeError: Aborted()`, the local dev database was corrupted by a prior forceful process kill (see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-029) — delete `apps/api/data/pgdata` and restart; it's disposable local data and will re-migrate from scratch.

## Configuring real providers

Real providers activate automatically when their environment variable is set — no code changes needed. Each is built against the raw documented API (not the official SDK — see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-023) and has been confirmed to reach the real live endpoint correctly (a deliberately invalid key gets back a real, correctly-shaped error from each provider), but the success path has not been verified end-to-end since no real key exists in this environment — that's the one thing a real key from you would let us finally confirm.

| Provider | Env var |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` (optionally `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`) |
| Google (Gemini Developer API) | `GOOGLE_API_KEY` (alias `GEMINI_API_KEY` also accepted) |
| Google (Vertex AI) | Not yet implemented — only the Gemini Developer API path is built |

With no key set, chat runs on the mock provider (clearly labels its own responses as such). With a real key set, the router uses that provider and automatically falls back to the mock if the real call fails before producing any output.

Image and video generation ship mock-only until real provider credentials are supplied — see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-009. Cloud deployment is documentation/IaC only until explicitly authorized — see ADR-011.

## Security

The API rate-limits every route (300 req/min default; images 10/min, videos 5/min, agent task creation 30/min — see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-032). The coding agent's terminal tool validates every command argument, not just the command name — a real argument-injection RCE was found and fixed here during Phase 11's security hardening pass; see ADR-032 for the full writeup. There is no auth/RBAC system yet (single-operator scope, per ADR-008) and no SSRF protections (no URL-fetching tool exists yet) — both are deliberately deferred, not silently missing; see [docs/27_RISKS_AND_LIMITATIONS.md](docs/27_RISKS_AND_LIMITATIONS.md).

## Contributing to this repo (for the agent/engineer picking this up later)

Read `PROJECT_STATUS.md` first, then the roadmap and decision log, then inspect actual repo state before assuming anything in the docs is still current — the feature matrix is the one file expected to be updated every phase.
