# Test Report

**Date:** 2026-09-13 · **Commit:** `fd5f5a5`

**Result: 705 passing, 1 skipped, 0 failures, across 86 test files.**
Plus 7 end-to-end tests in a real browser, 8/8 boundary checks (a self-test and 7 rules), 7/7 boot
checks, 3/3 migration checks, 0 type errors in every workspace, and 0 lint errors with 5
`no-console` warnings.

**What the previous edition (`fa296c6`) got wrong.** Its headline said 654 cases across 79 files,
while its Totals table still carried 556 tests and 69 files from an earlier edition, and its
By-package table added up to neither. Two counts in one report, and only one of them came from a
run. Both tables below are now taken from the `npm test` run on `fd5f5a5`. It also described a CI
gate that could not pass: the zero-skip step fails the build on any skip, and the long-form video
suite skipped on every machine that was not Windows, so on CI's Linux runner that step would have
failed every run (third audit, finding #24). The suite now uses a deterministic PCM tone where no
speech synthesiser exists, verified here with the tone path forced. The Linux run itself is still
unobserved, because CI has never executed.

**An earlier edition was wrong in a different way, and how it was wrong matters more than the
number.** It claimed "556 passing, 0 failures" and that was true on an idle machine. An
independent audit ran the same command on a loaded one and got between 1 and 8 failures with a
different count each run — every one a hook or test timeout, because vitest's 5s/10s defaults are
sized for unit tests against fakes and almost nothing here is that: a typical `beforeEach` builds
an embedded Postgres and runs every migration. So the product code was fine and the GATE was
broken, which is worse: a gate that goes red on a busy CI runner teaches everyone to ignore it,
and CI runs on a shared runner by definition. ADR-100 sizes the timeouts for the infrastructure
these tests actually use.

**Every environment-gated suite now runs for real.** The previous report listed 13 skips against
binaries that were not installed; ffmpeg, ClamAV, fake-gcs-server, Terraform and a real local LLM
runtime have since been installed under `.local-tools/` (ADR-078), so those suites execute rather
than skip. A skipped test is not a passing test (product brief §29). The one skip that remains is
not an environment gate in that sense: it is a file-symlink containment case that Windows refuses
without elevation. It used to catch that refusal and `return` — zero assertions, counted as a
PASS — and a second audit caught it. It is now reported as a skip locally. On Linux, where file
symlinks work, CI is expected to run it, and the CI gate fails the build on any skip, so it cannot
silently stop running there. That expectation has not been observed, because CI has never executed.

## Totals

| | Original audit | Previous edition (`fa296c6`) | Now (`fd5f5a5`) |
|---|---|---|---|
| Test files | 35 | 79 | **86** |
| Passing | 189 | 653 | **705** |
| Skipped | 0 | 1 | **1**: the Windows file-symlink case. CI expects 0 |
| Failures | 0 | 0 | **0** |
| End-to-end (real browser) | 0 | 7 | **7** |
| Boundary checks | — | 9/9 | **8/8**: a self-test and 7 rules. Not comparable, because ADR-111 replaced the greps with a syntax-tree checker |
| Boot configurations verified | 0 | 7 | **7** |
| Migration checks | *none existed* | 3 | **3** |
| Lint errors | *no linter existed* | 0 | **0**, with 5 `no-console` warnings |
| Type errors | 0 | 0 | **0** |

## By package

From the `npm test` run on `fd5f5a5`, per workspace as the runner reports them, largest first.

| Package | Workspace | Files | Tests |
|---|---|---|---|
| `backend/packages/tools` | `tools` | 9 | 114 (+1 skipped) |
| `backend` | `api` | 15 | 91 |
| `backend/packages/security` | `security` | 5 | 65 |
| `backend/packages/agent-core` | `agent-core` | 4 | 52 |
| `backend/packages/rag` | `rag` | 9 | 47 |
| `backend/packages/mcp` | `mcp` | 4 | 39 |
| `backend/packages/media` | `media` | 8 | 39 |
| `frontend` | `web` | 5 | 34 |
| `backend/packages/memory` | `memory` | 2 | 32 |
| `backend/packages/providers/video-replicate` | `video-replicate` | 3 | 31 |
| `backend/packages/observability` | `observability` | 4 | 26 |
| `backend/packages/jobs` | `jobs` | 3 | 18 |
| `backend/packages/model-router` | `model-router` | 2 | 18 |
| `backend/packages/providers/llm-openai` | `llm-openai` | 1 | 13 |
| `backend/packages/providers/llm-google` | `llm-google` | 1 | 12 |
| `backend/packages/providers/llm-local` | `llm-local` | 1 | 12 |
| `backend/packages/quota` | `quota` | 1 | 11 |
| `backend/packages/providers/llm-anthropic` | `llm-anthropic` | 1 | 11 |
| `backend/packages/providers/image-openai` | `image-openai` | 1 | 8 |
| `backend/packages/providers/video-mock` | `video-mock` | 2 | 8 |
| `backend/packages/scanning` | `scanning` | 1 | 7 |
| `shared` | `shared` | 1 | 7 |
| `backend/packages/providers/image-mock` | `image-mock` | 1 | 4 |
| `backend/packages/database` | `database` | 1 | 3 |
| `backend/packages/embeddings` | `embeddings` | 1 | 3 |
| **Total** | | **86** | **705 (+1 skipped)** |

## Verified against real infrastructure, live

These were run against the running platform, not in a test harness:

| Claim | Evidence |
|---|---|
| A real LLM completes a request | `qwen2.5:1.5b` on a local Ollama runtime, streamed through `POST /api/v1/chat`, real token accounting (34 in / 2 out) |
| Real tool calling | The model chose `fs_list_directory` and emitted a real `tool_calls` finish reason |
| Real embeddings | `nomic-embed-text`, 768 dimensions, zero-padded to the column width |
| **Memory changes a real model's answer** | Stored "My production cluster codename is ORION-4"; a later conversation answered "ORION-4" — a fact the model could not otherwise know |
| **Real RAG end to end** | Uploaded a runbook, real ingestion → chunking → embedding → pgvector retrieval at distance 0.267 → real answer with citation `[1]` resolving to the real file |
| **Grounding refuses rather than fabricates** | Asked an unanswerable question: "The passage does not provide any information about…" — the same path previously invented "Document 12" |
| Cross-tenant isolation | A second account aiming its own valid session at another's project: **404** |
| Model-driven autonomous agent | 2 reasoning iterations, 2 real `tool.call` spans, an honest answer about what it found |
| **Long-form video** | A prompt produced a model-written script ("The Keeper's Call"), two synthesised narration tracks, and an MP4 that `ffprobe` reports as `h264` + `aac` + `mov_text`, 8.203s |
| Real metrics | `token_usage_total{direction="input"} 32`, `provider_request_count`, `tool_call_count{status="error"}` in real Prometheus exposition |
| MCP tool policy | 14 discovered tools, **0 enabled**; 8 native tools, 8 enabled |
| Rate limiting across instances | `AUTH_RATE_LIMIT_MAX=3` → 201, 201, 201, **429**, **429**, counters visible in Postgres |
| Terraform | `fmt -check` clean, `init`, `validate` **Success** — the first time the IaC has ever been validated |

## Verified this phase (third audit, 2026-09-13)

The third audit's fixes (ADR-108 to ADR-112) each have a test written to fail on the old code, or a
live run. These are the ones where an ordinary passing test would not have been enough:

| Claim | Evidence |
|---|---|
| **From a fresh clone, the backend starts alone and the frontend builds alone** | A `git clone` of `fd5f5a5` with 0 files in `shared/dist`. `npm ci` exited 0 in 43 s. `cd backend && npm run dev` answered `GET /api/health` with `{"status":"ok"}` after its `predev` build, and `cd frontend && npm run build` exited 0 through its `prebuild`. Before ADR-112 the documented `cd backend && npm install && npm run dev` could not start there (finding #42) |
| **A worker-role shutdown is clean** | `ROLE=worker`, SIGINT: exit 0. Every worker-role graceful shutdown used to fail a step and exit 1, on an MCP manager that role never constructs (finding #12, ADR-108) |
| **The long-form video suite runs without a Windows synthesiser** | 3/3 with Windows SAPI speech, and 3/3 again with the PCM tone path forced. It used to skip unless the platform was Windows, which made CI's zero-skip gate impossible to pass on Linux (finding #24, ADR-111) |
| **The API document is checked against the server** | `backend/src/routes/api-contract.test.ts` sends a real request for every row of `docs/API.md`. Run against the previous document, it fails and names each wrong row: dead-letter replay published as administrator-only, login and logout as needing a credential, `me` and the `projects` routes as `project:admin`, and one rate limit (findings #23, #26, ADR-112) |
| **A caller cannot choose its own address** | `backend/src/trust-proxy.test.ts` asserts the address a failed login's audit row records at 0, 1 and 2 trusted hops. Restoring `trustProxy: true` makes it fail (ADR-112) |
| **The boundary checker can fail** | `scripts/verify-boundary.sh` 8/8. Its self-test catches all 39 planted violations and reports nothing in the 10 clean files. Each of 15 mutants that disables one rule or one import form is killed by that self-test. The 7 rules then run over 275 parsed source files (ADR-111) |
| **Each conversation-window fix is load-bearing** | A mutant of each ADR-110 fix is killed by a test. One guard's mutant survived: refusing a live window that begins on an orphaned tool result after a failed pass. That guard was removed as unreachable, with the reasoning in ADR-110 |
| **The Docker suite refuses to skip** | `npm run test:docker -w @ai-platform/security` fails here, where Docker is not installed, instead of skipping (ADR-111). It has never passed, because it has never had a container runtime |

## End-to-end (`frontend/e2e`, real browser)

Playwright starts both applications itself — the real API against a real embedded Postgres and the
**production build** of the web app — so what is tested is what would deploy.

| Test | What it proves |
|---|---|
| signed-out redirect | An unauthenticated visitor reaches no data |
| signup | Account, organization and default project really created |
| sign-out | The session ends and protected screens stop rendering |
| wrong password vs unknown account | **Identical** message and timing — no account enumeration |
| **cross-tenant isolation** | A second account gets **404** — not 403, and not data |
| usage screen | Real project-scoped figures render |
| platform screen | Real models/tools/MCP/jobs; a mock model is labelled **"MOCK — not a real model"** |

That 404 is what a **session** gets for a project it is not a member of, so an outsider cannot learn
that a project id exists. An **API key** is bound to one project, and a key that names a different
project is refused with 403 (`requireProject` in `backend/src/plugins/auth.ts`). `docs/API.md` said
"404, never 403" until ADR-112 corrected it (finding #41).

## Boot verification (`scripts/verify-boot.sh`, 7/7)

Runs the real built entrypoint in five configurations, because the ADR-060 regression — a worker
pool that crash-looped on every boot — was invisible to every unit test.

## Character of the suite

Overwhelmingly **integration tests against real infrastructure**: a real embedded PostgreSQL with
real migrations and pgvector, real pg-boss queues, real HTTP through Fastify's `inject()`, real
spawned processes, real GIF/PDF/DOCX/ZIP codecs, a real `clamd` detecting a real EICAR sample, a
real `fake-gcs-server`, a real ffmpeg, a real speech synthesiser where the platform has one (Windows
SAPI; elsewhere the long-form suite uses a deterministic PCM tone, declared `isMock` and constructed
only in that test file), and a real browser.

Several suites exist specifically because a mock could not have caught the defect they cover:

- `backend/src/routes/api-contract.test.ts`: regenerating `docs/API.md` cannot catch a generator
  that is wrong, so this suite checks each documented row's guard and rate limit against the
  running server (ADR-112).
- `backend/packages/tools/terminal-isolation.test.ts` — runs a real child process and asserts no canary
  secret appears **anywhere** in its environment. An assertion about how `spawn` was configured
  would pass while the process still leaked (ADR-077).
- `backend/packages/providers/video-replicate/billing-safety.test.ts` — reproduces an orphaned prediction
  that kept billing, and a body read that hung past its deadline (ADR-085).
- `backend/packages/mcp/loopback.test.ts` — pins `127.0.0.1.attacker.tld` as **not** loopback (ADR-083).
- `backend/packages/observability/metrics.test.ts` — asserts the real Prometheus exposition; a recorder
  writing to a no-op meter satisfies a spy and produces an empty scrape (ADR-082).
- `backend/packages/jobs/dead-letter.test.ts` — `deadLetter` compiled fine while never being set, and
  `fetch()`'s types say nothing about it claiming jobs (ADR-072).

## What the tests still do NOT cover

- **No real container has run.** No Docker CLI, no service, no WSL, and no administrator rights to
  install Docker Desktop — verified, not assumed. `sandbox-docker.test.ts` asserts the arguments
  `dockerRunArgs` builds: every isolation flag, the single workspace mount, environment scrubbing
  and the containment refusal. Whether those flags contain a process in a real container is
  unverified. The real-container suite (`npm run test:docker`) is written and has never run, and
  `docker build` has never run. The previous edition's "covered by unit tests only" had no test
  behind it when it was written (finding #25).
- **No hosted provider has served a request.** The three hosted LLM adapters (OpenAI, Anthropic,
  Google), the OpenAI image adapter and the Replicate video adapter make real HTTP and are
  fixture-tested against recorded wire shapes. No credentials exist here. The **self-hosted**
  OpenAI-compatible adapter is verified end to end against a real local model. The mocks make no
  network calls and are never constructed in production.
- **CI has never executed.** The repository has no remote. Every step was run locally, and the
  zero-skip step now has a way to pass on Linux, which it did not before. No Linux run has been
  observed, including the file-symlink case that is skipped on Windows.
- **No load or concurrency testing.** No test drives concurrent users or measures throughput, and
  the API and worker roles have never run at the same time against one database.
- **Cloud Run's real `X-Forwarded-For`.** `trust-proxy.test.ts` checks the hop arithmetic against
  headers the test writes itself. Terraform sets `TRUST_PROXY_HOPS=1` for Cloud Run's front end,
  and no request has passed through a real one. `terraform apply` has not run, because there is no
  GCP project; Terraform only validates.
