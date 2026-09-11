# Test Report

**Date:** 2026-09-11 · **Commit:** `c6cf1a1`

**Result: 524 test cases across 63 files — 524 passing, 0 skipped, 0 failures.
Plus 7 end-to-end tests in a real browser, 7/7 boot checks, 0 lint errors and 0 type errors
across 26 workspaces.**

**Every environment-gated suite now runs for real.** The previous report listed 13 skips against
binaries that were not installed; ffmpeg, ClamAV, fake-gcs-server, Terraform and a real local LLM
runtime have since been installed under `.local-tools/` (ADR-078), so those suites execute rather
than skip. A skipped test is not a passing test (product brief §29) — and there are now none.

## Totals

| | Original audit | Previous report | Now |
|---|---|---|---|
| Test files | 35 | 50 | **63** |
| Test cases | 189 | 429 | **524** |
| Passing | 189 | 416 | **524** |
| Skipped | 0 | 13 | **0** |
| Failures | 0 | 0 | **0** |
| End-to-end (real browser) | 0 | 7 | **7** |
| Boot configurations verified | 0 | 7 | **7** |
| Lint errors | *no linter existed* | *no linter existed* | **0** |
| Type errors | 0 | 0 | **0** |

## By package

| Package | Files | Tests |
|---|---|---|
| `apps/api` | 8 | 60 |
| `apps/web` | 2 | 23 |
| `packages/agent-core` | 4 | 49 |
| `packages/database` | 1 | 3 |
| `packages/embeddings` | 1 | 3 |
| `packages/jobs` | 2 | 16 |
| `packages/mcp` | 4 | 39 |
| `packages/media` | 4 | 26 |
| `packages/memory` | 1 | 17 |
| `packages/model-router` | 2 | 16 |
| `packages/observability` | 4 | 26 |
| `packages/providers/image-mock` | 1 | 4 |
| `packages/providers/image-openai` | 1 | 8 |
| `packages/providers/llm-anthropic` | 1 | 11 |
| `packages/providers/llm-google` | 1 | 12 |
| `packages/providers/llm-local` | 1 | 12 |
| `packages/providers/llm-openai` | 1 | 13 |
| `packages/providers/video-mock` | 2 | 8 |
| `packages/providers/video-replicate` | 3 | 31 |
| `packages/quota` | 1 | 11 |
| `packages/rag` | 8 | 44 |
| `packages/scanning` | 1 | 7 |
| `packages/security` | 3 | 32 |
| `packages/shared` | 1 | 7 |
| `packages/tools` | 5 | 46 |

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

## End-to-end (`apps/web/e2e`, real browser)

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

## Boot verification (`scripts/verify-boot.sh`, 7/7)

Runs the real built entrypoint in five configurations, because the ADR-060 regression — a worker
pool that crash-looped on every boot — was invisible to every unit test.

## Character of the suite

Overwhelmingly **integration tests against real infrastructure**: a real embedded PostgreSQL with
real migrations and pgvector, real pg-boss queues, real HTTP through Fastify's `inject()`, real
spawned processes, real GIF/PDF/DOCX/ZIP codecs, a real `clamd` detecting a real EICAR sample, a
real `fake-gcs-server`, a real ffmpeg, a real speech synthesiser, and a real browser.

Several suites exist specifically because a mock could not have caught the defect they cover:

- `packages/tools/terminal-isolation.test.ts` — runs a real child process and asserts no canary
  secret appears **anywhere** in its environment. An assertion about how `spawn` was configured
  would pass while the process still leaked (ADR-077).
- `packages/providers/video-replicate/billing-safety.test.ts` — reproduces an orphaned prediction
  that kept billing, and a body read that hung past its deadline (ADR-085).
- `packages/mcp/loopback.test.ts` — pins `127.0.0.1.attacker.tld` as **not** loopback (ADR-083).
- `packages/observability/metrics.test.ts` — asserts the real Prometheus exposition; a recorder
  writing to a no-op meter satisfies a spy and produces an empty scrape (ADR-082).
- `packages/jobs/dead-letter.test.ts` — `deadLetter` compiled fine while never being set, and
  `fetch()`'s types say nothing about it claiming jobs (ADR-072).

## What the tests still do NOT cover

- **The Docker sandbox has never executed a container.** No Docker CLI, no service, no WSL, and no
  administrator rights to install Docker Desktop — verified, not assumed. `DockerSandbox` is
  covered by unit tests only.
- **No hosted provider has served a request.** The OpenAI, Anthropic, Google and Replicate adapters
  are fixture-tested against recorded wire shapes; no credentials exist here. The **self-hosted**
  path is fully exercised.
- **`docker build` and `terraform apply` have not run.** Terraform validates; applying needs a GCP
  project. CI has never executed — the repository has no remote.
