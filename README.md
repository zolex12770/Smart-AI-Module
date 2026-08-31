# AI Agent Platform

A modular, model-agnostic AI agent platform: chat, autonomous multi-step tasks, a coding agent, tool calling and MCP integration, memory, RAG, and (initially mocked) image/video generation — built as a staged program, not a single release.

**Status: chat, a full agent task engine, tool/MCP calling, a narrow coding agent, and real (fixture-tested + live-endpoint-verified) LLM provider adapters are all working.** Streamed chat over SSE; a state-machine-driven agent task engine with persistence, crash-recovery, and human-approval gating; sandboxed native tools plus a real connection to an external MCP server; a coding agent that runs a real failing test, fixes it, and re-verifies; and real Anthropic/OpenAI/Google adapters alongside the mock, with automatic fallback. See [PROJECT_STATUS.md](PROJECT_STATUS.md) for exactly what's done, in progress, and next.

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

Other useful commands: `npm run typecheck`, `npm run build` (production build of every app), `npm test` (fixture-based provider adapter tests via Vitest), `npm run db:generate -w @ai-platform/database` (after a schema change, to create a new migration file).

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

## Contributing to this repo (for the agent/engineer picking this up later)

Read `PROJECT_STATUS.md` first, then the roadmap and decision log, then inspect actual repo state before assuming anything in the docs is still current — the feature matrix is the one file expected to be updated every phase.
