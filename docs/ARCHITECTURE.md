# Architecture

What the system is, as built. Design intent lives in the numbered `docs/NN_*.md` files; current
status lives in [PROJECT_STATUS.md](PROJECT_STATUS.md). Counts in this file were re-taken from the
tree on 2026-09-27 (branch `claude/zen-brahmagupta-6l5o4u`). It marks anything aspirational as such.

## Shape

Frontend and backend are **physically separate applications** (ADR-092) — separate directories,
separate `package.json`, separate builds, separate Docker images, separate deployable processes.
The frontend never touches the database; it talks to the API over HTTP and SSE, and the API owns
authentication, authorization, persistence, queues and AI orchestration.

```
  frontend/                                    backend/
  ─────────                                    ────────
  Next.js, 18 screens                          Fastify, 70 routes
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
        memory · tools · mcp · scanning · quota · observability · 11 provider adapters
                                                     |
                            PostgreSQL (PGlite locally, standalone in production)
                            + pgvector, and object storage (local disk or GCS)
```

**28 workspaces:** `frontend`, `backend`, `shared`, 14 backend packages and 11 provider adapters
(LLM: local, OpenAI, Anthropic, Google, mock; image: stable-diffusion.cpp, OpenAI-compatible,
mock; video: image-motion, Replicate, mock).

### Why `shared/` is top-level and the rest are not

The frontend imports `shared` and **nothing else** — and every one of those imports is
`import type`, so it is erased at compile time and the browser bundle carries none of it. That is
a contract, not a coupling, which is why `shared` sits beside the two applications rather than
inside one. The other fourteen packages are imported only by the backend, so they live inside it:
the boundary is legible from the directory listing.

None of this is enforced by the layout, so it is enforced by a check.
`scripts/check-boundary.mjs` reads the TypeScript compiler's syntax tree of every source file —
`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` — so a comment, a quoting style or a
line break cannot hide an import, and `import`, `import()` and `require()` are each a node of their
own. It enforces seven rules:

1. the frontend imports no backend package;
2. every frontend import of `shared` is type-only;
3. frontend application code reaches no database, queue, filesystem or subprocess;
4. the backend imports nothing from the frontend;
5. no relative or aliased import crosses an application boundary;
6. no frontend file — application, test or end-to-end spec — reads a server-side environment
   variable;
7. every package manifest in the tree declares every package its code imports.

Rules 2 and 3 protect the browser bundle, so they cover application code, not tests or build
configuration. Before it judges the real tree, the checker runs a self-test: a throwaway repository
with 39 planted violations — every evasion that defeated the grep checks it replaced — and 10 clean
files. Each violation must be reported under the right rule and nothing may be reported in the
clean files; each of 15 mutants that disables one rule or one import form is killed by that
self-test. `scripts/verify-boundary.sh`, the command the CI workflow calls, is a thin wrapper that
runs `check-boundary.mjs --all` (self-test first, then the tree) and exits 0 when clean, 1 on a
violation or a failed self-test, and 2 if the checker itself broke. On `fd5f5a5` it reports 8/8 —
the self-test and the 7 rules — over 275 parsed source files. Rule 7, applied to every manifest,
found `drizzle-orm` imported by `backend/src` and `uuid` by quota's tests without being declared;
both now are (ADR-111).

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

Membership is the only way into a project. The system administrator has no implicit access to any
tenant's project; that role gates `/api/v1/admin/*` and the tool-enable and MCP-reconnect controls
only (ADR-108). A project the caller is not a member of answers 404, like one that does not exist;
the one 403 for another tenant's project is an API key naming a project other than the one it is
bound to (`docs/API.md`). A member whose role lacks a route's permission gets 403
`PERMISSION_DENIED`.

`request.ip`, which every per-IP rate limit and audit row uses, trusts exactly `TRUST_PROXY_HOPS`
proxies (ADR-112). 0, the default, is the connection's own address; Terraform sets 1 for Cloud
Run's front end, which has not been checked against a live service. The former `trustProxy: true`
took the leftmost `X-Forwarded-For` entry — the one the caller writes.

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

What the harness adds around a real local model, each found by running one (2026-09-27):

- **Context budgeting.** The local runtime's real context window is read from Ollama's
  `/api/ps` (then `OLLAMA_CONTEXT_LENGTH`, then 4096), and `fitToContextWindow` trims the oldest
  observations to fit it, reserving `min(maxOutputTokens, max(512, window/4))` for the reply.
  Ollama silently truncates an over-long prompt from the front — the system prompt and the task
  went first — so exceeding the window is now a `ContextWindowExceededError`, never a truncation.
- **Every final answer is verified**, and a `fix_failing_test` node's verification *runs the real
  test* in the project's sandbox; a failure is fed back as an observation for up to 3 correction
  rounds.
- **The test the agent must make pass is read-only to it.** `readOnlyPaths` on the node make
  `fs.write_file`, `fs.delete_file`, `code.apply_patch` and `code.replace_text` refuse that path
  (`ReadOnlyPathError`), and the engine snapshots it before the run and restores it after, reporting
  `restoredReadOnlyPaths` — so "make the test pass" cannot be satisfied by editing the test.
- **Edits.** `code.replace_text` is an exact, unique search-and-replace; `code.apply_patch` uses
  `git apply --recount` semantics, refuses doubled `++`/`--` markers under a miscounted header,
  and refuses a `/dev/null` creation diff onto an existing file (a 7B model produced both).
- **Deadlines are real.** A node's persisted timeout is enforced by a sweeper that aborts with
  `NodeDeadlineExceededError` — a timeout is reported as `timed out`, never as `cancelled`.

## Retrieval and grounding

`POST /api/v1/rag/answer` retrieves pgvector neighbours (embedding model recorded per chunk),
delimits them as untrusted evidence with numbered markers, and classifies the model's answer:

| `outcome` | Meaning | `grounded` |
|---|---|---|
| `grounded` | a substantive answer citing at least one marker that was offered | `true` |
| `refused` | the first sentence says the evidence does not contain the answer | `false` (the fixed no-evidence text is returned) |
| `empty` | nothing was retrieved | `false` |
| `violation` | cites a marker that was not offered, or answers without citing (`uncited_answer`) | `false` (fallback text) |
| `retrieve_only` | the caller asked for passages only | `false` |

A refusal that happens to echo `[1]` is a refusal, not a grounded answer — the case that used
to report `grounded: true`.

## Media pipeline

Image, speech and video run as pg-boss jobs; the request answers 202 and the job owns the
provider call, its deadline, its cancellation and its usage record. Providers declare
`maxConcurrency` (stable-diffusion.cpp: 1, because two SDXL runs beside a 7B chat model exhausted
16 GB and the OOM killer took both) and the scene worker sizes itself from it. The video
storyboard is written by a `video.plan` job in the API role (which holds the chat model), then
scene jobs and a render job run in the worker role — see [MEDIA.md](MEDIA.md).

## Data

23 tables, 47 `CREATE INDEX` statements, and a squashed baseline migration plus four incrementals:
`0001` adds `rate_limit_counters` (ADR-071), `0002` adds `conversations.summary_fingerprint`
(ADR-110), `0003` adds `audio_generations`, and `0004` adds the SRT/WebVTT subtitle asset columns
to `video_projects`. Migrations run at boot, on PGlite or on a standalone Postgres
(`DATABASE_URL`); the compose stack runs them against `pgvector/pgvector:pg16`.

- **Identity:** `users`, `organizations`, `organization_members`, `projects`, `project_members`,
  `sessions`, `api_keys`, `audit_log`.
- **Content** (scoped to a project: ten carry `project_id`, and `messages`, `task_nodes`,
  `task_transitions` and `video_scenes` reach it through their parent row): `conversations`,
  `messages`, `tasks`, `task_nodes`, `task_transitions`, `documents`, `document_chunks`,
  `memory_items`, `assets`, `image_generations`, `audio_generations`, `video_projects`,
  `video_scenes`, `usage_records`.
- **Operational:** `rate_limit_counters` — no `project_id`; one table shared by every API instance
  (ADR-071).

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
The runtime contract — roles, security settings, `TRUST_PROXY_HOPS`, and how each application runs
on its own — is in [DEPLOYMENT.md](DEPLOYMENT.md); the compose stack in `docker-compose.yml` runs
`api` and `worker` as separate containers against one Postgres.

## Deliberate limits

- **No hosted provider has served a request here.** The OpenAI, Anthropic and Google LLM
  adapters, the OpenAI-compatible image adapter and the Replicate video adapter are complete and
  fixture-tested; this environment has no credentials for any of them. Every capability was
  instead exercised end to end on self-hosted software: Ollama (`qwen2.5:7b`,
  `nomic-embed-text`), stable-diffusion.cpp (SDXL base 1.0), Piper and ffmpeg.
- **image-motion is not a video model.** It animates one generated still per scene with ffmpeg
  and says so in its name, capabilities and clip metadata. A real video model is the Replicate
  adapter, which needs a token.
- **The process sandbox shares the host.** `DockerSandbox` is verified against a real container
  (`npm run test:docker -w @ai-platform/security`, 4/4, locally and in CI), but the API container
  in `docker-compose.yml` has no Docker socket, so the compose stack runs the coding agent under
  `ProcessSandbox` with `SANDBOX_ALLOW_PROCESS_IN_PRODUCTION=true` — acknowledged, logged at boot,
  and inside the API container's own filesystem.
- **The rate limiter fails open.** If Postgres is unreachable the request is allowed and the
  error is logged — deliberately, and opposite to the malware scanner's fail-closed rule
  (ADR-042/ADR-071). Rate limiting is a mitigation, not an authorization boundary.
- **Never deployed to a cloud.** Terraform validates; `plan`/`apply` need GCP credentials this
  environment does not have.
