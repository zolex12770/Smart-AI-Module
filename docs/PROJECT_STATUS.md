# Project status

**Date:** 2026-09-27 · **Branch:** `claude/zen-brahmagupta-6l5o4u`

This file is the status matrix. The evidence behind each cell, and the exact commands, are in
[FINAL_PRODUCTION_READINESS_REPORT.md](FINAL_PRODUCTION_READINESS_REPORT.md). Earlier status
documents are kept as records only: [history/](history/) and the root `PROJECT_STATUS.md`. Their
numbers are not current.

## Columns

| Column | Means |
|---|---|
| **Code** | Implemented in this repository. |
| **Local** | Its automated tests pass: `npm test` locally, and the CI workflow on GitHub Actions. |
| **E2E** | Exercised end to end through the running system: Playwright in a real browser, or `scripts/acceptance/full-system.mjs` over HTTP, or both. |
| **Real Runtime** | Exercised against real providers with no mocks, and its output inspected: Ollama `qwen2.5:7b` and `nomic-embed-text`, stable-diffusion.cpp SDXL, Piper, ffmpeg, Postgres + pgvector. This happened in development mode and in the Docker Compose stack. |
| **Production** | Exercised in a deployed cloud environment. |

Only four values are used: `PASS`, `FAIL`, `BLOCKED_EXTERNAL` and `NOT_IMPLEMENTED`.
**Production is `BLOCKED_EXTERNAL` in every row.** Nothing has been deployed to a cloud, because
no GCP project or credentials are available here. **Status** is the verdict for the repository
as delivered: `PASS` means Code, Local, E2E and Real Runtime all pass.

## Matrix

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

What the less obvious cells mean:

- **Terraform**: `fmt`, `init` and `validate` pass in CI, which gives Code and Local. `plan` and
  `apply` need a GCP project and credentials, so E2E, Real Runtime and Status are
  `BLOCKED_EXTERNAL`.
- **CI/CD**: every CI stage the brief lists runs on GitHub Actions and is green. That covers
  install, lint, typecheck, unit, integration and API tests, the build, security checks,
  migrations, the browser E2E suite and both Docker builds. The API image is also booted against a
  real Postgres. The latest run, 36327781128 on `0487870`, is green. No deployment pipeline exists: deploying is the reviewed runbook in
  `infrastructure/`, and it needs the same GCP access.
- **Docker**: both images build in CI. The full compose stack (postgres/pgvector, ollama, api,
  worker, web) was brought up here and the full-system acceptance was run against it. See the
  report.
- **Coding agent / Memory**: these depend on a 7B model running on CPU. Individual runs have
  failed (model variance: a mis-copied digit, a tool call written as text, the wrong filename).
  Each failure ended in a truthful `FAILED` and led to a platform fix. After the fixes, 3 of 3
  coding probes and 4 of 4 memory probes succeeded. The report gives every run.

## Completion gate

| Gate | Status |
|---|---|
| Frontend structure | PASS |
| Backend structure | PASS |
| Build | PASS |
| Typecheck | PASS |
| Lint | PASS |
| Unit tests | PASS |
| Integration tests | PASS |
| API tests | PASS |
| Browser E2E | PASS |
| Auth | PASS |
| Tenant isolation | PASS |
| Chat | PASS |
| Streaming | PASS |
| Memory | PASS |
| RAG | PASS |
| Coding agent | PASS |
| Image generation | PASS |
| Audio generation | PASS |
| Video generation | PASS |
| MCP | PASS |
| Usage | PASS |
| Quota | PASS |
| Security | PASS |
| Observability | PASS |
| Local startup | PASS |
| Docker | PASS |
| Terraform | BLOCKED_EXTERNAL |
| Cloud deployment | BLOCKED_EXTERNAL |
| CI | PASS |

## Not implemented, by decision

These are named so that their absence is not mistaken for an oversight. None is claimed
anywhere as working.

- SSO/OIDC, MFA, password reset and email verification. Only sessions and API keys exist.
- Per-project tool policy. Enabling a tool is a deployment-wide action for a system administrator.
- A deployment pipeline (CD). Deployment is the runbook.
- Vertex AI. The Google adapter uses the Gemini Developer API.
