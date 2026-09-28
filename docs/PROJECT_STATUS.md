# Project status

**Last verified:** 2026-09-28, branch `claude/zen-brahmagupta-6l5o4u`.
The commits for each run are in [FINAL_PRODUCTION_READINESS_REPORT.md](FINAL_PRODUCTION_READINESS_REPORT.md).

## States

Every cell uses exactly one of these values. Each state is reached only through the one before
it, except `BLOCKED_EXTERNAL`.

| State | Means |
|---|---|
| `NOT_STARTED` | No code. |
| `IN_PROGRESS` | Code exists and is not finished. |
| `IMPLEMENTED` | Code is complete and has unit or route tests. |
| `LOCALLY_VERIFIED` | Its automated tests pass: `npm test`, locally and on GitHub Actions. |
| `E2E_VERIFIED` | Exercised end to end through the running system: Playwright against the real API and database, or an acceptance script over HTTP. |
| `REAL_RUNTIME_VERIFIED` | Exercised against real providers with no mocks, and the *output* inspected. The providers are Ollama (`qwen2.5:7b`, `nomic-embed-text`), stable-diffusion.cpp (SDXL), Piper, ffmpeg, and Postgres 16 with pgvector, run in the Docker Compose stack. |
| `PRODUCTION_VERIFIED` | Exercised in a deployed cloud environment. **No row has this state.** |
| `BLOCKED_EXTERNAL` | Cannot be verified here for a reason outside the repository. For every Production cell, the reason is a GCP project with credentials ([PRODUCTION_DEPLOYMENT_BLOCKER.md](PRODUCTION_DEPLOYMENT_BLOCKER.md)). |

## Commands the matrix refers to

| Short name | Command |
|---|---|
| `unit` | `npm test` (with `.local-tools/test-env.sh` sourced, the binary-gated suites run too) |
| `e2e` | `cd frontend && npx playwright test` |
| `accept` | `ACCEPT_API_URL=… ACCEPT_ADMIN_EMAIL=… ACCEPT_ADMIN_PASSWORD=… node scripts/acceptance/full-system.mjs` |
| `browser` | `WEB_URL=… node scripts/acceptance/browser.mjs` |
| `attacks` | `ACCEPT_API_URL=… node scripts/acceptance/attacks.mjs` |
| `inject` | `COMPOSE="docker compose …" ACCEPT_API_URL=… node scripts/acceptance/failure-injection.mjs` |
| `extra` | `ACCEPT_API_URL=… node scripts/acceptance/extra-scenarios.mjs` |
| `stack` | `docker compose -f docker-compose.yml -f docker-compose.sdcpp.yml up -d` (the runtime command for every row) |

## Matrix

The evidence files are in [evidence/2026-09-28/](evidence/2026-09-28/). "Known limitations" says what the
verification does *not* show.

| Capability | Code status | Local status | E2E status | Real runtime status | Production status | Evidence | Last verification date | Test command | Runtime command | Known limitations |
|---|---|---|---|---|---|---|---|---|---|---|
| Auth (sessions, API keys, CSRF, password change) | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance AUTH-SIGNUP/AUTH-SESSION; attacks CSRF, API-KEY-SCOPE, UNAUTHENTICATED (72 routes → 401); browser SIGNUP, LOGOUT-LOGIN | 2026-09-28 | `unit`, `e2e` | `stack` + `accept` | No SSO, MFA, password reset or email verification (by decision) |
| Invitations and roles | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | `project-members.test.ts` (12, incl. a concurrent last-admin race); attacks ENUMERATION | 2026-09-28 | `unit` | `stack` + `attacks` | With no email verification, an invitation goes to whoever signs in with that address |
| Multi-tenancy | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance TENANT-ISOLATION; attacks TENANT-IDOR (6 probes → 404) | 2026-09-28 | `unit`, `e2e` | `stack` + `accept` | — |
| Chat | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance CHAT-HISTORY; browser CHAT-MULTI-TURN; `chat-overrides`, `chat-billing` tests | 2026-09-28 | `unit`, `e2e` | `stack` + `accept`, `browser` | A 7B model on CPU; answer quality is the model's |
| Streaming | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance CHAT-STREAM (35 events over 8.2 s); browser CHAT-STREAMING (80 distinct rendered lengths through the same-origin proxy), CHAT-CANCEL | 2026-09-28 | `unit`, `e2e` | `stack` + `browser` | The proxy's one-hour timeout is measured locally, not on Cloud Run |
| Tool calling | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance CODING-AGENT, MCP (real tool calls by qwen2.5:7b) | 2026-09-28 | `unit` | `stack` + `accept` | Chat reports a tool call and does not run it (by decision); agents run tools |
| Agent | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance MCP; `autonomous.test.ts` (inconclusive verification, retry charge keys, real provider/model) | 2026-09-28 | `unit` | `stack` + `accept` | One API instance: the live event bus is in-process (ADR-159) |
| Coding agent | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance CODING-AGENT (COMPLETED in 547 s, independent test run exit 0); extra CODING-SECOND, CODING-BAD-PATCH | 2026-09-28 | `unit` | `stack` + `accept`, `extra` | A 7B model sometimes fails a task. The platform then reports FAILED, never COMPLETED over a failing test |
| Memory | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance MEMORY-FORMATION/RECALL/DELETE (a new conversation recalled NIGHTHAWK-908536); browser MEMORY-UI | 2026-09-28 | `unit` | `stack` + `accept`, `browser` | Extraction quality depends on the model; ungrounded identifiers are dropped |
| RAG | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance RAG-INGEST/ANSWER/REFUSAL; browser RAG-UI (citation shown, unanswerable refused); attacks RAG-INJECTION (instruction in a document not followed) | 2026-09-28 | `unit` | `stack` + `accept`, `browser`, `attacks` | Prompt-injection resistance is measured on one injection; it is not a guarantee |
| Image | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance IMAGE (SDXL 512×512, pixels measured); extra IMAGE-NEGATIVE, IMAGE-REPRODUCIBLE; inject MEDIA-CRASH | 2026-09-28 | `unit` | `stack` + `accept`, `extra` | 5–10 min per image on 4 CPU cores |
| Audio | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance AUDIO (Piper, 4.09 s, RMS 0.136); browser AUDIO-UI (played in the page) | 2026-09-28 | `unit` | `stack` + `accept`, `browser` | One bundled voice |
| Video | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance VIDEO (MP4 h264+aac+mov_text, 8.0 s, 2 narrated scenes, WebVTT); browser VIDEO-UI | 2026-09-28 | `unit` | `stack` + `accept`, `browser` | Local video is a still animated by ffmpeg ("image-motion"), not a video model, and it is labelled so. Replicate is fixture-tested only (no token) |
| MCP | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance MCP (the real filesystem server read a planted word; another project's directory refused); inject MCP-CRASH | 2026-09-28 | `unit` | `stack` + `accept`, `inject` | Crash detection is a 60 s health check |
| Usage and cost | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance USAGE (23 479 real tokens); `usage.test.ts`; `chat-billing.test.ts` (partial turns charged) | 2026-09-28 | `unit`, `e2e` | `stack` + `accept` | Cost is shown only for priced models. A local model has no price, so its cost is not shown as $0 |
| Quota | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance QUOTA (a 56 s video refused at 60 s/month with 8 s used; nothing created) | 2026-09-28 | `unit` | `stack` + `accept` | — |
| Security | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | attacks 11/11 + XFF-SPOOF; CI gitleaks, `npm audit`, no-fake-in-production | 2026-09-28 | `unit`, `verify` SECURITY | `stack` + `attacks` | On Cloud Run the agent sandbox is process isolation (stated in DEPLOYMENT.md) |
| Resilience (failure injection) | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | inject LLM-DOWN, DB-DOWN, WORKER-DOWN, MEDIA-CRASH, MCP-CRASH | 2026-09-28 | `unit` | `stack` + `inject` | Measured on one machine; no multi-instance failover |
| Observability | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | acceptance METRICS (API and worker both scraped, counters non-zero); AUDIT | 2026-09-28 | `unit` | `stack` + `accept` | No trace collector is deployed; spans are exported to logs |
| Frontend | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | 122 unit tests; Playwright 14/14; browser ROUTES (12 screens, no console errors) | 2026-09-28 | `unit`, `e2e` | `cd frontend && npm run dev` | — |
| Backend | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | 76 routes, each requested by the contract test; boot 8/8; migrations 3/3 | 2026-09-28 | `unit` | `cd backend && npm run dev` | — |
| Docker | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL | both images built (CI and locally); the compose stack ran every runtime script above | 2026-09-28 | CI `infrastructure` job | `stack` | Locally the API image runtime is Ubuntu because deb.debian.org is blocked here; CI builds the repository's Debian image |
| Terraform | IMPLEMENTED | LOCALLY_VERIFIED | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | `terraform fmt -check` and `validate` pass (CI and locally) | 2026-09-28 | `verify` TERRAFORM | — | `plan`/`apply` need a GCP project |
| CI/CD | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | E2E_VERIFIED | BLOCKED_EXTERNAL | GitHub Actions, 5 jobs green; see the report for run ids | 2026-09-28 | `.github/workflows/ci.yml` | — | No deployment pipeline: deployment is the runbook |
| Cloud deployment | IMPLEMENTED | LOCALLY_VERIFIED | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | [PRODUCTION_DEPLOYMENT_BLOCKER.md](PRODUCTION_DEPLOYMENT_BLOCKER.md) | 2026-09-28 | — | — | Never applied. The hop count, internal ingress and Cloud SQL sharing are unverified |

## Gates

The latest `npm run verify` output is recorded in the report. The CI run ids are listed there
too.

## Not implemented, by decision

These are named so their absence is not mistaken for an oversight:

- SSO/OIDC, MFA, password reset and email verification;
- a per-project tool policy;
- a deployment pipeline (CD);
- Vertex AI.
