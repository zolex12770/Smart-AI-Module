# AI Agent Platform

A modular, model-agnostic AI agent platform: chat, autonomous multi-step tasks, a coding agent, tool calling and MCP integration, memory, RAG, and (initially mocked) image/video generation — built as a staged program, not a single release.

**Status: Phase 1 — a minimal chat loop is real and working** (streamed chat over SSE, backed by a mock LLM provider and a persisted SQLite conversation history). See [PROJECT_STATUS.md](PROJECT_STATUS.md) for exactly what's done, in progress, and next.

## Start here

- [docs/00_PROJECT_VISION.md](docs/00_PROJECT_VISION.md) — what this is and the guiding principles
- [docs/01_REQUIREMENTS.md](docs/01_REQUIREMENTS.md) — formal, prioritized requirements
- [docs/25_IMPLEMENTATION_ROADMAP.md](docs/25_IMPLEMENTATION_ROADMAP.md) — the phase-by-phase plan
- [docs/26_DECISIONS.md](docs/26_DECISIONS.md) — every architectural decision, with reasons and alternatives
- [docs/29_FEATURE_MATRIX.md](docs/29_FEATURE_MATRIX.md) — honest, current status of every capability
- [PROJECT_STATUS.md](PROJECT_STATUS.md) — what to read before starting any work session

## Stack (decided, see [docs/26_DECISIONS.md](docs/26_DECISIONS.md))

TypeScript/Node.js monorepo (npm workspaces) · Fastify API · Next.js web frontend · SQLite via libSQL for now, PostgreSQL + Drizzle ORM + pgvector from Phase 6 · self-hosted session auth · LLM providers: Anthropic, OpenAI, Google Gemini/Vertex, each with a mock fallback that requires no credentials.

## Running locally

Verified working end-to-end (2026-08-31) — a real browser session sending a message and getting a streamed mock response back, persisted to SQLite:

```
npm install     # installs and builds every workspace package (predev hook)
npm run dev     # starts the API (port 8787) and the web app (port 3000)
```

Then open http://localhost:3000. No Docker, no database server, and no API keys are required for this to work — the app runs on a local SQLite file (auto-created and auto-migrated on boot at `apps/api/data/dev.sqlite`) and a mock LLM provider that clearly labels its own responses as mock.

Other useful commands: `npm run typecheck`, `npm run build` (production build of every app), `npm run db:generate -w @ai-platform/database` (after a schema change, to create a new migration file).

## Configuring real providers (once Phase 2 lands)

Real providers activate automatically when their environment variable is set — no code changes needed:

| Provider | Env var |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google (Gemini API) | `GOOGLE_API_KEY` |
| Google (Vertex AI) | `GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT` |

Image and video generation ship mock-only until real provider credentials are supplied — see [docs/26_DECISIONS.md](docs/26_DECISIONS.md) ADR-009. Cloud deployment is documentation/IaC only until explicitly authorized — see ADR-011.

## Contributing to this repo (for the agent/engineer picking this up later)

Read `PROJECT_STATUS.md` first, then the roadmap and decision log, then inspect actual repo state before assuming anything in the docs is still current — the feature matrix is the one file expected to be updated every phase.
