# Verification, 2026-10-01

The images were built from the tree at `9fcfde8`: next 16.3.8, fastify 5.12.5, and
`OLLAMA_LOAD_TIMEOUT=20m`. The later commit `4d44b7d` changes only CI and a verification
script.

## npm run verify: 18 PASS · 1 FAIL

```
BUILD          PASS              all workspaces built (20s)
TYPECHECK      PASS              0 errors (47s)
LINT           PASS              0 errors, 5 warnings (28s)
UNIT           PASS              1003 passed, 0 failed, 2 skipped (26 workspaces) (440s)
INTEGRATION    PASS              276 passed, 0 failed, 0 skipped (backend application) (267s)
API            PASS              76 routes documented, each requested once; no drift (8s)
SECURITY       PASS              npm audit: no high/critical; secret scan: 617 tracked files clean; no mock serves production (3s)
E2E            PASS              Playwright: 14 passed (50s)
DATABASE       PASS              migrations apply to an empty DB, re-apply cleanly, match the schema (5s)
BOUNDARY       PASS              frontend/backend boundary holds (1s)
BOOT           PASS              every role boots (38s)
REAL RUNTIME   PASS              AUTH-SIGNUP=PASS AUTH-SESSION=PASS PROVIDERS=PASS CHAT-STREAM=PASS CHAT-HISTORY=PASS USAGE=PASS TENANT-ISOLATION=PASS PERSISTENCE=PASS (0s)
MEDIA          PASS              IMAGE=PASS AUDIO=PASS VIDEO=PASS (0s)
AGENT          PASS              CODING-AGENT=PASS (0s)
RAG            PASS              RAG-INGEST=PASS RAG-ANSWER=PASS RAG-REFUSAL=PASS (0s)
MEMORY         FAIL              MEMORY-FORMATION=FAIL MEMORY-RECALL=PASS MEMORY-DELETE=PASS (0s)
MCP            PASS              MCP=PASS (0s)
DOCKER         PASS              Docker 29.3.1; compose valid; sandbox 4 passed, 0 failed, 0 skipped (9s)
TERRAFORM      PASS              fmt, init, validate pass (plan/apply need GCP credentials: docs/PRODUCTION_DEPLOYMENT_BLOCKER.md) (16s)
18 PASS · 1 FAIL · 0 BLOCKED_EXTERNAL
```

The one failure was **MEMORY-FORMATION**, which is model variance; the platform's guard worked.
- qwen2.5:7b extracted "The user's project codename is **NIGHTHAWK-8189**" from a message that
  said NIGHTHAWK-**818789**.
- The grounding guard drops a fact whose identifier the user did not write, so no wrong fact was
  stored (API log: `dropped … ungrounded`). The check waited 180 s and failed honestly.
- Run 1 of the acceptance is `acceptance-run1-memory-miscopy.md`.

## Full-system acceptance, run again: 24 PASS · 0 FAIL

`acceptance.md`. MEMORY-FORMATION stored the exact codename in 27.6 s. CODING-AGENT completed in
255.8 s, and the independent test run exited 0.

## The other suites, on the same images

| Suite | Result | File |
|---|---|---|
| Attacks | 11/11 | `attacks.md` |
| Failure injection | 5/5 | `failure-injection.md` |
| Real-browser suite | 11/11 | `browser.md` |
| Ollama load limit (DL-29) | old configuration 500 at 301.7 s; new 200 at 772.6 s | `ollama-load-timeout.md` |
