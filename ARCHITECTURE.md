# Architecture

What the system is, as built. Design intent lives in `docs/`; current status lives in
`docs/PROJECT_STATUS.md`. This file describes the code that exists at commit `bfdfdc8`, and marks
anything aspirational as such.

## Shape

Frontend and backend are **physically separate applications** (ADR-092) — separate directories,
separate `package.json`, separate builds, separate Docker images, separate deployable processes.
The frontend never touches the database; it talks to the API over HTTP and SSE, and the API owns
authentication, authorization, persistence, queues and AI orchestration.

```
  frontend/                                    backend/
  ─────────                                    ────────
  Next.js, 17 screens                          Fastify, 47 routes
  builds and runs alone                        builds and runs alone
        |                                            |
        |   HTTP + SSE, cookie or bearer API key     |
        +-------------------------------------------->+
        |                                            |
        |            shared/  (types ONLY)           |
        +--- import type ────────────────────────────+
             erased at compile time, so the
             frontend has NO runtime dependency
                                                     |
                    +--------------------------------+--------------------------------+
                    |                                |                                |
        backend/packages/security        backend/packages/agent-core     backend/packages/model-router
        authn, authz, audit, sandbox     reasoning loop, task graph      capability registry,
                    |                                |                  retry, fallback, breaker
                    +--------------------------------+--------------------------------+
                                                     |
        database (Drizzle) · jobs (pg-boss) · media (AssetStore) · rag · embeddings
        memory · tools · mcp · scanning · quota · observability · 9 provider adapters
                                                     |
                            PostgreSQL (PGlite locally, standalone in production)
                            + pgvector, and object storage (local disk or GCS)
```

**26 workspaces:** `frontend`, `backend`, `shared`, 14 backend packages and 9 provider adapters.

### Why `shared/` is top-level and the rest are not

The frontend imports `shared` and **nothing else** — and every one of those imports is
`import type`, so it is erased at compile time and the browser bundle carries none of it. That is
a contract, not a coupling, which is why `shared` sits beside the two applications rather than
inside one. The other fourteen packages are imported only by the backend, so they live inside it:
the boundary is legible from the directory listing.

None of this is enforced by the layout, so it is enforced by a check.
`scripts/verify-boundary.sh` runs in CI and asserts seven properties — no backend package in the
frontend, `shared` imported type-only, no database/queue/filesystem/subprocess reach from the
frontend, no frontend import in the backend, no relative path across the boundary, no server
secret readable from frontend code, and each application declaring its own dependencies. Both of
its failing checks were proven to fail by injecting the violation they exist to catch.

## The request path

```
request
  -> auth plugin            resolves a session cookie or bearer API key into an AuthContext
  -> requireProject(perm)   resolves the project scope and checks ONE named permission
  -> route handler          validates the body with zod
  -> repository             filters by project_id in the SQL WHERE  <- the tenant boundary
  -> database / queue / provider
```

Two properties are load-bearing:

1. **Authorization is a query predicate, not a post-fetch check.** There is no `get(id)` — the
   signature is `get(projectId, id)`. The check a route might forget cannot be forgotten.
2. **A route declares the permission it needs.** There is no ambient authority; a route that
   names nothing gets nothing.

## The AI runtime

The platform is **not** architecturally dependent on any vendor.

```
ModelRegistry            capability-aware: tool calling, vision, context window, cost/quality
   -> select(criteria)   returns an ORDERED candidate list, so fallback is a routing outcome
ModelRouter              retry with exponential backoff + full jitter, honours Retry-After,
                         classifies errors, circuit-breaks, and reports every fallback
   -> LLMProvider        local (OpenAI-compatible) | anthropic | openai | google | mock
```

`LocalOpenAICompatibleProvider` speaks the `/v1/chat/completions` dialect that Ollama, vLLM,
llama.cpp and LM Studio all implement, **with tool calling**. When configured it is the default,
ahead of any hosted key. The mock exists for development and tests and is never constructed in
production.

## The agent loop

```
                +-----------------------------------------+
                |  MODEL decides                          |
                |    is a tool needed? which? arguments?  |
                |    is the result enough? done?          |
                +--------------------+--------------------+
                                     |
   observe --> reason --> [tool_call] --> validate --> authorize --> approve? --> execute
      ^                                                                              |
      +------------------------- observation ---------------------------------------+
                                     |
                              answer --> verify --> (one correction round)
```

The **harness** enforces what the model may not override: iteration ceiling, token budget, which
tools exist, approval policy, argument validity against `inputSchema`, execution isolation and
cancellation. A tool *error* is fed back as an observation, because recovering from it is exactly
the reasoning worth having.

> **Status:** unified (ADR-064). The planner emits a `reasoning` node for the `autonomous` task
> type and the engine executes it through the same node lifecycle as every other kind — same
> approval handling, same cancellation, same ceilings. The six deterministic task types remain
> because they are cheap, predictable and well-tested; they are recipes, not a second engine.

## Data

22 tables, 43 indexes, a squashed baseline migration plus one incremental (the platform has never
been deployed, so a baseline was safer than an untestable ALTER chain; everything after it is a
normal migration).

- **Identity:** `users`, `organizations`, `organization_members`, `projects`, `project_members`,
  `sessions`, `api_keys`, `audit_log`.
- **Content** (all carry `project_id`): `conversations`, `messages`, `tasks`, `task_nodes`,
  `task_transitions`, `documents`, `document_chunks`, `memory_items`, `assets`,
  `image_generations`, `video_projects`, `video_scenes`, `usage_records`.

Every timestamp is `timestamptz`. Vectors are a single `vector(1536)` column with the model
recorded alongside: any provider's width is zero-padded (exact for cosine similarity), and
retrieval filters on the model tag so vectors from two different models are never compared.

## Execution isolation

`ExecutionSandbox` has two implementations. `DockerSandbox` is the production posture — a
container per run with `--network none`, a read-only root, `--cap-drop ALL`, `no-new-privileges`,
and pid/memory/cpu caps. `ProcessSandbox` is the development fallback: same API, environment
scrubbed, real process-tree termination, but same-host. Production refuses the process sandbox
unless explicitly acknowledged, and only for a process that runs the agent engine.

## Deployment topology

One image, three roles (`ROLE=all|api|worker`): the Cloud Run service runs `api`, a worker pool
runs `worker`, and local development runs `all`. A worker never serves chat and therefore boots
without any LLM provider — the fix for the crash-loop that made the whole deployment impossible.

## Deliberate limits

- **No hosted provider has served a request here.** The image (ADR-065), video (ADR-085),
  OpenAI, Anthropic and Google adapters are complete and fixture-tested; this environment has no
  credentials for any of them. The SELF-HOSTED path — a local OpenAI-compatible runtime for chat
  and embeddings, and an offline speech synthesiser — is fully exercised, which is what makes
  "no mandatory hosted AI" a real property rather than a claim.
- **The Docker sandbox has never executed a container.** No Docker CLI, no service, no WSL and no
  administrator rights on this machine — checked, not assumed. Process isolation is real
  (environment scrubbed, process tree killed, output capped) but shares the host's network and
  filesystem, which is why production refuses it without an explicit opt-in.
- **Speech on Linux needs an HTTP provider.** The offline synthesiser is Windows SAPI; a Linux
  deployment configures `SPEECH_PROVIDER=openai` against any compatible server, or renders
  without narration and says so (`skipped_no_narration`).
- **Video cancellation is provider-level only.** `processVideoScene` passes no `AbortSignal` and
  there is no video-cancel route, so the provider's cancel endpoint is reached via the deadline
  and error paths rather than by a user action.
- **The rate limiter fails open.** If Postgres is unreachable the request is allowed and the
  error is logged — deliberately, and opposite to the malware scanner's fail-closed rule
  (ADR-042/ADR-071). Rate limiting is a mitigation, not an authorization boundary.
