# Project Status

Read this file first at the start of any session, along with `README.md`, `docs/25_IMPLEMENTATION_ROADMAP.md`, and `docs/26_DECISIONS.md`, before inspecting the repository state.

## Current Phase

**Phase 1 — Repository Foundation & Minimal Chat Loop: COMPLETE and verified.** Next up: Phase 2 — Real LLM Provider Adapter(s) (see [docs/25_IMPLEMENTATION_ROADMAP.md](docs/25_IMPLEMENTATION_ROADMAP.md)).

## Completed

- **Phase 0** (research + 31 docs) — complete, see git history and [docs/29_FEATURE_MATRIX.md](docs/29_FEATURE_MATRIX.md).
- **Phase 1 scaffolding, built and verified for real, not just written:**
  - Monorepo: npm workspaces (`apps/api`, `apps/web`, `packages/shared`, `packages/database`, `packages/model-router`, `packages/providers/llm-mock`), TypeScript project references so `npm run dev`'s `predev` hook builds packages automatically.
  - `packages/shared`: chat types (Zod-validated `ChatRequest`/`ChatMessage`/`ChatStreamEvent`), typed `AppError` hierarchy.
  - `packages/providers/llm-mock`: `MockLLMProvider` — streams a clearly-labeled canned response, refuses to construct when `NODE_ENV=production` (ADR-013).
  - `packages/model-router`: minimal `ModelRegistry` + `ModelRouter` (single/default provider routing; fallback logic is a Phase 2 concern once there's a second real provider).
  - `packages/database`: Drizzle schema (`conversations`, `messages`), repository interfaces + SQLite implementation, auto-migration on API boot.
  - `apps/api`: Fastify, `POST /api/v1/chat` (SSE streaming), `GET /api/health`, Zod-validated env config, central typed error handler.
  - `apps/web`: Next.js chat page, manual SSE-over-fetch client (POST body streaming, since native `EventSource` is GET-only).
  - **Verified in a real headless browser session** (Playwright, via the `run` skill) — typed a message, got a streamed mock response back, confirmed via DOM content and screenshot. Also verified directly via `curl`: SSE framing, conversation persistence in SQLite (queried the actual file), multi-turn conversation continuity via `conversationId`, and proper error status codes.
  - **Two real bugs found by this testing and fixed** (not just "looked right in review"):
    1. `reply.hijack()` in the chat route bypassed `@fastify/cors`'s response hook entirely, so the browser blocked the whole streamed response with a CORS error even though the server sent it successfully. Fixed by writing `Access-Control-Allow-Origin` manually in the raw header write, since that route owns its own headers once hijacked.
    2. The central error handler only special-cased our own `AppError` subclasses and collapsed every other error — including Fastify's own 4xx body-parser errors — into a generic 500. A malformed request body was being reported to the client as "the server is broken" instead of "fix your request." Fixed to respect a framework-supplied 4xx `statusCode` when present.
  - **Two environment-driven deviations from the original doc set, logged as ADR-016/ADR-017** in [docs/26_DECISIONS.md](docs/26_DECISIONS.md): SQLite driver is `@libsql/client` (libSQL), not `better-sqlite3` — this dev machine has no C++ build toolchain and no prebuilt `better-sqlite3` binary exists yet for Node 24 on Windows; API default port is 8787, not 4000 — port 4000 was already occupied by unrelated pre-existing processes on this machine.
  - Dependency versions were bumped from what was first drafted to current patched releases after `npm audit` found real advisories (SQL injection in an old `drizzle-orm`, XSS/path-traversal in old `postcss` via `next`) — see the full list in `docs/26_DECISIONS.md` context and `package.json` files. One residual moderate advisory (a dev-only transitive `esbuild` inside `drizzle-kit`, a local CLI never exposed as a network service) is accepted rather than downgrading the tool.
  - `npm run build` (production build of every app), `npm run typecheck`, and `npm run db:generate` all verified working.

## Known Issues / Blockers

- None blocking Phase 2. Phase 2 (real LLM providers) needs at least one real API key from the user to verify end-to-end beyond adapter unit tests — not needed to *start* Phase 2 (adapter code + fixture-based unit tests can proceed without one). Phase 6 needs Postgres — either Docker Desktop (not currently installed) or a hosted free-tier Postgres (e.g. Neon) as documented in `docs/19_DEPLOYMENT_ARCHITECTURE.md`. Phase 14 needs a real GCP project/billing from the user; nothing is provisioned without explicit authorization (ADR-011).
- Minor, non-blocking: a React hydration-mismatch console warning was observed once during automated Playwright testing (`caret-color: transparent` style attribute mismatch on the chat input). It did not reproduce as any functional problem and no code in this repo sets that style — most likely a Next.js 16 dev-tools-overlay or automation-harness artifact, not our bug. Worth a quick look if it's ever seen in a normal (non-automated) browser session, but not treated as a real defect based on current evidence.

## Last Successful Test

2026-08-31 — full manual + browser-driven verification of the Phase 1 chat loop (see "Completed" above). `npm run build` and `npm run typecheck` both green across all six workspaces.

## Next Action

1. Start Phase 2: implement `packages/providers/llm-anthropic`, `llm-openai`, `llm-google` per [docs/04_MODEL_PROVIDER_RESEARCH.md](docs/04_MODEL_PROVIDER_RESEARCH.md) and [docs/28_API_PROVIDER_MATRIX.md](docs/28_API_PROVIDER_MATRIX.md), wire into `ModelRegistry` (registered only when their API key env var is present), and expand `ModelRouter` with the fallback logic from [docs/12_MODEL_ROUTING.md](docs/12_MODEL_ROUTING.md).
2. Since no real provider API key is available in this environment, Phase 2 adapters should be built against recorded/documented request-response fixtures and unit-tested that way; ask the user for a real key (or have them set it locally) before claiming end-to-end real-provider verification, per this project's own "never fake it" rule.
3. Commit Phase 1 as its own checkpoint before starting Phase 2 work.
