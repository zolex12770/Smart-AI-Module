# API Architecture

Fastify, versioned under `/api/v1` from day one (ADR-003, FR-051). This is the one interface both `apps/web` and any external/developer client use — no business logic lives only in the frontend.

## Endpoint map

| Path | Methods | Notes |
|---|---|---|
| `/api/v1/auth` | POST (register, login, logout), GET (session) | Session-cookie based (ADR-008); returns/consumes an httpOnly cookie, not a bearer token, for browser clients |
| `/api/v1/api-keys` | GET, POST, DELETE | Long-lived API keys for non-browser/developer clients (FR-051); scoped, revocable |
| `/api/v1/chat` | POST (SSE stream) | Single-turn or conversation-attached chat; streams tokens per FR-001/FR-052 |
| `/api/v1/agent/tasks` | POST, GET, GET /:id, POST /:id/cancel, POST /:id/approve | Maps directly onto the task/state machine in [[11_AGENT_LOOP]]; `/approve` resolves a `WAITING_FOR_APPROVAL` state (FR-007) |
| `/api/v1/agent/tasks/:id/events` | GET (SSE stream) | Plan/step/tool/progress events (FR-052) |
| `/api/v1/jobs` | GET, GET /:id, POST /:id/cancel | Generic job status/cancel surface backing image/video/long-form-video jobs ([[07_LONG_RUNNING_JOB_ARCHITECTURE]]) |
| `/api/v1/images` | POST, GET /:id | Image generation request + result retrieval (FR-040) |
| `/api/v1/videos` | POST, GET /:id, GET /:id/scenes | Video generation; `/scenes` exposes per-scene status for long-form jobs (FR-043) |
| `/api/v1/assets` | GET, GET /:id, DELETE /:id | Asset metadata + signed download URL, not the binary itself (assets live in object storage, [[24_PROJECT_STRUCTURE]]) |
| `/api/v1/files` | POST (sandbox path, local dev), POST `/upload` (multipart, [[26_DECISIONS]] ADR-041), GET, GET /:id | Document ingestion feeding RAG ([[09_RAG_ARCHITECTURE]]) — the multipart route is the one that works on a stateless deployment; both enqueue the same `document.ingest` job |
| `/api/v1/memory` | GET, DELETE /:id | User-facing memory view/delete (FR-032) |
| `/api/v1/projects` | GET, POST, GET /:id, PATCH /:id, DELETE /:id | |
| `/api/v1/models` | GET | Read-only: capability registry contents ([[12_MODEL_ROUTING]]) |
| `/api/v1/providers` | GET, PATCH /:id | Enable/disable/configure providers; admin-scoped |
| `/api/v1/tools` | GET, PATCH /:id | Tool registry + per-tool permission config (FR-020/FR-022) |
| `/api/v1/mcp` | GET, POST, DELETE /:id | Register/remove MCP servers (FR-021) |
| `/api/v1/usage` | GET | Per-user/project usage and cost ([[22_COST_AND_QUOTA_STRATEGY]]) |
| `/api/v1/admin/*` | GET (mostly) | Queue health, provider error rates, system-wide usage (FR-062); requires admin role |
| `/api/health` | GET | Unversioned liveness/readiness probe for Cloud Run / local dev |

## Request/response conventions

- All bodies validated against a Zod schema before the handler runs (NFR-002); a shared schema module in `packages/shared` is the single source of truth reused by both the Fastify route and the OpenAPI doc generator, so the two cannot drift.
- Errors return `{ error: { code, message, request_id } }` — `message` is always a safe, user-facing string; internal detail (stack traces, provider raw errors) is logged against `request_id`, never returned in the body (per [[13_SECURITY_ARCHITECTURE]] and rule 39 of the original brief).
- Every response carries an `x-request-id` header, generated at the edge if not supplied by the client, and threaded through to every downstream log line ([[20_OBSERVABILITY]]).

## Streaming: SSE, not WebSockets, as the default

Chat tokens, agent task events, and job progress are all one-directional (server → client) and don't need the client to push mid-stream messages back over the same connection — Server-Sent Events are used throughout ([[04_MODEL_PROVIDER_RESEARCH]] confirms all three LLM providers stream via SSE-shaped protocols natively, so no protocol translation is needed on the hot path). WebSockets are reserved for a specific future case only if genuinely bidirectional streaming is needed (e.g. a live voice interface) — not introduced speculatively now.

## Auth on the API surface

- Browser clients: httpOnly session cookie (ADR-008), CSRF-protected via a double-submit token on state-changing requests.
- Non-browser/API clients: `Authorization: Bearer <api_key>`, validated against the hashed key in `api_keys` (never stored plaintext, [[13_SECURITY_ARCHITECTURE]]).
- Every route declares its minimum role (`user`, `project:owner`, `admin`) and Fastify's `onRequest` hook enforces it before the handler runs — no handler re-implements auth checks ad hoc.

## OpenAPI

Generated from the same Zod schemas via `@fastify/swagger` + `zod-to-openapi`, served at `/api/v1/openapi.json` and a Swagger UI at `/api/v1/docs` in non-production environments (disabled or auth-gated in production per [[13_SECURITY_ARCHITECTURE]]'s stance on not exposing internal surface unnecessarily).

## Rate limiting

Per-route, per-user/per-API-key limits via `@fastify/rate-limit`, with stricter limits on expensive routes (`/images`, `/videos`, `/agent/tasks`) than read-only ones (`/models`, `/tools`) — concrete numbers are a [[22_COST_AND_QUOTA_STRATEGY]] concern, not fixed here.
