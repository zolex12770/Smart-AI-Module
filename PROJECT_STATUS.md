# Project Status

Read this file first at the start of any session, along with `README.md`, `docs/25_IMPLEMENTATION_ROADMAP.md`, and `docs/26_DECISIONS.md`, before inspecting the repository state.

## Current Phase

**Phase 0 — Research & Documentation: COMPLETE.** Next up: Phase 1 — Repository Foundation & Minimal Chat Loop (see [docs/25_IMPLEMENTATION_ROADMAP.md](docs/25_IMPLEMENTATION_ROADMAP.md)).

## Completed

- Repository initialized (`git init`); environment inventory done: Node v24.13.0, npm 11.6.2, Python 3.14.2, git 2.55.0 available. **No Docker, no gcloud CLI, no LLM/image/video provider API keys, no DATABASE_URL/REDIS_URL** — confirmed by direct inspection, not assumed.
- Scoping decisions made with the user (2026-08-31): staged program (docs → real MVP → media/cloud later); concrete LLM targets = Anthropic, OpenAI, Google Gemini/Vertex; image/video generation and cloud deployment are mock/documentation-only until the user supplies real credentials/budget.
- **All 31 Phase 0 documents complete** (`docs/00`–`docs/30`), written either directly or via four background research agents whose output was verified (file existence + substantive line counts) before being relied on. See [docs/29_FEATURE_MATRIX.md](docs/29_FEATURE_MATRIX.md) for the per-doc status table.
- 15 architectural decisions logged in [docs/26_DECISIONS.md](docs/26_DECISIONS.md) (ADR-001–ADR-015), including two reconciliations made after research landed:
  - **No Redis anywhere** — job queue is pg-boss on the same Postgres instance (ADR-012), chosen over both the original BullMQ+Redis placeholder and the cloud doc's independent Cloud Tasks suggestion, to avoid running two different queue systems for dev vs. prod.
  - **Mock providers cannot boot when `NODE_ENV=production`** — a structural guard, not a convention (ADR-013).
- Key research findings worth remembering: real video providers cap single-call clips at 5–25 seconds (confirms long-form video must be scene-decomposed — [docs/06_VIDEO_GENERATION_RESEARCH.md](docs/06_VIDEO_GENERATION_RESEARCH.md)); OpenAI's Sora 2 API is scheduled to shut down 2026-09-24 (live case for provider-agnosticism, noted in [docs/27_RISKS_AND_LIMITATIONS.md](docs/27_RISKS_AND_LIMITATIONS.md)); LLM context windows have converged to ~1M tokens across Anthropic/OpenAI/Google but max output tokens and tool-calling shapes still diverge significantly ([docs/04_MODEL_PROVIDER_RESEARCH.md](docs/04_MODEL_PROVIDER_RESEARCH.md), [docs/12_MODEL_ROUTING.md](docs/12_MODEL_ROUTING.md)).
- Stack locked in: TypeScript/Node.js monorepo (npm workspaces), Fastify API, Next.js web, PostgreSQL + Drizzle ORM + pgvector (SQLite for the Phase 1 milestone only, per ADR-006), self-hosted session auth, mock-first providers everywhere real credentials don't exist yet.
- Git: one commit so far (`Phase 0: project vision, requirements, structure, roadmap, decisions`). The 13 research-agent-authored docs plus the ADR-012/013 reconciliation and 14–17/19/22–23/30 are staged locally but **not yet committed** as of this writing — commit them as part of closing out Phase 0 (see Next Action).

## Known Issues / Blockers

- None blocking Phase 1. Phase 2 (real LLM providers) needs at least one real API key from the user before real-provider integration can be verified end-to-end (adapter code + unit tests against recorded fixtures can proceed without one). Phase 6 needs Postgres (and, per the new local-dev doc, either Docker Desktop or a hosted free-tier Postgres like Neon — not both required). Phase 14 needs a real GCP project/billing from the user; nothing is provisioned without explicit authorization at that point (ADR-011).

## Last Successful Test

N/A — no application code exists yet.

## Next Action

1. Commit the completed Phase 0 documentation set (13 research docs + 7 new architecture-synthesis docs + the ADR-012/013 reconciliation edits) as a second checkpoint commit.
2. Begin Phase 1 scaffolding per [docs/24_PROJECT_STRUCTURE.md](docs/24_PROJECT_STRUCTURE.md): npm workspaces skeleton, `packages/shared`, `packages/providers/llm-mock`, minimal `packages/model-router`, `packages/database` on SQLite, minimal `apps/api` (`POST /api/v1/chat` with SSE), minimal `apps/web` chat page.
3. Hard checkpoint before Phase 2 starts: `npm install && npm run dev` on a clean checkout must produce a working chat UI against the mock provider with zero external services — verify this manually in a browser, not just via a passing test.
