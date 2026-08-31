# Backend Architecture

Two deployable backend units per [[24_PROJECT_STRUCTURE]]: `apps/api` (Fastify, handles all synchronous request/response and SSE streaming) and `apps/worker` (processes pg-boss jobs — media generation, long-form video pipeline steps, background summarization). Both import the same `packages/*` business-logic libraries; neither contains business logic itself beyond request wiring.

## `apps/api` structure

```
apps/api/src/
├── server.ts            # Fastify instance creation, plugin registration
├── config.ts             # Zod-validated env config, loaded and validated once at boot
├── plugins/                # auth, rate-limit, cors, swagger, error-handler, request-id
├── routes/v1/               # one file per resource in docs/15_API_ARCHITECTURE.md, thin handlers
│   └── chat.ts                # e.g.: validate → call packages/agent-core → stream response
└── index.ts                    # entrypoint
```

Route handlers are intentionally thin: validate input (schema from `packages/shared`), call into the relevant package (`agent-core`, `media`, `rag`, ...), map the result/error to an HTTP response. No package-level logic is duplicated in a route handler — if two routes need the same behavior, that behavior belongs in a package, not copy-pasted.

## `apps/worker` structure

```
apps/worker/src/
├── worker.ts             # pg-boss connection + job handler registration
├── handlers/               # one handler per job type (image.generate, video.generateScene,
│                             video.assembleTimeline, memory.summarizeConversation, ...)
└── index.ts
```

Each handler is a thin adapter too: fetch job payload → call into `packages/media`/`packages/memory` → report progress via `job_events` → return result or throw (pg-boss handles retry/backoff on throw, per [[07_LONG_RUNNING_JOB_ARCHITECTURE]] and [[23_FAILURE_RECOVERY]]).

## Configuration loading

All configuration (provider API keys, database URL, storage config, feature flags) is loaded once at process boot via a single Zod schema per app (`config.ts`), which fails fast with a clear error if required variables are missing/malformed — never read ad hoc via `process.env.X` scattered through the codebase (this is also what makes ADR-013's "mock provider can't boot in production" guard possible to implement in one place). `.env.example` documents every variable; see [[19_DEPLOYMENT_ARCHITECTURE]] for the full environment variable reference.

## Error handling middleware

A single Fastify `setErrorHandler` maps thrown errors to the `{ error: { code, message, request_id } }` shape from [[15_API_ARCHITECTURE]]. Errors are categorized once, centrally, into a small set of typed error classes in `packages/shared` (`ValidationError`, `NotFoundError`, `PermissionError`, `ProviderError`, `RateLimitError`) — handlers throw these, never construct raw HTTP responses for error cases, so the mapping to status code + safe message is consistent everywhere.

## Dependency wiring

No DI framework/container — plain constructor injection at the composition root (`server.ts`/`worker.ts`), where concrete provider adapters, the database connection, and the job queue client are instantiated once and passed into the packages that need them. This keeps `agent-core`, `tools`, `memory`, etc. framework-agnostic (they receive interfaces, not Fastify request objects), which is also what makes them independently unit-testable per [[21_TESTING_STRATEGY]].

## Why not one app for API + worker

A single process handling both HTTP requests and long-running job processing would couple their scaling and failure characteristics — a burst of slow video-generation jobs would starve HTTP request handling in the same event loop. Separate `apps/api`/`apps/worker` processes (and, later, separate Cloud Run services per [[18_CLOUD_ARCHITECTURE]]) scale and restart independently, and a worker crash mid-job doesn't take down the API.
