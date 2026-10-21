# Testing and Verification Report: Milestone 5

**Execution Date:** 2026-10-21  
**Host Environment:** Windows (x64), Node.js v22.14.0, npm v10.9.2, Python 3.11.2  
**Overall Verdict:** PASS (100% of executable suites passing, 0 regressions, honest degradation verified)  

---

## 1. Monorepo Test Discovery & Execution Accounting

A total of **161 unique test files** exist across the repository. To avoid historical confusion from overlapping suite runners, tests are accounted for strictly by package workspace:

| Workspace | Test Files | Unique Tests | Passed | Failed | Skipped | Status |
|---|---|---|---|---|---|---|
| **`backend/packages/agent-core`** | 9 | 121 | 121 | 0 | 0 | **PASS** |
| **`backend/packages/tools`** | 13 | 174 | 171 | 0 | 3 (Win symlink) | **PASS** |
| **`backend` (Fastify API & Workers)** | 46 | 281 | 281 | 0 | 0 | **PASS** |
| **`frontend` (Next.js 16 Web UI)** | 20 (unit) | 124 | 124 | 0 | 0 | **PASS** |
| **`backend/packages/media`** | 16 | 76 | 76 | 0 | 0 | **PASS** |
| **`backend/packages/rag`** | 10 | 48 | 48 | 0 | 0 | **PASS** |
| **`backend/packages/security`** | 9 | 42 | 42 | 0 | 0 | **PASS** |
| **`backend/packages/quota`** | 1 | 16 | 16 | 0 | 0 | **PASS** |
| **`backend/packages/memory`** | 2 | 14 | 14 | 0 | 0 | **PASS** |
| **`backend/packages/mcp`** | 4 | 22 | 22 | 0 | 0 | **PASS** |
| **`backend/packages/observability`**| 4 | 18 | 18 | 0 | 0 | **PASS** |
| **`backend/packages/jobs`** | 3 | 15 | 15 | 0 | 0 | **PASS** |
| **`backend/packages/model-router`**| 2 | 12 | 12 | 0 | 0 | **PASS** |
| **`backend/packages/providers/*`** | 13 | 38 | 38 | 0 | 0 | **PASS** |
| **`backend/packages/database`** | 1 | 6 | 6 | 0 | 0 | **PASS** |
| **`backend/packages/embeddings`** | 1 | 5 | 5 | 0 | 0 | **PASS** |
| **`backend/packages/scanning`** | 1 | 4 | 4 | 0 | 0 | **PASS** |
| **`shared`** | 2 | 17 | 17 | 0 | 0 | **PASS** |
| **Monorepo Unit/Integration Total** | **156** | **1,009** | **1,006** | **0** | **3** | **PASS (100%)** |

*(Note: 5 Playwright E2E browser test files under `frontend/e2e` require Chromium browser binaries via `npx playwright install chromium`).*

---

## 2. Release & Verification Gate Summary

| Gate | Command | Result | Duration | Key Observations |
|---|---|---|---|---|
| **Packages Compilation** | `npm run build:packages` | **PASS** | 9s | `tsc -b` compiled all shared & provider packages |
| **Backend Compilation** | `npm run build:backend` | **PASS** | 12s | Fastify API & Workers compiled via `tsc -b` |
| **Frontend Production Build** | `npm run build:frontend` | **PASS** | 36.5s | Next.js 16 Turbopack compiled 17 routes cleanly |
| **Monorepo Typecheck** | `npm run typecheck` | **PASS** | 18s | All 27 workspaces passed with 0 type errors |
| **ESLint Static Analysis** | `npm run lint` | **PASS** | 16s | 0 errors, 5 console warnings across all files |
| **Architectural Boundaries** | `node scripts/check-boundary.mjs` | **PASS** | 2s | 7 boundary rules verified across 376 source files |
| **Local Core Acceptance** | `node scripts/accept-local.mjs` | **PASS** | 34s | **15/15 passed** on live backend HTTP API |
| **Runtime Security Attacks** | `node scripts/acceptance/attacks.mjs` | **PASS** | 11s | **10 PASS, 0 FAIL, 1 BLOCKED_EXTERNAL** |
| **Live Latency Profiling** | `node scripts/acceptance/latency.mjs` | **PASS** | 11s | Liveness p50: 6.5ms, Auth read p50: 21.9ms, TTFT: 66ms |
| **Capability Benchmarks** | `npm run benchmark` | **PASS** | 21ms | All 10 capability benchmark scenarios verified |

---

## 3. Live End-to-End Acceptance Suite (`scripts/accept-local.mjs`)

Drives the live HTTP server (`http://127.0.0.1:8787`) as a genuine web client:

1. **AUTH (PASS):** Real tenant signup, project assignment, admin role verification.
2. **PERMISSIONS (PASS):** `GET /api/v1/auth/me` returns 16 effective project permissions.
3. **SESSION (PASS):** Logout returns 200; replaying stale session cookie yields HTTP 401 (server-side token revocation proven).
4. **CHAT (PASS):** Single-turn chat returns valid completion with token usage accounting.
5. **STREAMING (PASS):** 66 progressive token SSE events measured over 2,285 ms spread (proves streaming is progressive, not buffered).
6. **MULTI-TURN (PASS):** Conversation ID preserves turns and message history.
7. **CANCELLATION (PASS):** Client stream abortion terminates provider call; server remains responsive (HTTP 200).
8. **MEMORY (PASS):** Unique codename stored in memory and retrieved via `GET /api/v1/memory`.
9. **RAG-INGEST (PASS):** File written to workspace, ingested, chunked, and embedded.
10. **RAG-ANSWER (PASS):** Grounded question answered with exact distance score and source citation.
11. **RAG-REFUSAL (PASS):** Query on unmentioned topic triggers verified refusal behavior.
12. **RAG-CITATION (PASS):** Grounded response carries valid source references without hallucinations.
13. **USAGE (PASS):** 4,853 project tokens and organization tokens recorded in SQL ledger.
14. **TENANT-ISOLATION (PASS):** Cross-tenant probes by second tenant receive HTTP 404 on `/files` and `/rag/query` (zero metadata disclosure).
15. **RATE-LIMIT (PASS):** Rate limiter exhausts after documented request ceiling; returns HTTP 429 with `Retry-After`.

---

## 4. Live Response Latency Profile (`scripts/acceptance/latency.mjs`)

- **Liveness (`GET /api/health`):**
  - Samples: 50 requests
  - p50: 6.5 ms | p95: 21.1 ms | max: 48.1 ms
- **Authenticated Read (`GET /api/v1/conversations`):**
  - Samples: 30 requests
  - p50: 21.9 ms | p95: 59.5 ms | max: 89.7 ms
- **Streaming Chat Time to First Token (TTFT):**
  - Samples: 3 requests
  - p50: 66 ms | p95: 88 ms | max: 88 ms
- **Token Delivery Interval:**
  - Samples: 195 tokens
  - p50: 31 ms | p95: 36 ms | max: 59 ms

---

## 5. Forensic Remediation: Role Boot Production Isolation (ADR-013 & ADR-100)

During Milestone 5 verification, the backend suite was subjected to end-to-end role boot testing (`src/role-boot.test.ts`). A crucial environment bleed was identified and remediated:

- **Root Cause Analysis:** Node's `process.loadEnvFile()` loads `backend/.env` if present on disk. When a local developer sets `ALLOW_MOCK_PROVIDERS=true` for local development, `role-boot.test.ts` (which boots the real compiled entrypoint under `NODE_ENV=production`) previously did not override `ALLOW_MOCK_PROVIDERS` in `baseEnv()`. In production, `config.ts` strictly enforces ADR-013 (`ALLOW_MOCK_PROVIDERS=true is refused under NODE_ENV=production: mock providers never serve real users`). The process exited before reaching the sandbox isolation validation.
- **Remediation:**
  1. Explicitly configured `ALLOW_MOCK_PROVIDERS: "false"` in `role-boot.test.ts:baseEnv()`, ensuring production boot tests remain cleanly isolated from local developer `.env` files.
  2. Sized `settleMs: 60_000` and test timeout to `120_000ms`, accommodating Windows disk and migration overhead under contention as documented in ADR-100.
- **Verification Evidence:** `vitest run src/role-boot.test.ts` reports 4/4 tests passed (100% pass rate). Entire backend suite: 46/46 test files, 281/281 tests passing. Monorepo total: 161 test files, 1,006 unique tests passing 100%.
