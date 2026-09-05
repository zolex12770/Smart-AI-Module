# Architecture

What the system is, as built. Design intent lives in `docs/`; this file describes the code that
exists at commit `d8c7b46`, and marks anything aspirational as such.

## Shape

Frontend and backend are **separate applications**, independently buildable and deployable. The
frontend never touches the database; it talks to the API over HTTP and SSE, and the API owns
authentication, authorization, persistence, queues and AI orchestration.

```
apps/web  (Next.js)                    apps/api  (Fastify)
    |                                      |
    |  HTTP + SSE, cookie or bearer        |
    +------------------------------------->+
                                           |
                    +----------------------+----------------------+
                    |                      |                      |
              packages/security      packages/agent-core    packages/model-router
              authn, authz,          reasoning loop,        capability registry,
              audit, sandbox         task graph, engine     retry, fallback
                    |                      |                      |
                    +----------------------+----------------------+
                                           |
        packages/database (Drizzle) · packages/jobs (pg-boss) · packages/media (AssetStore)
        packages/rag · packages/embeddings · packages/tools · packages/mcp · packages/scanning
                                           |
                            PostgreSQL (PGlite locally, standalone in production)
                            + pgvector, and object storage (local disk or GCS)
```

23 workspaces: 2 apps, 15 packages, 6 provider adapters.

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

> **Status:** the reasoning loop is real and tested (18 tests). The task-graph engine still
> executes its deterministic plans for the six built-in task types; the two execution paths are
> **not yet unified**, and that is the largest remaining architectural gap.

## Data

21 tables, 42 indexes, one squashed baseline migration (the platform has never been deployed, so
a baseline is safer than an untestable ALTER chain).

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

- Rate limiting is per-instance and in-memory; multi-instance needs a shared store.
- Memory is stored, embedded and searchable but **not yet injected into prompts**.
- Image and video generation have **no real provider**; production returns a capability error
  rather than fake output.
- MCP is stdio-only, one hardcoded server, no reconnection.
