# Smart AI Platform

A self-hostable AI platform: streamed chat with memory, retrieval-augmented answers with
citations, an autonomous agent and a coding agent that edits and tests real code, tool calling
and MCP, and image, speech and long-form video generation. It is multi-tenant, with auth, quotas,
rate limits, an audit log and metrics.

It is model-agnostic. The same code runs on a local model (Ollama or any OpenAI-compatible server)
or on Anthropic, OpenAI or Google. Every capability has been run end to end on **self-hosted
software only**: Ollama (`qwen2.5:7b`, `nomic-embed-text`), stable-diffusion.cpp (SDXL), Piper and
ffmpeg. Nothing answers with fake output: mock providers exist only for tests, only when
`ALLOW_MOCK_PROVIDERS=true`, and production refuses them. When a capability is not configured,
it says so.

**Status (2026-09-28):** [docs/FINAL_PRODUCTION_READINESS_REPORT.md](docs/FINAL_PRODUCTION_READINESS_REPORT.md)
has the verified status and its evidence. On the final Docker Compose stack:

- the full-system acceptance: 24/24;
- the browser suite: 11/11;
- the attack suite: 11/11;
- failure injection: 5/5.

The coding agent completed its acceptance task but did not complete a second, unrelated task
with the local 7B model; the report says why. It has not been deployed to a cloud: `terraform
plan`/`apply` need GCP credentials, so every production cell is `BLOCKED_EXTERNAL`
([docs/PRODUCTION_DEPLOYMENT_BLOCKER.md](docs/PRODUCTION_DEPLOYMENT_BLOCKER.md)).

## Layout

```
frontend/   Next.js 16 web app (18 screens)        — builds and runs on its own
backend/    Fastify 5 API + job workers (76 routes) — builds and runs on its own
  packages/   agent-core, model-router, memory, rag, embeddings, media, tools, mcp, security,
              quota, jobs, database, scanning, observability
  packages/providers/   llm-{local,openai,anthropic,google,mock}, image-{sdcpp,openai,mock},
                        video-{motion,replicate,mock}
shared/     types only; the frontend imports nothing else from the backend (checked in CI)
infrastructure/terraform/   Cloud Run + Cloud SQL + Cloud Storage
docker-compose.yml          the whole stack on one machine
```

## Run it locally

Requirements: Node.js 22 and npm. For AI features you also need a model runtime; the simplest is
[Ollama](https://ollama.com):

```bash
ollama pull qwen2.5:7b && ollama pull nomic-embed-text
```

The backend finds Ollama on `127.0.0.1:11434` by itself. Set `OLLAMA_CONTEXT_LENGTH=16384` for
Ollama; its default of 4096 tokens is too small for the agent.

```bash
cd backend && npm install && npm run dev      # API on http://localhost:8787
cd frontend && npm install && npm run dev     # web app on http://localhost:3000
```

This is an npm-workspaces repository, so `npm install` in either directory installs the whole
workspace. The backend's `predev` builds the packages it imports. The database is an embedded
PostgreSQL (PGlite, with pgvector) created and migrated at `backend/data/pgdata` on first boot;
set `DATABASE_URL` to use a standalone Postgres instead. To create the first administrator,
set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` on an empty database. Signup is also
open.

Without a model runtime, the backend still boots. Chat, RAG answers and the agent then return
a clear "no model configured" error, not a stub.

Image, speech and video generation turn on when their software is configured
([docs/MEDIA.md](docs/MEDIA.md)). The details are in
[docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md).

### With Docker

```bash
docker compose up -d --build                          # postgres+pgvector, ollama, api, worker, web
docker compose --profile setup run --rm ollama-pull   # once: pulls the two models into ollama
```

Then open http://localhost:3000. See [docker/README.md](docker/README.md) and
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Verify it

```bash
npm run verify        # every gate, PASS / FAIL / BLOCKED_EXTERNAL; non-zero on any FAIL
```

`npm run verify` runs build, typecheck, lint, unit, integration, the API contract, security,
Playwright, database, boundary, boot, the real-runtime gates (against a running stack at
`ACCEPT_API_URL`), Docker and Terraform. On the final tree the automated tests stand at 1274
passed, 0 failed, 2 skipped. The runtime scripts in `scripts/acceptance/` (browser, attacks,
failure injection, extra scenarios, latency) run against a running stack.

[docs/TESTING.md](docs/TESTING.md) describes every layer, and what the acceptance script checks
in each result.

## Documentation

| | |
|---|---|
| [docs/FINAL_PRODUCTION_READINESS_REPORT.md](docs/FINAL_PRODUCTION_READINESS_REPORT.md) | what was verified, how, and what is blocked |
| [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) | the status matrix |
| [docs/DECISION_LOG.md](docs/DECISION_LOG.md) | what this pass changed, and why (DL-1 to DL-23) |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) | every environment variable, generated from the code |
| [docs/MEDIA_SETUP.md](docs/MEDIA_SETUP.md) | installing ffmpeg, Piper and stable-diffusion.cpp |
| [docs/PRODUCTION_DEPLOYMENT.md](docs/PRODUCTION_DEPLOYMENT.md) | deploying to Cloud Run |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | problems actually hit, and their fixes |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | the system as built |
| [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md) | running and developing locally |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | model providers and how to configure each |
| [docs/MEDIA.md](docs/MEDIA.md) | image, speech and video generation |
| [docs/TESTING.md](docs/TESTING.md) | test layers and the acceptance script |
| [docs/SECURITY.md](docs/SECURITY.md) | security controls, and what is not protected |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker, compose, Cloud Run, the runtime contract |
| [docs/API.md](docs/API.md) | every route, generated from the code |
| [docs/26_DECISIONS.md](docs/26_DECISIONS.md) | architectural decisions, with reasons |

The numbered `docs/NN_*.md` files are the original design documents. `PROJECT_STATUS.md`,
`CURRENT_STATE.md`, `FINAL_IMPLEMENTATION_REPORT.md` and `TEST_REPORT.md` at the root are
historical records, kept as written. Their figures are not current.
