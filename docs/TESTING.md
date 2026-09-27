# Testing

Every layer below is a command you can run, and every number is from a run on 2026-09-27
(branch `claude/zen-brahmagupta-6l5o4u`, Linux, Node 22). No layer passes on a mock where
the real thing is available: mocks are opt-in (`ALLOW_MOCK_PROVIDERS=true`), used by unit tests
and the browser suite's deterministic chat, and refused in production.

## The layers

| Layer | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | 0 errors, every workspace |
| Lint | `npm run lint` | 0 errors, 5 `no-console` warnings (CLI scripts) |
| Unit + integration + API | `npm test` | **1137 passed, 2 skipped, 0 failed**, 132 test files |
| Frontend unit | part of `npm test` (`@ai-platform/web`, Vitest + Testing Library) | included above |
| Browser end-to-end | `cd frontend && npx playwright test` | 14 tests in 5 specs, real API + real database |
| Real-container sandbox | `npm run test:docker -w @ai-platform/security` | 4/4 against Docker 29 |
| Boot | `bash scripts/verify-boot.sh` | the built entrypoint in every role and configuration |
| Boundary | `bash scripts/verify-boundary.sh` | self-test + 7 rules |
| API contract | part of `npm test` (`api-contract.test.ts`), plus `npm run docs:api` drift check in CI | one real request per documented route |
| Full-system acceptance | `node scripts/acceptance/full-system.mjs` | see below; needs a running API |

### What "integration" means here

The suite runs against real infrastructure, not doubles: an embedded PostgreSQL (PGlite) with the
real migrations and pgvector, real pg-boss queues, real HTTP through Fastify's `inject()`, spawned
child processes, real PDF/DOCX/ZIP parsing, OpenTelemetry span trees, Prometheus exposition, and —
when their binaries are present — a real `clamd` scanning a real EICAR sample, a real
`fake-gcs-server`, real `ffmpeg`/`ffprobe` rendering a narrated, subtitled MP4, real Piper speech,
and real stable-diffusion.cpp image and motion-video generation.

Point the suite at the binaries with environment variables (this is `.local-tools/test-env.sh` on
the machine that produced the numbers above; CI installs the same tools):

```bash
export FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe
export PIPER_PATH=/opt/tools/piper/piper PIPER_VOICE=/opt/tools/voices/en-us-lessac-low.onnx
export CLAMD_BIN=/usr/sbin/clamd FAKE_GCS_SERVER_BIN=/opt/tools/fake-gcs-server
# optional — the two real-model suites below
export IMAGE_SD_CLI_PATH=/opt/tools/sd/sd-cli IMAGE_SD_MODEL_PATH=/opt/models/sd_turbo.safetensors
```

### The two skips

`image-sdcpp` "against the real model" and `video-motion` "end to end" are
`describe.skipIf(!IMAGE_SD_CLI_PATH || !IMAGE_SD_MODEL_PATH)`: they generate real images and need
a model file. CI downloads SD-Turbo and runs both, and its **"Assert the gated suites actually
ran"** step fails the build if any gated suite skipped there. Locally they were run against SDXL
base (see [MEDIA.md](MEDIA.md)); the 2 skips above are from the run without `IMAGE_SD_*`.

## Full-system acceptance

`scripts/acceptance/full-system.mjs` drives the user journey against a running API with real
providers and checks the **content** of each result, not its status code:

| Check | What must be true |
|---|---|
| AUTH-SIGNUP, AUTH-SESSION | an account is created; logout revokes the session server-side (the replayed cookie gets 401); login again works |
| PROJECT-CREATE | a second project is created and listed; later checks run in it |
| PROVIDERS | the configured providers are real (`isMock: false`) |
| CHAT-STREAM | more than one token event, spread over time, from the real model, with token usage |
| CHAT-HISTORY | a word planted in one turn is answered two turns later, continuing from the stored history |
| MEMORY-FORMATION / RECALL / DELETE | a fact told in chat is extracted by the model, recalled in a **new** conversation, and deleted |
| RAG-INGEST / ANSWER / REFUSAL | an uploaded document is ingested; a question is answered with a citation of the right passage; an unanswerable one is refused with `outcome: refused` |
| IMAGE | a PNG whose decoded pixels are not flat (luminance spread, distinct colours) |
| AUDIO | a WAV of plausible duration whose samples are not silence (RMS) |
| VIDEO | an MP4 with H.264 + AAC + subtitle streams (ffprobe), a WebVTT asset, narrated scenes |
| CODING-AGENT | a failing test in a real project is made to pass by editing the source; the test file is unchanged |
| MCP | the bundled MCP filesystem server reads a planted word inside an agent task and the model answers with it; the same tool refuses another project's directory |
| USAGE, AUDIT | real token counts; the project's own audit rows and no other project's |
| QUOTA | with `MONTHLY_VIDEO_SECONDS_LIMIT` set, a video over the remaining budget is refused with 429 `QUOTA_EXCEEDED` and nothing is created (BLOCKED_EXTERNAL when no limit is configured) |
| TENANT-ISOLATION | a second account gets 404 for the first account's resources |
| METRICS | the Prometheus counters for requests, provider calls, tokens, generations, jobs and tool calls are non-zero |
| PERSISTENCE | after logout and login, the conversations, memories, documents and media are still there |
| RATE-LIMIT | the per-route limit answers 429 |

Each check is `PASS`, `FAIL` or `BLOCKED_EXTERNAL` (a capability whose provider is not configured
is BLOCKED_EXTERNAL, never PASS). Results go to `$ACCEPT_OUT/full-system.json` and `.md`.

```bash
ACCEPT_API_URL=http://127.0.0.1:8787 \
ACCEPT_ADMIN_EMAIL=admin@example.com ACCEPT_ADMIN_PASSWORD=... \
ACCEPT_OUT=./acceptance-out node scripts/acceptance/full-system.mjs
```

The admin credentials are needed for the METRICS and MCP checks (reading metrics and enabling an
MCP tool are system-administrator actions). The latest committed results are in
[evidence/](evidence/).

`scripts/acceptance/latency.mjs` measures a running stack without asserting anything: liveness,
an authenticated read, the database/queue readiness probe, an embedding call, and chat time to
first token and inter-token interval, each as p50/p95/max.

## CI

`.github/workflows/ci.yml` (on push, pull request and `workflow_dispatch`) runs five jobs:
`build-and-test` (build, typecheck, lint, boundary, API-doc drift, migrations, the full suite with
fake-gcs-server, clamd, ffmpeg, Piper and stable-diffusion.cpp + SD-Turbo installed, and the
assertion that no gated suite skipped), `frontend` (web unit tests and build), `e2e` (Playwright
against the real API), `security` (gitleaks over history, `npm audit --audit-level=high`, the
no-fake-in-production assertion) and `infrastructure` (the real-container sandbox suite, both
Docker images built, the API image booted in the worker role with no LLM key, `terraform fmt`
and `terraform validate`).
