# Final production-readiness report

**Date:** 2026-09-27 · **Branch:** `claude/zen-brahmagupta-6l5o4u` · **Verified at:** `0487870` (the last code commit; the commits after it change documentation only)

## Verdict

The platform runs end to end on self-hosted software, locally and as a Docker Compose stack:
chat, streaming, memory, RAG, tool calling, the agent and the coding agent on a real local model,
and image, speech and long-form video generation with real generators. Every capability in the
status matrix is `PASS` on evidence below. The exception is anything that needs Google Cloud.

**It has not been deployed to a cloud.** Terraform validates. `plan`, `apply` and every
production smoke test need a GCP project and credentials, which this environment does not have.
Those rows are `BLOCKED_EXTERNAL`. This report calls nothing "production ready" beyond what was
verified here.

---

## 1. Architecture

Two separately built and deployed applications, joined by HTTP and SSE and by a types-only
`shared/` package:

```
browser ──HTTP/SSE──▶ frontend (Next.js 16)        backend (Fastify 5, one image, three roles)
                         │                            ROLE=api     HTTP, agent engine, video.plan
                         └──── NEXT_PUBLIC_API_URL ─▶ ROLE=worker  ingestion, scanning, image,
                                                                   speech, video scenes, render
                                                      ROLE=all     both (local development)
                                                          │
                     PostgreSQL + pgvector (PGlite embedded locally, or DATABASE_URL)
                     pg-boss job queues · object storage (local disk or GCS)
                     model runtime: Ollama / any OpenAI-compatible server, or a hosted key
```

The model is behind a capability-aware registry and a router that retries, falls back and trips
a circuit breaker. Authorization is a SQL predicate: every tenant read is `get(projectId, id)`.
The agent is a reasoning loop whose harness owns the limits: iteration and token ceilings,
context-window budgeting, the approval gate, argument validation and deadlines.
[ARCHITECTURE.md](ARCHITECTURE.md) has the details.

## 2. Frontend structure

`frontend/` is a Next.js 16 app with 18 screens: `/`, `/login`, `/signup`, `/chat`,
`/chat/[conversationId]`, `/tasks`, `/agent/[id]`, `/coding/[id]`, `/ask` (RAG), `/files`,
`/memory`, `/images`, `/audio`, `/videos`, `/videos/[id]`, `/usage`, `/platform` and `/settings`.
It imports only types from `shared/`. A syntax-tree checker (`scripts/verify-boundary.sh`,
self-test plus 7 rules) enforces that it reaches no database, queue, filesystem or server
environment variable. It builds and runs on its own: `cd frontend && npm install && npm run
build && npm run test && npm run dev`, verified from a fresh clone.

Screens state what is actually configured. Chat names the model that answers. Images, video and
audio name their provider and label a mock as a mock. A capability with no provider says
"not configured" instead of showing placeholder output.

## 3. Backend structure

`backend/` is a Fastify 5 API with 70 routes, all in [API.md](API.md), which is generated from
the route registrations and checked against real requests. It has 14 packages: `agent-core`,
`model-router`, `memory`, `rag`, `embeddings`, `media`, `tools`, `mcp`, `security`, `quota`,
`jobs`, `database`, `scanning` and `observability`. It has 11 provider adapters: LLM `local`,
`openai`, `anthropic`, `google` and `mock`; image `sdcpp`, `openai` and `mock`; video `motion`,
`replicate` and `mock`.

The database has 23 tables, 47 indexes and 5 migrations. The backend builds, tests and runs on
its own: `cd backend && npm install && npm run build && npm run test && npm run dev`, verified
from a fresh clone.

## 4. Implemented capabilities

| Capability | What exists |
|---|---|
| Auth | scrypt passwords; hashed session tokens and API keys; CSRF double-submit; logout revokes server-side; account deletion |
| Multi-tenancy | organizations, projects and members; RBAC; every content row scoped by `project_id` in SQL; a cross-tenant id answers 404 |
| Chat & streaming | SSE token streaming; conversations stored; rolling summaries within the model's real context window |
| Tool calling | native tools (fs, code, search, terminal, web.fetch with an SSRF guard) plus MCP tools; schema validation; approval gate; audit rows |
| Agent | task graph with persistence, crash recovery, approvals, deadlines and cancellation; an autonomous `reasoning` node |
| Coding agent | `fix_failing_test`: runs the real test, reads and edits the source (`code.replace_text`, `code.apply_patch`), re-runs the test in the loop; the test file is read-only to it |
| Memory | extraction from chat turns (identifiers must match what the user wrote), retrieval into new conversations, a Memory screen, deletion |
| RAG | PDF/DOCX/text upload; malware scan (clamd, optional); chunking; pgvector; cited answers; explicit refusal |
| Image | stable-diffusion.cpp (local) or OpenAI-compatible; async jobs; one run at a time per provider |
| Audio | Piper (offline), OpenAI-compatible or Windows SAPI |
| Video | storyboard written by the model (`video.plan` job) → per-scene still + motion + narration → ffmpeg render with SRT/WebVTT subtitles; resumable; cancellable |
| MCP | stdio and Streamable HTTP (SSE fallback); tools register disabled; the bundled filesystem server confined to the caller's workspace |
| Usage & quota | usage ledger per call; daily/monthly token, image, speech and video-seconds limits checked before work starts |
| Rate limiting | Postgres-shared counters; per-route limits with `Retry-After` |
| Observability | structured JSON logs with request ids across API, jobs and providers; OpenTelemetry spans; Prometheus metrics (API route + `METRICS_PORT` listener for workers) |
| Deployment | two Dockerfiles; `docker-compose.yml` (+ sd.cpp overlay); Terraform for Cloud Run + Cloud SQL + GCS; runbook |

## 5. Runtime verification

The full user journey ran through `scripts/acceptance/full-system.mjs` against running systems.
It checks the content of each result: the words of an answer, the pixels of an image, the samples
of the audio, the streams of the video.

| Run | Where | Result |
|---|---|---|
| Dev run 1 | `node dist/index.js`, PGlite, real providers | 19 PASS · 3 FAIL. CHAT-HISTORY failed on a defect in the check; VIDEO had no narration (storyboard fallback); CODING-AGENT failed (model variance). All three led to fixes. |
| Dev run 2 | same, after those fixes | 19 PASS · 3 FAIL. VIDEO and CHAT-HISTORY PASS. MEMORY failed on a mis-copied digit, which led to the grounding filter; CODING-AGENT failed on a text-written tool call, which led to recovery. |
| **Compose** | the Docker Compose stack: postgres/pgvector, ollama, api, worker and web as separate containers, with the sd.cpp overlay | **23 PASS · 1 FAIL** of 24. METRICS failed: the worker's counters were unreachable, which led to `METRICS_PORT`. **Re-run of METRICS and its prerequisites on the fixed stack: 7 PASS · 0 FAIL.** |

The compose run's checks, all against real providers: AUTH-SIGNUP, AUTH-SESSION (logout revokes;
the replayed cookie gets 401), PROJECT-CREATE, PROVIDERS, CHAT-STREAM, CHAT-HISTORY,
MEMORY-FORMATION, MEMORY-RECALL, MEMORY-DELETE, RAG-INGEST, RAG-ANSWER, RAG-REFUSAL, IMAGE, AUDIO,
VIDEO, CODING-AGENT, MCP, USAGE, QUOTA, AUDIT, TENANT-ISOLATION, PERSISTENCE (logout, then login
again), RATE-LIMIT, and METRICS (after the fix). The result files are in
[evidence/](evidence/).

Also verified:

- A real browser signed up, chatted and reloaded against the compose web container. The answer
  streamed and persisted; the only failed request was the expected pre-login 401 on
  `/auth/me`. Screenshot: `evidence/compose-chat-2026-09-27.jpg`.
- The startup contract passed from a fresh clone of the pushed branch (see §19).

**Measured performance** (4 CPU cores, 16 GB, no GPU; no targets were set, these are
observations):

| Measurement | Value |
|---|---|
| API liveness / authenticated read / readiness (DB + queue), p50 | 2.4 ms / 5.4 ms / 11.4 ms |
| Embedding one ~100-word passage (nomic-embed-text), p50 / p95 | 122 ms / 308 ms |
| Chat: time to first token | 0.45–1.7 s across the acceptance runs (short prompt); 3.6 s p50 in the latency run (longer prompt, with memory retrieval) |
| Chat: interval between tokens, p50 / p95 | 207 ms / 289 ms |
| RAG: ingest a document / answer with citation | ~2 s / ~5 s |
| Memory formed after the turn | 28–33 s |
| Image, SDXL 512×512, 12 steps | 350–456 s |
| Speech, two sentences (Piper) | ~3 s for ~4 s of audio |
| Video, 8 s, 2 narrated scenes | 427–462 s (storyboard 28–37 s) |
| Coding agent, `fix_failing_test` | 211 s, 326 s, 381 s (probes); 496 s (compose run) |

## 6. Real model verification

Every AI capability was exercised against **Ollama `qwen2.5:7b`** (chat, tools and JSON) and
**`nomic-embed-text`** (768-d), not against a mock. Running a real 7B model exposed defects that
no mock could, and each was fixed at its root, with a test that fails without the fix:

- **Silent context truncation.** Ollama's default 4096-token window truncates prompts from the
  front. The harness now reads the real window and fits prompts to it; compose sets 16K.
- **Malformed JSON.** A storyboard came back unusable and the video lost its narration. The fix
  is JSON mode (grammar-constrained on Ollama) plus one corrective retry, both metered. Five of
  five storyboards were then model-written.
- **Hallucinated identifiers.** A codename was stored with one digit changed. Facts whose
  digit-bearing tokens are not in the user's message are now dropped. Four of four memory
  probes then formed and recalled the exact codename.
- **Incomplete and textual tool calls.** Calls written as text (`Ronaldo\n{"name": ...}`) had
  been taken as final answers. Well-formed calls to offered tools are now recovered and run
  through the normal path.
- **Wrong tool use.** The model edited the test instead of the source, which is now refused and
  restored. It edited a file that does not exist; the error now lists the real files. It sent
  diffs with wrong indentation; the error now names the mismatched line. It sent headerless
  diffs; the error now points to `code.replace_text`.
- **Citation-only answers and false grounding.** A refusal carrying `[1]` was reported as
  grounded. RAG now reports an explicit `outcome`.
- **Long-running requests.** The storyboard's 25 s in-request ceiling became a job with a
  180 s deadline. Node deadlines are enforced and reported as timeouts, never as cancellations.

Model variance cannot be removed, and the platform does not pretend otherwise. A failed coding
run ends `FAILED` with the real test output, never `COMPLETED`.

## 7. Image verification

stable-diffusion.cpp (commit `168f7b8`, built from source) runs **SDXL base 1.0**, converted to
q8_0 GGUF. The model was fetched from Docker Hub's `ai/stable-diffusion` artifact because Hugging
Face is unreachable here (`scripts/models/`). The IMAGE check requests a red apple on a wooden
table. It decodes the returned PNG (512×512) and requires real content: luminance stddev 75.9,
420 distinct colours. This was verified through the API in development (350 s) and in the compose
worker container (443 s). Evidence: `evidence/image-red-apple-sdxl-2026-09-27.jpg`. CI runs the
real-model image tests with SD-Turbo. The OpenAI-compatible images adapter is fixture-tested only,
since there are no credentials.

## 8. Audio verification

Piper (`en_US-lessac-low`) runs in the dev backend and inside the API image. The AUDIO check
decodes the WAV and measures it: 16 kHz, 3.9–4.1 s, RMS 0.13–0.17, so silence would fail. It
passed in every run, including compose. Scene narration in the video pipeline uses the same
provider.

## 9. Video verification

For "A short explainer about how bees make honey" (8 s, two 4-s scenes), the pipeline ran as
follows:

1. `video.plan` job: the model wrote the storyboard (`scriptSource: model`), with narration such
   as "Bees start their journey for nectar."
2. Each scene: an SDXL still animated by ffmpeg (image-motion; **motion, not a video model**,
   as it says), plus Piper narration.
3. Render: ffmpeg produced an MP4.

`ffprobe` of the downloaded MP4 shows **h264 video, AAC audio and a mov_text subtitle track,
8.0 s**, plus a valid WebVTT asset. This passed in dev run 2 (427 s) and in compose (462 s, the
plan job in the API container and the scenes and render in the worker).

Evidence: `evidence/video-bees-ffprobe-2026-09-27.json` and `evidence/video-bees-frame-2026-09-27.jpg`.
The frame shows the low fidelity of SDXL at 512 px and 12 steps. A real video model is the
Replicate adapter, which is fixture-tested only because there is no token.

## 10. Coding-agent verification

The check writes a real project: `sum.js` returns `a - b`, and `sum.test.cjs` asserts
`sum(2, 3) === 5`. It creates a `fix_failing_test` task and afterwards re-runs the test
**independently**, on the files as the API serves them. Current build:

| Run | Result | Time | Test file | Independent re-run |
|---|---|---|---|---|
| Probe 1 | COMPLETED | 211 s | unchanged | exit 0 |
| Probe 2 | COMPLETED | 381 s | unchanged | exit 0 |
| Probe 3 | COMPLETED | 326 s | unchanged | exit 0 |
| Compose acceptance | COMPLETED | 496 s | unchanged | exit 0 |

The logs show the loop the brief asks for. The agent runs the test and reads the failure, reads
the source, edits it (one diff refused with the reason, then `code.replace_text` succeeds),
re-runs the test and answers. On earlier builds the same check failed in dev acceptance runs 1
and 2 and in a probe, each time ending `FAILED` with the source untouched. Those failures are how
the agent fixes in §6 were found. Evidence: `evidence/coding-agent-probes-2026-09-27.log`, and the
acceptance files.

## 11. Security verification

- **Tenant isolation, live:** another tenant's conversation, document and workspace file each
  return 404 (compose TENANT-ISOLATION). The Playwright suite asserts cross-tenant 404s in a
  browser.
- **A cross-tenant read found and fixed:** the bundled MCP filesystem server spans every
  project's workspace. Its path arguments are now confined to the caller's workspace. The real
  server is tested with a control case that reads the other tenant's secret when the confinement
  is removed. Live, a probe for another project's directory was refused (compose MCP check).
- **Sessions:** logout revokes server-side, so a replayed cookie gets 401. Rate limit: 429 with
  `Retry-After`. Quota: 429 `QUOTA_EXCEEDED` before any work, and nothing created.
- **Agent sandbox:** `DockerSandbox` is verified in a real container (4/4: no network, read-only
  root, dropped capabilities, one workspace), locally and in CI. The coding agent cannot modify
  its test.
- **No fake output in production:** mock providers are opt-in, and production refuses them.
- **CI security job:** gitleaks over full history; `npm audit --audit-level=high` exits 0 (six
  moderate advisories remain, each assessed in SECURITY.md: four are in a dev-only tool chain; two
  are in the GCS client's dependencies, in a function the platform does not call); the
  no-fake-in-production assertion.
- **Known, stated limits:** the compose stack runs agent commands under the process sandbox (no
  Docker socket is mounted). The rate limiter fails open. There is no SSO or MFA. `web.fetch` is
  an exfiltration channel unless `WEB_FETCH_ALLOWLIST` is set. See [SECURITY.md](SECURITY.md).

## 12. Database verification

- **Embedded:** PGlite with pgvector serves development and the whole test suite (real
  migrations, real pg-boss).
- **Standalone Postgres 16 + pgvector:**
  - The compose stack ran all 24 acceptance checks on it.
  - CI now boots the built API image against `pgvector/pgvector:pg16` and checks that the
    migrations created all 23 tables.
  - Starting that path found a bug that stopped every standalone-Postgres boot: pg-boss 12
    rejected an explicit `backend: undefined`. It is fixed, with a test.
- **Persistence:** data survived logout and login in the PERSISTENCE check.

## 13. E2E verification

- **Browser:** Playwright runs **14 tests in 5 specs** in a real Chromium against the real API and
  a real database. The specs cover chat and history, auth and cross-tenant isolation, account
  security, the admin boundary, and the autonomous agent with live SSE and approval. Result:
  **14 passed** locally (Chromium). The CI `e2e` job is green.
- **System:** the full-system acceptance ran against the dev backend and against the compose
  stack (§5), plus a browser smoke test against the compose web container.

## 14. Docker verification

- **Images:** `backend/Dockerfile` (API and worker, with ffmpeg, Piper and a voice) and
  `frontend/Dockerfile` both build in CI.
- **Boots in CI:** the API image boots in the worker role with no LLM key, and boots against a
  real Postgres.
- **Compose stack, run here:**
  - `docker compose -f docker-compose.yml -f docker-compose.sdcpp.yml up -d` brought up
    postgres, ollama, api, worker and web.
  - All five services are healthy. The API applies migrations; the worker registers its six
    queues and serves `/metrics` on 9464; the web app serves the UI.
  - Acceptance and browser checks ran against the stack (§5).
- **Local build difference:** this environment cannot reach `deb.debian.org`. The local API image
  therefore used a verification-only variant of `backend/Dockerfile`, identical except that its
  runtime stage is `ubuntu:24.04` instead of `node:24-bookworm-slim`. The application build stage
  is unchanged. The committed Debian Dockerfile is the one CI builds and boots.
- **Real-container sandbox:** DockerSandbox 4/4.

## 15. Terraform verification

`infrastructure/terraform/` defines Cloud Run (API service, worker pool, web), Cloud SQL
Postgres, Cloud Storage, Artifact Registry, secrets and a clamd sidecar.

- **Passes:** `terraform fmt -check`, `init` and `validate` (CI, and locally from a filesystem
  provider mirror because the registry is unreachable here).
- **Blocked:** `terraform plan` and `apply` need a GCP project and credentials, so they are
  **BLOCKED_EXTERNAL**.
- **Known gap:** there is no remote state backend. Configure one before any shared use.

## 16. Cloud deployment verification

**BLOCKED_EXTERNAL.** Nothing has been deployed, and no production smoke test has run. The
required access and steps:

- **Needed:** a GCP project with billing and a budget alert, and credentials for `terraform` and
  `gcloud`.
- **Deploy steps:** follow `infrastructure/DEPLOYMENT_RUNBOOK.md`:
  1. The bootstrap apply.
  2. Build and push both images.
  3. The full apply.
  4. Migrations through the Cloud SQL Auth Proxy.
  5. Its verification list: health, auth, the api/worker split, GCS assets, upload scanning with
     EICAR, and `TRUST_PROXY_HOPS`.
- **To run the acceptance there:** set `ACCEPT_API_URL` to the service, run
  `node scripts/acceptance/full-system.mjs`, and add the worker's metrics endpoint if one is
  exposed.
- **Image generation on Cloud Run** needs either sd.cpp baked into an image or a GPU image service
  behind `IMAGE_BASE_URL`. The Terraform configures neither.

## 17. CI verification

`.github/workflows/ci.yml` runs on GitHub Actions (push, pull request and `workflow_dispatch`):

- **`build-and-test`:** install, build, typecheck, lint, boundary, API-doc drift, migrations, and
  the full suite with real clamd, fake-gcs-server, ffmpeg, Piper and stable-diffusion.cpp +
  SD-Turbo. It asserts that no gated suite skipped.
- **`frontend`:** unit tests and build.
- **`e2e`:** Playwright.
- **`security`:** gitleaks, audit, no-fake-in-production.
- **`infrastructure`:** real-container sandbox suite, both image builds, boot in the worker role,
  **boot against real Postgres**, `terraform fmt` and `validate`.

Green runs this pass: 36311897333, 36316998578, 36319558071, 36322243655, 36324867561, and the
final run on `0487870`: **36327781128, all five jobs green**, including the zero-skip assertion and the real-Postgres boot. One run failed, 36324427930 on `1b6ec04`: the typecheck step
caught a mistyped test mock. It was fixed in `d163202`, not bypassed.

## 18. Remaining blockers

Only external ones remain:

1. **GCP project and credentials.** Needed for `terraform plan`/`apply`, the Cloud Run
   deployment and its smoke tests, verifying `TRUST_PROXY_HOPS` against the real front end, and
   exercising real Cloud SQL, GCS and the clamd sidecar.
2. **Hosted provider credentials** (optional; the platform runs fully without them). The
   OpenAI, Anthropic and Google LLM adapters, the OpenAI-compatible images adapter and the
   Replicate video adapter are fixture-tested but have served no real request.

Not blockers, but worth knowing:

- A 7B model on CPU is slow (see §5) and sometimes wrong. The harness contains the damage.
- SDXL at 512 px is low-fidelity.
- The compose stack's agent sandbox is process-level.

## 19. Exact commands to run locally

```bash
# Each application on its own (Node 22+). Optional model runtime:
ollama pull qwen2.5:7b && ollama pull nomic-embed-text        # OLLAMA_CONTEXT_LENGTH=16384
cd backend  && npm install && npm run build && npm run test && npm run dev   # :8787
cd frontend && npm install && npm run build && npm run test && npm run dev   # :3000

# The whole repository's gates
npm ci && npm run build && npm run typecheck && npm run lint && npm test
bash scripts/verify-boundary.sh && bash scripts/verify-boot.sh
npm run test:docker -w @ai-platform/security            # needs Docker
cd frontend && npx playwright test                       # browser E2E

# The stack in containers
docker compose up -d --build
docker compose --profile setup run --rm ollama-pull
SD_CLI_DIR=/opt/sd SD_MODEL_DIR=/opt/models IMAGE_SD_MODEL_FILE=<model> \
  docker compose -f docker-compose.yml -f docker-compose.sdcpp.yml up -d   # optional images/video

# Acceptance and latency against whatever is running
ACCEPT_ADMIN_EMAIL=… ACCEPT_ADMIN_PASSWORD=… \
ACCEPT_EXTRA_METRICS_URLS=http://127.0.0.1:9464/metrics \
  node scripts/acceptance/full-system.mjs
node scripts/acceptance/latency.mjs

# Terraform (static)
terraform -chdir=infrastructure/terraform init -backend=false && terraform -chdir=infrastructure/terraform validate
```

## 20. Final status matrix

| Capability | Code | Local | E2E | Real Runtime | Production | Status |
|---|---|---|---|---|---|---|
| Auth | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Multi-tenancy | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Chat | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Streaming | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Tool calling | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Agent | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Coding agent | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Memory | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| RAG | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Image | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Audio | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Video | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| MCP | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Usage | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Quota | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Security | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Observability | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Docker | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Terraform | PASS | PASS | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL |
| CI/CD | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Frontend | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |
| Backend | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS |

Column definitions, and the completion gate, are in [PROJECT_STATUS.md](PROJECT_STATUS.md).
Automated tests at `69de762` (`0487870` after it adds only an app icon): **1175 passed, 0 failed, 2 skipped** across 136 files; the two skips are the real-model image and video suites, which need a stable-diffusion model file and run in CI with SD-Turbo. Typecheck: 0 errors; lint: 0 errors.
