# npm run verify, 2026-09-28

Stack: the compose stack with the API image built from `51a66a5` (the tree at `f0f3d13` differs only in the test canary and docs).

## Run 1: every gate

```
BUILD          PASS              all workspaces built (33s)
TYPECHECK      PASS              0 errors (52s)
LINT           PASS              0 errors, 5 warnings (34s)
UNIT           PASS              996 passed, 0 failed, 2 skipped (26 workspaces) (456s)
INTEGRATION    PASS              273 passed, 0 failed, 0 skipped (backend application) (280s)
API            PASS              76 routes documented, each requested once; no drift (8s)
SECURITY       FAIL              npm audit: no high/critical; possible secrets in backend/packages/tools/src/native/terminal-isolation.test.ts; no mock serves production (3s)
DATABASE       PASS              migrations apply to an empty DB, re-apply cleanly, match the schema (5s)
BOUNDARY       PASS              frontend/backend boundary holds (1s)
BOOT           PASS              every role boots (41s)
REAL RUNTIME   PASS              AUTH-SIGNUP=PASS AUTH-SESSION=PASS PROVIDERS=PASS CHAT-STREAM=PASS CHAT-HISTORY=PASS USAGE=PASS TENANT-ISOLATION=PASS PERSISTENCE=PASS (0s)
MEDIA          PASS              IMAGE=PASS AUDIO=PASS VIDEO=PASS (0s)
AGENT          PASS              CODING-AGENT=PASS (0s)
RAG            PASS              RAG-INGEST=PASS RAG-ANSWER=PASS RAG-REFUSAL=PASS (0s)
MEMORY         PASS              MEMORY-FORMATION=PASS MEMORY-RECALL=PASS MEMORY-DELETE=PASS (0s)
MCP            PASS              MCP=PASS (0s)
DOCKER         FAIL              real-container sandbox suite failed: 1 passed, 3 failed, 0 skipped (9s)
TERRAFORM      PASS              fmt, init, validate pass (plan/apply need GCP credentials: docs/PRODUCTION_DEPLOYMENT_BLOCKER.md) (15s)
17 PASS · 2 FAIL · 0 BLOCKED_EXTERNAL
```

Exit code 1. The two failures:

- **SECURITY**: the secret scan matched a test canary shaped like an Anthropic key in `terminal-isolation.test.ts`. It was not a credential. It is now joined at runtime (`f0f3d13`), and the scanner was not loosened.
- **DOCKER**: the sandbox suite's image `node:22-alpine` had been removed locally, and Docker Hub answered 429 Too Many Requests. It was pulled from `mirror.gcr.io/library/node:22-alpine` (digest `node@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`).

## Run 2: the two gates that failed

```
SECURITY       PASS              npm audit: no high/critical; secret scan: 579 tracked files clean; no mock serves production (2s)
DOCKER         PASS              Docker 29.3.1; compose valid; sandbox 4 passed, 0 failed, 0 skipped (4s)
2 PASS · 0 FAIL · 0 BLOCKED_EXTERNAL
```

The full-system acceptance run by the runtime gates is `acceptance-compose-final.md` (24/24).
