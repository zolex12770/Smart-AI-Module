# Test Report

**Date:** 2026-09-05 · **Commit:** `d8c7b46`
**Result: 327 tests passing across 42 files. 0 failures. 0 type errors across 23 workspaces.**

Generated from a real run of `npm test` with the optional external binaries present. A skipped
test is not counted as a passing test (product brief §29).

## Totals

| | Before this work | Now |
|---|---|---|
| Test files | 35 | **42** |
| Test cases | 189 | **327** |
| Failures | 0 | **0** |
| Type errors | 0 | **0** |

## By package

| Package | Files | Tests | What it actually exercises |
|---|---|---|---|
| `apps/api` | 6 | 41 | Real `buildServer()` app via `inject()`, real embedded Postgres, real multipart bodies, real authenticated sessions |
| `packages/security` | 3 | 32 | Real Postgres; scrypt; sessions; API keys; RBAC; **cross-tenant isolation**; real spawned processes for the sandbox |
| `packages/tools` | 5 | 40 | Real temp filesystems; real spawned processes; unified-diff application; path containment |
| `packages/rag` | 7 | 34 | Real PGlite + pgvector; real PDF/DOCX/ZIP parsing; real clamd job branching |
| `packages/agent-core` | 4 | 43 | Real Postgres task graph; crash recovery; retry backoff; **the model-driven reasoning loop** |
| `packages/model-router` | 2 | 16 | Fallback state machine; retry/backoff; circuit breaking; pricing |
| `packages/media` | 2 | 19 | Real GIF codec round-trip; real pg-boss resumability; real fake-GCS round-trip |
| `packages/providers/*` | 7 | 60 | Fixture-driven wire-format parsing and **tool-call reassembly** for all five adapters |
| `packages/quota` | 1 | 11 | Real usage aggregates and day/month boundaries |
| `packages/database` | 1 | 3 | Real driver connection failures; real PGlite with pgvector |
| `packages/scanning` | 1 | 7 | **A real spawned `clamd`** and a real EICAR sample |
| `packages/observability` | 2 | 7 | Real redaction, including a negative case |
| `packages/shared` | 1 | 7 | SSE framing across all three spec separators |
| `packages/embeddings` | 1 | 3 | Vector properties and the retrieval property |

## Character of the suite

Overwhelmingly **integration tests against real infrastructure**, not mocks: a real embedded
PostgreSQL with real migrations, real pg-boss queues, real HTTP through Fastify's `inject()`, a
real spawned `clamd`, a real `fake-gcs-server`, and real child processes. Fixtures are used only
where a real call would cost money or need a network (the LLM adapters).

## Environment-gated suites

9 tests require an external binary and **skip loudly** without it:

- `CLAMD_BIN` → 5 tests spawning a real ClamAV daemon.
- `FAKE_GCS_SERVER_BIN` → 4 tests against a real Cloud Storage emulator.

CI installs both, and a dedicated step **fails the build** if either suite skips there — a skip in
CI would mean the gate is broken, not that the tests passed.

## Verifications beyond the suite

- **Boot verification** (`scripts/verify-boot.sh`): 7 checks, 0 failures, against the real built
  entrypoint `node apps/api/dist/index.js` — including the production worker-role and api-role
  configurations that previously crash-looped.
- **Live security session** against a running server: every private endpoint 401s
  unauthenticated; a second tenant asking for the first's project gets 404 and sees none of its
  data; a cookie-authenticated write without the CSRF token gets 403.

## Gaps — what is NOT tested

- **Zero frontend tests. Zero E2E tests.** `apps/web` has no test script; no Testing Library, no
  Playwright. This is the single largest coverage gap.
- **No real model call.** Every LLM adapter is fixture-tested; none has completed a real request.
- **The Docker sandbox** is never executed (no Docker here) — only its selection and refusal logic.
- **No coverage tooling** is installed, so untested branches are found by reading, not measurement.
- **CI has never run.** The workflow is written and its steps mirror commands that run locally,
  but the repository has no remote.
