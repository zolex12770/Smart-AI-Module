# npm run verify, 2026-09-28

Every run below used the Docker Compose stack, with the API image built from the commit named. The runs are listed in order, including those that failed.

| Run | API image | Result | What failed, and what was done |
|---|---|---|---|
| 1 | `51a66a5` | 17 PASS · 2 FAIL | SECURITY: a test canary shaped like an Anthropic key (joined at runtime in `f0f3d13`; the scanner was not loosened). DOCKER: the sandbox image `node:22-alpine` was missing locally, and Docker Hub answered 429. It was pulled from `mirror.gcr.io` (digest `node@sha256:0a7108bf…`) |
| 2 | `51a66a5` | SECURITY, DOCKER: 2 PASS | only the two gates that had failed |
| 3 | `816674a` | 18 PASS · 1 FAIL | AGENT: CODING-AGENT stopped at 12 turns, because the model sent the wrong indentation to `code.replace_text` five times, and that tool never said why. Fixed in DL-25 (`a34ac79`) |
| 4 | `a34ac79` | **19 PASS · 0 FAIL** | — |
| 5 (final) | `16d352b` | **19 PASS · 0 FAIL** | — (after DL-26) |

## Final run (`16d352b`)

```
BUILD          PASS              all workspaces built (19s)
TYPECHECK      PASS              0 errors (46s)
LINT           PASS              0 errors, 5 warnings (28s)
UNIT           PASS              1001 passed, 0 failed, 2 skipped (26 workspaces) (425s)
INTEGRATION    PASS              276 passed, 0 failed, 0 skipped (backend application) (257s)
API            PASS              76 routes documented, each requested once; no drift (7s)
SECURITY       PASS              npm audit: no high/critical; secret scan: 594 tracked files clean; no mock serves production (3s)
E2E            PASS              Playwright: 14 passed (48s)
DATABASE       PASS              migrations apply to an empty DB, re-apply cleanly, match the schema (5s)
BOUNDARY       PASS              frontend/backend boundary holds (1s)
BOOT           PASS              every role boots (37s)
REAL RUNTIME   PASS              AUTH-SIGNUP=PASS AUTH-SESSION=PASS PROVIDERS=PASS CHAT-STREAM=PASS CHAT-HISTORY=PASS USAGE=PASS TENANT-ISOLATION=PASS PERSISTENCE=PASS (0s)
MEDIA          PASS              IMAGE=PASS AUDIO=PASS VIDEO=PASS (0s)
AGENT          PASS              CODING-AGENT=PASS (0s)
RAG            PASS              RAG-INGEST=PASS RAG-ANSWER=PASS RAG-REFUSAL=PASS (0s)
MEMORY         PASS              MEMORY-FORMATION=PASS MEMORY-RECALL=PASS MEMORY-DELETE=PASS (0s)
MCP            PASS              MCP=PASS (0s)
DOCKER         PASS              Docker 29.3.1; compose valid; sandbox 4 passed, 0 failed, 0 skipped (8s)
TERRAFORM      PASS              fmt, init, validate pass (plan/apply need GCP credentials: docs/PRODUCTION_DEPLOYMENT_BLOCKER.md) (6s)
19 PASS · 0 FAIL · 0 BLOCKED_EXTERNAL
```

The full-system acceptance that the runtime gates ran is `acceptance-compose-final.md` (24/24). The JSON files hold each run's gates: `verify-run1.json`, `verify-run2-security-docker.json`, `verify-run3-816674a.json`, `verify-run4-a34ac79.json` and `verify-final-16d352b.json`.
