# AI Agent Platform

A modular, model-agnostic AI agent platform: chat, autonomous multi-step tasks, a coding agent, tool calling and MCP integration, memory, RAG, and (initially mocked) image/video generation — built as a staged program, not a single release.

**Status: Phase 0 — Research & Documentation.** No application code exists yet. See [PROJECT_STATUS.md](PROJECT_STATUS.md) for exactly what's done, in progress, and next.

## Start here

- [docs/00_PROJECT_VISION.md](docs/00_PROJECT_VISION.md) — what this is and the guiding principles
- [docs/01_REQUIREMENTS.md](docs/01_REQUIREMENTS.md) — formal, prioritized requirements
- [docs/25_IMPLEMENTATION_ROADMAP.md](docs/25_IMPLEMENTATION_ROADMAP.md) — the phase-by-phase plan
- [docs/26_DECISIONS.md](docs/26_DECISIONS.md) — every architectural decision, with reasons and alternatives
- [docs/29_FEATURE_MATRIX.md](docs/29_FEATURE_MATRIX.md) — honest, current status of every capability
- [PROJECT_STATUS.md](PROJECT_STATUS.md) — what to read before starting any work session

## Stack (decided, see [docs/26_DECISIONS.md](docs/26_DECISIONS.md))

TypeScript/Node.js monorepo (npm workspaces) · Fastify API · Next.js web frontend · PostgreSQL + Drizzle ORM + pgvector (SQLite for the first local milestone) · self-hosted session auth · LLM providers: Anthropic, OpenAI, Google Gemini/Vertex, each with a mock fallback that requires no credentials.

## Running locally

Not yet applicable — Phase 1 scaffolding hasn't been created. Once it exists, the goal (per [docs/01_REQUIREMENTS.md](docs/01_REQUIREMENTS.md) NFR-010) is: clone, `npm install`, one setup command, chat works immediately against a mock provider with **no** required Docker, database server, or API keys. This section will be filled in with real, tested instructions as of Phase 1 completion — not written speculatively ahead of the code existing.

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
