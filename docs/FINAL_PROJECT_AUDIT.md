# Final Project Audit

**Date:** 2026-09-18 · **Audits:** four, each followed by the fixes it forced and a re-run of every gate.

> **The fourth audit (`acc5416..513e709`, ADR-123 ... ADR-142)** read the whole tree with 11
> independent agents and confirmed **5 P0s and 53 P1s**. All 58 are closed across 18 commits. Its
> record is the section "The fourth audit" at the end of this file; the acceptance run that
> followed it is `docs/LOCAL_USER_ACCEPTANCE_TEST.md`.

- **First audit** (32 independent agents) read the tree at `b4cf4af`, the last commit before its
  first fix, `b028922`. An earlier version of this header named `9e794b3`, which already
  contained nine of the fixes cited below: `ca25a80`, `48bf37d`, `a6a0287`, `b028922`, `eb2c5c5`,
  `9b77d17`, `21c6b4c`, `e597f04` and `6304b8b` are each its ancestor by
  `git merge-base --is-ancestor`.
- **Second audit** read this phase's diff at the time — the first audit's fixes — rather than the old tree.
- **Third audit**, a loop-until-dry adversarial workflow, read the diff `78a0e13..74c7cd0`. Its
  findings were fixed in `fc79159`, `bf1d21c` and `fd5f5a5` (ADR-108 to ADR-112), and every gate
  was re-run on `fd5f5a5`.

This is the per-dimension record the project brief (§44) asks for. It is not a summary of
`docs/PROJECT_STATUS.md` — that file says what the state IS; this one says how each claim was
established, and what was found wrong when someone went looking.

## How this audit was run, and why that matters

The tree the first audit read had already been declared finished. Every gate was green: build,
typecheck, lint, 556 tests with zero skips, boundary 9/9, migrations 3/3, boot 7/7, E2E 7/7. The
status document said CODE COMPLETION 96%, "P0 remaining: 0 · P1 remaining: 0".

There have been three audits. The first confirmed **27 gaps**, including two P0s, and three more
were found while fixing them — one of which was a P0 introduced BY one of the fixes — for **30**.
A second independent audit of the fixes themselves confirmed **7** more. A third, over this
phase's whole diff, confirmed **43**. The most useful thing in this document is therefore not the
table below but that sentence: a complete set of passing gates established almost nothing about
the properties anyone actually cared about, because several of the gates *could not fail* — and
some could not pass.

**The recurring defect class, stated plainly.** Eight of the first 37 were gates or tests whose
verdict did not track what they existed to check. Six reported success whatever the code did. Two
were wrong the other way: the CI fake-implementation grep failed on correct code (and a trailing
`// NODE_ENV` comment would also have let a real mock through), and `npm test` failed on correct
code whenever the machine was loaded. The third audit found the class again; its gate findings
are the last five rows (twelve of its 43), and a test that passed on the code it existed to rule
out is row 58 of the gap table.

| Gate | How its verdict was wrong | What now shows it works |
|---|---|---|
| `verify-boundary.sh` check 6 (secret leakage) | Passed both `-E` and `-P`; GNU grep aborts with "conflicting matchers", `2>/dev/null` hid it and `\|\| true` swallowed the exit. Two real secrets planted in frontend source still gave PASS | **Planted:** the replacement reported three planted secrets and exited 1 (`ca25a80`). Since ADR-111 it is a rule of the syntax-tree checker, planted in its self-test |
| CI "no fake implementation" | Wrong both ways: a line grep for a guard that sits on the *previous* line fired on correct code, so the `security` job could never pass at all — and a trailing comment would have satisfied it on wrong code | A test that asserts both directions — no mock in the production provider set, the mock present outside production (ADR-101) — so it cannot pass vacuously. No planted-mock run is recorded |
| CI "gated suites actually ran" | Matched one of the five real skip messages; four suites could skip silently | Asserts vitest's own skip count. **Watched fail:** silent on the real transcript with every binary present, firing on the one without (`a6a0287`) |
| `verify-boot.sh` refusal cases | Asserted only that health never answered — which a port clash or a syntax error satisfies as well as the refusal under test | Each case names the message it expects. **Watched fail:** on its first run it caught a pattern that had never matched the real message (`a6a0287`) |
| Playwright `reuseExistingServer` | Silently reused a backend from an earlier session, so E2E tested code that was not under test | `reuseExistingServer: false` (ADR-105): a setting, not a check, so there is nothing to plant |
| `npm test` timeouts | Wrong the other way: passed on an idle machine and failed on correct code on a loaded one, with a different count each run | Shared 30 s / 60 s ceilings (ADR-100). A ceiling makes a false failure less likely, not impossible |
| `verify-boundary.sh` check 2 (third version) | A multi-line value import puts the package name on the `} from` line, which a line grep for `import` discards | **Planted:** ADR-106's statement parser caught eight planted shapes — and the third audit still defeated it (row below) |
| File-symlink containment test | Caught the platform's refusal and `return`ed — zero assertions, counted as a pass on the platform the repository is developed on | A reported skip, 1 locally on Windows. On Linux CI it must run; CI has never executed |
| CI `security` job *(third audit #16)* | Ran vitest against packages it never built, so it could never pass | A build step before the tests (ADR-108). Its commands pass locally; **the job itself has never executed** |
| CI zero-skip gate on Linux *(third audit #24)* | The long-form suite skipped unless `process.platform === "win32"`, so on CI's ubuntu runner the gate would have failed every run while the documents said it passed | A deterministic PCM tone where no synthesiser exists (ADR-111): 3/3 on SAPI and 3/3 on the forced tone path, on this Windows machine. Never run on Linux |
| Boundary checks 1–7 *(third audit #17–#20, #35–#37)* | Still passed real violations: a comment containing "import type" ahead of a value import, `import()`, `require()`, single quotes, `node:fs/promises`, bare `fs`, bracket and destructured `process.env`, a bare `../../../shared`, and every `.js`/`.jsx`/`.mjs`/`.cjs` file. Check 7 printed a pass while `backend/src` imported an undeclared `drizzle-orm` | **Planted:** a syntax-tree checker that must pass a self-test of 39 planted violations and 10 clean files before it judges the tree; each of 15 rule mutants is killed by that self-test; rule 7 found two real undeclared dependencies (ADR-111) |
| Documented Docker sandbox check *(third audit #25)* | The documented command passed on a machine with no Docker; "unit only" and "flag construction verified" had no test behind them | `dockerRunArgs` flag tests, and `npm run test:docker` **watched fail** — not skip — here, where docker is not installed. Real-container isolation is still unverified |
| `docs/API.md` generator *(third audit #23, #26)* | Labelled each route from a fixed window after its path, so routes inherited a neighbour's guard and rate limit: dead-letter replay published as administrator-only; login/logout, `me`, `projects` and one rate limit mislabelled | `api-contract.test.ts` sends a real request for every documented row. **Watched fail:** against the old document it fails, naming each wrong row (ADR-112) |

That third column is the standard this document applies: a check nobody has watched fail is a
check of unknown value. The rows marked **Planted** or **Watched fail** meet it. The rest are fixed
and argued, but this document records no run in which they were watched to fail.

---

## Per-dimension audit

Columns: **I**mplemented · **T**ested · **RV** Runtime Verified · **PV** Production Verified ·
**Blocked** · Remaining.

### Architecture and structure

| Dimension | I | T | RV | PV | Blocked | Remaining |
|---|---|---|---|---|---|---|
| Frontend/backend physical separation | yes | `verify-boundary.sh` 8/8 | yes — on a fresh clone of `fd5f5a5`, the backend alone (`cd backend && npm run dev`) answered `GET /api/health` and the frontend alone built; before ADR-112 the backend could not start there | no | — | — |
| Boundary enforcement | yes | self-test: 39 planted violations, 10 clean files | yes — 8/8 (self-test + 7 rules) over 275 parsed source files; 15/15 rule mutants killed by the self-test | no | — | — |
| `shared/` is a contract, not a coupling | yes | rule 2, read from the syntax tree | yes — every frontend import of it is `import type` | no | — | — |
| Monorepo build graph (26 workspaces) | yes | `tsc -b` | yes — backend builds standalone after 4 missing project references were added | no | — | — |
| Lockfile integrity | yes | `npm ci` | yes — fresh `git clone` of `fd5f5a5` + `npm ci`, exit 0 in 43 s | no | — | — |

### Security

| Dimension | I | T | RV | PV | Blocked | Remaining |
|---|---|---|---|---|---|---|
| Authentication (scrypt, sessions, API keys, CSRF, lockout) | yes | 65 in `security` | yes — live 401/403/404 | no | — | Password reset, email verification, MFA, SSO |
| Authorization as a SQL predicate | yes | yes | yes — cross-tenant 404 in a real browser | no | — | Per-project tool/MCP policy |
| Deny-by-default authentication | yes | 4 | yes | no | — | — |
| Administrator role | yes | yes — 3 assert no implicit tenant access | yes — **admin 200, ordinary user 404, live. Held owner+admin on every tenant's project until ADR-108**; membership is now the only way into a project, by test | no | — | No administration UI; concurrent bootstraps with different emails can both succeed (READ COMMITTED; acknowledged, not locked) |
| Tenant isolation: database | yes | yes | yes | no | — | — |
| Tenant isolation: agent workspaces | yes | 9 | yes | no | — | — |
| Tenant isolation: **search tools** | yes | 9 | yes — **was a proven cross-tenant read** | no | — | — |
| Tenant isolation: **RAG ingestion** | yes | 3 | yes — **was a proven cross-tenant read** | no | — | — |
| Sandbox containment (symlinks, traversal) | yes | 8 + 9 | yes — real junctions into host directories | no | — | — |
| Docker sandbox isolation | yes | 9 `dockerRunArgs` flag tests | **no** — the real-container suite (`npm run test:docker`) has never run; here it fails, by design, because docker is not installed | no | **No container runtime** | — |
| SSRF guard (`web.fetch`) | yes | 42 | yes — metadata endpoint, `localhost` via `::1`, `10.0.0.1`, `file://` and every hex/octal/decimal spelling refused live. By test: one identical refusal for private and unresolvable names, one deadline across DNS, redirects and body, redirect bodies closed, HTML stripping in linear time (512 KB of hostile input under 2 s) | no | — | A public host that PROXIES to a private one is indistinguishable; `WEB_FETCH_ALLOWLIST` is the answer. Egress is also an exfiltration channel for a prompt-injected agent, and is not metered |
| Malware scanning | yes | 7 | yes — real clamd, real EICAR | no | — | — |
| Upload controls (type, sniff, size, disposition) | yes | yes | yes | no | — | — |
| Secret handling | yes | staged-diff scan before every commit | yes | no | — | — |
| Account and data deletion (NFR-008) | yes | 23 (14 service, 9 route) | yes — live, including the file on disk (ADR-102). The third audit's fixes — each project judged on its own, agent workspaces removed, queued jobs cancelled, the person's audit rows scrubbed, session only, the password re-check counting toward the lockout — by test, not re-run live | no | — | No operator-initiated deletion or export-before-delete. Work already running at deletion cannot be stopped; the bytes it orphans are removed |
| Rate limiting | yes | 10 + 3 (`TRUST_PROXY_HOPS`) | yes — 201,201,201,429,429. The client address is the socket's unless `TRUST_PROXY_HOPS` names trusted proxies, asserted through the audit row a failed login writes at 0, 1 and 2 hops | no | Cloud Run hop count: **No GCP project** | Fail-open by design. Terraform sets `TRUST_PROXY_HOPS=1` for Cloud Run; unverified against a live service |
| Dependency audit | yes | `npm audit` in CI | partly — 6 moderate advisories, none high | no | — | — |

### AI capability

| Dimension | I | T | RV | PV | Blocked | Remaining |
|---|---|---|---|---|---|---|
| Chat + streaming (SSE) | yes | yes | yes — real qwen2.5, real token accounting | no | — | — |
| Provider-neutral routing, fallback, breaker | yes | 18 | yes — real failures, real fallback | no | — | — |
| Hosted LLM adapters (OpenAI, Anthropic, Google) | yes | 36 fixture tests | **no** | no | **No credentials** | — |
| Self-hosted LLM adapter | yes | 12 | yes | no | — | — |
| Agent engine (task graph, retries, approval, recovery) | yes | 52 | yes — real model, real tool calls. Approval is per call, not per call id, by a test that fails on the old code | no | — | — |
| Tool calling (11 native tools) | yes | 114 (+1 skipped) | yes — real `tool_calls` from a real model | no | — | — |
| Multi-call turn + approval transcript | yes | 1 (fails on old code) | partly — proven by test, not yet by a live multi-call approval | no | — | — |
| Coding agent | yes | yes | partly — 6 real tool calls, verification correctly refused to pass unchanged source | no | — | Full FAIL→patch→PASS not completed; limited by the local model |
| MCP (stdio + HTTP) | yes | 39 | yes — 14 tools, 0 enabled by default | no | — | — |
| Memory (store, retrieve, inject) | yes | 32 | yes — **changed a real model's answer** | no | — | — |
| Conversation summarization (FR-030) | yes | 15 + 1 route test | yes — fact from turn 1 recalled through the summary, live (ADR-103). The history fingerprint, the tool-safe split and the refusal of blank or truncated summaries (ADR-110) by test and killed mutants, not re-run live | no | — | Per-deployment threshold, not per-model |
| RAG (chunk, embed, retrieve, cite) | yes | 47 | yes — citation at real cosine distance | no | — | CSV/code-aware chunking, OCR |
| Grounding refusal | yes | 10 | yes — refuses where it once fabricated | no | — | — |
| Embeddings | yes | yes | yes — real nomic-embed-text, 768d | no | — | — |
| Web retrieval (FR-011) | yes | 42 | yes — real public URLs read | no | — | **Web search not built** |
| Image generation | yes | 12 | **no** — mock pipeline only | no | **No credentials** | — |
| Video generation | yes | 31 | **no** — mock pipeline only | no | **No token** | — |
| Long-form video composition | yes | 26 | yes — h264+aac+mov_text MP4 confirmed by ffprobe | no | — | Scene clips from the mock |
| Narration (TTS) | yes | yes | yes — real Windows SAPI. The long-form suite uses SAPI where it exists and a deterministic PCM test tone elsewhere, such as CI's Linux runner: 3/3 on each path here | no | — | Windows-only offline path; the tone is a test fixture, not a voice |
| Subtitles | yes | 7 | yes — ffprobe-measured timings | no | — | — |

### Data and platform

| Dimension | I | T | RV | PV | Blocked | Remaining |
|---|---|---|---|---|---|---|
| PostgreSQL + pgvector (22 tables, 45 indexes) | yes | yes | yes — real Postgres | no | — | — |
| Migrations | yes | 3 | yes — clean empty DB, no drift; 0002 adds `conversations.summary_fingerprint` | no | — | — |
| Repository pattern with scope in the `WHERE` | yes | yes | yes | no | — | — |
| Queues (pg-boss), DLQ, replay | yes | 18 | yes; a deleted account's queued jobs are cancelled, by route test | no | — | — |
| Quotas, enforced before spending | yes | 11 | yes — real 429s | no | — | — |
| Usage ledger, idempotent | yes | yes | yes — **key was a per-process counter; fixed** | no | — | — |
| Asset storage (local + GCS) | yes | yes | partly — local verified; GCS via fake-gcs-server. Both remove the bytes when the row cannot be written, by test | no | Real bucket needs GCP | — |
| Graceful shutdown | yes | yes | yes — `ROLE=worker` SIGINT exits 0, live; every worker-role shutdown exited 1 until ADR-108 | no | — | — |

### Operability

| Dimension | I | T | RV | PV | Blocked | Remaining |
|---|---|---|---|---|---|---|
| Structured logging with redaction | yes | yes | yes | no | — | 7 production `console` sites bypass it (technical debt sweep) |
| Traces (OpenTelemetry) | yes | in 26 | yes — real 3-level span tree | no | — | No collector configured |
| Metrics (Prometheus) | yes | in 26 | yes — real exposition | no | — | — |
| Health and admin endpoints | yes | 4 | yes | no | — | — |
| Request correlation | yes | 2 | yes — **was a per-process counter; now a UUID** | no | — | — |
| Config validation and boot refusal | yes | 7 boot checks | yes — refusals now assert their reason | no | — | — |
| `.env` loading | yes | 4 | yes — **repo-root path resolved OUTSIDE the repo; fixed** | no | — | — |

### Delivery

| Dimension | I | T | RV | PV | Blocked | Remaining |
|---|---|---|---|---|---|---|
| Test suite | yes | **705 passed, 0 failed, 1 skipped, 86 files** | yes — with ffmpeg, clamd and fake-gcs-server present | no | — | The skip is the Windows file-symlink case; CI on Linux must run it, and CI has never executed |
| Test gate reliability | yes | n/a | yes — timeouts sized for real infrastructure | no | — | — |
| E2E (real browser, real API) | yes | 7 | yes — against freshly started servers | no | — | — |
| Lint (3 type-aware rules) | yes | n/a | yes — 0 errors | no | — | 5 `no-console` warnings, located in the technical debt sweep |
| CI workflow | yes | n/a | partly — every step run locally, `npm ci` on a fresh clone. The `security` job now builds before it tests and the zero-skip step has a path to passing on Linux, neither true before (rows 53, 61); a step checks `docs/API.md` against its generator. **The workflow has never executed** | no | **No git remote** | — |
| Dockerfiles | yes | no | **no** | no | **No container runtime** | — |
| Terraform | yes | fmt + validate | partly — valid after the `TRUST_PROXY_HOPS` addition | no | **No GCP project** | — |
| Deployment runbook | yes | n/a | partly — its `docker build` commands named files that no longer existed; fixed | no | — | — |
| Documentation accuracy | yes | `api-contract.test.ts` for `docs/API.md` | partly — `API.md` is generated, identical to its generator's output, and checked against the server with a real request per documented row (the test fails on the previous document). Prose is reconciled by reading, and the third audit still found it wrong (rows 60–67, 75–80) | no | — | — |

---

## Every gap this audit confirmed, and its disposition

P0 = exploitable or a gate that cannot fail. P1 = a requirement unmet, or a gate that cannot
pass. P2 = a real defect with a bounded blast radius. Rows 38–80 carry the severity the third
audit confirmed; they were not re-graded against these definitions.

| # | Sev | Gap | Fixed in | Proven how |
|---|---|---|---|---|
| 1 | P0 | `fs.search`/`fs.glob` walked the deployment root — cross-tenant read | ADR-095 | Tenant B's search returned tenant A's secret |
| 2 | P0 | Boundary check 6 structurally incapable of failing | commit `ca25a80` | Two real secrets planted; still PASS |
| 3 | P1 | The search walk followed symlinks out of the workspace | ADR-095 | Junction into a host directory |
| 4 | P1 | RAG ingestion read another tenant's workspace | ADR-095 | `POST /api/v1/files` with another tenant's path succeeded |
| 5 | P1 | No code path could set `is_system_admin` | ADR-096 | Whole `/admin` surface 404 for every possible user |
| 6 | P1 | Usage idempotency key was a per-process counter | ADR-098 | Fastify's default `genReqId` read directly |
| 7 | P1 | Approving one call in a multi-call turn produced a transcript providers reject | ADR-099 | Test fails against the old code |
| 8 | P1 | Repo-root `.env` resolved outside the repository | commit `48bf37d` | `fileURLToPath` printed `Desktop\.env` |
| 9 | P1 | `.dockerignore` still excluded `apps/*/data/` | commit `48bf37d` | 82 MB of live databases in the build context |
| 10 | P1 | CI fake-implementation gate fired on correct code | ADR-101 | Ran the gate's exact pipeline locally |
| 11 | P1 | `npm test` failed on a loaded machine | ADR-100 | Two independent audit runs, different counts |
| 12 | P1 | CI skip gate matched 1 of 5 skip messages | commit `a6a0287` | Fed all five real strings to the grep |
| 13 | P1 | NFR-008 account deletion entirely absent | ADR-102 | No route, CLI or repository call existed |
| 14 | P2 | MCP reconnect: project permission, process-global effect | ADR-097 | Permission table audit |
| 15 | P2 | `publicPaths` accepted and never read | ADR-097 | A route with no guard answered 200 |
| 16 | P2 | SRT/VTT four-digit milliseconds | ADR-098 | Old algorithm printed `00:00:09,1000` |
| 17 | P2 | Shutdown abandoned remaining steps on first failure | ADR-098 | Code read; `closeDb` was last |
| 18 | P2 | Approved tool call ran outside the try/finally | ADR-098 | `PermissionError` left the node stranded |
| 19 | P2 | Runbook named Dockerfiles that no longer existed | commit `48bf37d` | Paths checked against the tree |
| 20 | P2 | Backend not independently buildable (4 missing references) | commit `48bf37d` | Cold `tsc -b` inside `backend/` |
| 21 | P2 | Boot refusal cases could not see the refusal reason | commit `a6a0287` | The new assertion failed on its first run |
| 22 | P2 | Raw NUL byte made two source files binary to grep | ADR-095 | `grep -r` printed "Binary file … matches" |
| 23 | P2 | Feature matrix reported NOT STARTED for 3 built capabilities | commit `9e794b3` | Read against the code |
| 24 | P2 | FR-030 summarization was dead code | ADR-103 | `updateSummary` had no caller |
| 25 | P2 | Web retrieval absent from the registry and the accounting | ADR-104 | No such tool existed |
| 26 | P2 | MCP stdio test load-sensitive | ADR-100 | Passed alone, failed in a full run |
| 27 | P2 | `TEST_REPORT.md` claimed zero failures | ADR-100 | Reproduced the failures |
| 28 | P1 | *(found while fixing)* Lockfile still described the old layout | commit `48bf37d` | 26 dead workspace entries |
| 29 | P1 | *(found while fixing)* E2E silently reused a stale server | ADR-105 | 6/7 failed against a contract that no longer existed |
| 30 | P0 | *(found while fixing)* The new SSRF guard was bypassable by a hex-spelled IPv4-mapped IPv6 address | commit `82989e9` | A test written to prove the decimal forms were refused |
| 31 | P1 | *(second audit)* Account deletion missed project-only collaborators and cascade-deleted their shared project | ADR-107 | Invited through the real `addProjectMember`, then deleted the inviter |
| 32 | P2 | *(second audit)* Summarization stored `covered` as a prompt position; a toggling memory preamble dropped a turn | ADR-107 | Turn `t14` in neither the summary nor the live window |
| 33 | P2 | *(second audit)* Boundary check 2 could not see a multi-line value import | ADR-106 | Planted one; the script reported PASS |
| 34 | P2 | *(second audit)* SSRF guard missed `::ffff:0:0:0/96`, Teredo `2001::/32` and `fec0::/10` | ADR-107 | `isBlockedAddress` returned false for each |
| 35 | P2 | *(second audit)* A containment test passed with zero assertions when symlinks were refused | ADR-106 | Read the early `return` path; ran on Windows |
| 36 | P2 | *(second audit)* A docstring claimed `bootstrapSystemAdmin` excluded concurrent winners | ADR-107 | READ COMMITTED plain SELECT; comment corrected, race recorded |
| 37 | P2 | *(second audit)* The deletion audit row asserted success before the deletion ran | ADR-107 | A failed deletion now writes no row, asserted by test |
| 38 | P1 | *(third audit)* Account deletion left every agent-written file in `SANDBOX_ROOT/<projectId>`, and reported 200 | ADR-109 | Route test writes a file, deletes the account, asserts the directory is gone |
| 39 | P1 | *(third audit)* A private project was kept, reachable by no one, when any other project in the organization had a collaborator | ADR-109 | Service test through `createProject` + `addProjectMember` |
| 40 | P2 | *(third audit)* Deletion's password re-check ignored the lockout; its rate limit keyed on the client-supplied `X-Forwarded-For` | ADR-108 (+ ADR-112) | Lockout tests; route test: a rotating XFF gets 401×5, then 429 |
| 41 | P2 | *(third audit)* In-flight jobs orphaned storage objects after deletion; queued jobs still ran | ADR-109 | Asset-store test (row insert fails → bytes removed); route test (queued job → cancelled) |
| 42 | P2 | *(third audit)* `web.fetch`'s refusal named the private IP an internal hostname resolved to — a DNS oracle | ADR-108 | Private and unresolvable names get the identical message |
| 43 | P2 | *(third audit)* `web.fetch`'s timeout was a socket idle timer; the registry timeout did not abort the request | ADR-108 | A slow-drip server is rejected at the deadline; external abort test |
| 44 | P2 | *(third audit)* Audit rows kept the deleted user's email and IP, beside a "no personal data" comment | ADR-109 | Failed login from an IP, delete: no row keeps the email or IP; the erasure record stores a SHA-256 |
| 45 | P1 | *(third audit)* The summary was keyed to a position in the client's array; a failed turn plus a reload dropped a turn | ADR-110 | Fingerprint test; mutant "fingerprint not checked" killed; `ChatView` stops sending error entries |
| 46 | P1 | *(third audit)* The live-window cut separated tool calls from their results (a provider 400); the summarizer's transcript dropped calls | ADR-110 | Tool-safe split test; mutants killed |
| 47 | P1 | *(third audit)* `web.fetch` drained rather than closed a redirect body — 7 GB in 6 s after returning | ADR-108 | An endless redirect body is closed |
| 48 | P2 | *(third audit)* A stored summary was reused when its count exceeded the history sent, injecting a summary of other content | ADR-110 | Branch test: the summary of history A is discarded for history B |
| 49 | P2 | *(third audit)* Every worker-role graceful shutdown failed a step and exited 1 | ADR-108 | Verified live: `ROLE=worker` SIGINT exits 0 |
| 50 | P2 | *(third audit)* The summary's usage idempotency key could repeat across two real calls, dropping a charge | ADR-110 | Route test: 2 usage rows; 1 row on the old key |
| 51 | P2 | *(third audit)* Number 43 from the cancellation side: nothing aborted the request on a tool timeout or task cancel | ADR-108 | External abort test |
| 52 | P2 | *(third audit)* Truncated `web.fetch` content could end in U+FFFD | ADR-108 | `trimIncompleteUtf8` tests |
| 53 | P1 | *(third audit)* The CI `security` job ran vitest against packages it never built — it could never pass | ADR-108 | Build step added to the job; the job has never executed |
| 54 | P1 | *(third audit)* Boundary check 2 still passed real runtime imports of `shared` | ADR-111 | 11 planted shapes in the self-test |
| 55 | P2 | *(third audit)* Boundary check 3 missed `node:fs/promises`, bare `fs` and `child_process` | ADR-111 | Planted in the self-test |
| 56 | P2 | *(third audit)* Checks 1, 4 and 5 matched only a double-quoted static `from "..."` | ADR-111 | Planted: single quotes, `import()`, `require()` |
| 57 | P2 | *(third audit)* Check 6 missed bracket and destructured `process.env` reads | ADR-111 | Planted: bracket, destructure, alias, computed, optional |
| 58 | P2 | *(third audit)* The "no audit record when the deletion does not happen" test passed on the audit-first code | ADR-109 | A trigger fails the transaction after the lookup |
| 59 | P2 | *(third audit)* The no-fake-in-production test booted the whole server by importing `index.ts` | ADR-108 | Provider factories moved to a side-effect-free `providers.ts` |
| 60 | P1→P2 | *(third audit)* `API.md` said dead-letter replay is administrator-only; any project editor can replay | ADR-112 | Generator rewrite; `api-contract.test.ts` fails on the old document, naming this row |
| 61 | P1 | *(third audit)* The CI zero-skip gate could never pass on Linux: the long-form suite always skipped | ADR-111 | PCM tone provider where no synthesiser exists; 3/3 on SAPI and on the forced tone |
| 62 | P1 | *(third audit)* The documented Docker sandbox check ran no Docker test; "unit only" and "flag construction verified" had no test | ADR-111 | `dockerRunArgs` flag tests; `npm run test:docker` fails, not skips, without docker |
| 63 | P2 | *(third audit)* `API.md` mislabelled login/logout, `me`/`projects`, and one rate limit | ADR-112 | The contract test fails on the old document, naming each row |
| 64 | P2 | *(third audit)* `SECURITY.md` said deletion requires the session; an API key plus the password deleted the account | ADR-108 (the code made the document true) | Route test: API key → 403, user still present |
| 65 | P2 | *(third audit)* This document's technical-debt sweep said all 12 `eslint-disable`s are in boot and shutdown paths; none is | docs | Re-measured: the sweep below |
| 66 | P2 | *(third audit)* This document's "eight of the 37 reported success unconditionally" was contradicted by two of its own rows | docs | Reworded to cover both directions |
| 67 | P2 | *(third audit)* "Four hosted adapters" / "all five LLM adapters with real HTTP" miscounted | docs | 3 hosted + 1 self-hosted + 1 mock LLM adapter; the mocks make no HTTP |
| 68 | P1 | *(third audit)* `htmlToText`'s regexes were quadratic: one page froze the API for ~90 s, for every tenant | ADR-108 | Verified while fixing: 64 KB of `<` took 1.4 s before the rewrite; 512 KB hostile inputs asserted under 2 s after |
| 69 | P2 | *(third audit)* An organization kept for a collaborator outlived that collaborator's own deletion | ADR-109 | Verified while fixing: service test, the last collaborator's deletion removes the organization |
| 70 | P1 | *(third audit)* A later tool call reusing an approved call's id ran without approval (adapter ids repeat) | ADR-108 | Verified while fixing: engine test fails on the old code |
| 71 | P2 | *(third audit)* A blank summarizer reply erased aged turns; a length-truncated summary was stored as complete | ADR-110 | Verified while fixing: empty-summary test; the route rejects `finishReason: "length"`; mutants killed |
| 72 | P1 | *(third audit)* The boundary checks never read `.js`/`.jsx`/`.mjs`/`.cjs` files | ADR-111 | Verified while fixing: planted in the self-test |
| 73 | P2 | *(third audit)* Check 5 needed a `/` after the directory, so a bare `../../../shared` passed | ADR-111 | Verified while fixing: planted the bare path and an `@/../shared` alias |
| 74 | P2 | *(third audit)* Check 7 printed a pass while `backend/src` imported an undeclared `drizzle-orm` | ADR-111 | Verified while fixing: rule 7 on the real tree found `drizzle-orm` (backend) and `uuid` (quota); both declared |
| 75 | P1 | *(third audit)* The system administrator got owner+admin on every tenant's project; the docs said `/admin` only | ADR-108 (code) + docs | Verified while fixing: test, the administrator has no implicit tenant access; `createProject` has no bypass |
| 76 | P2 | *(third audit)* This document named `9e794b3` as the audited tree; nine of the fix commits it cites are ancestors of it | docs | Verified while fixing: `git merge-base --is-ancestor`, all nine YES; the tree the first audit read is `b4cf4af` |
| 77 | P2 | *(third audit)* This document's closing item swapped the audits' counts ("the second found 27, the first 30") | docs | Verified while fixing: contradicted by the same document's introduction and arithmetic |
| 78 | P2 | *(third audit)* `API.md` said another tenant's resource returns "404, never 403"; an API key naming a foreign project gets 403 | ADR-112 | Verified while fixing: read `requireProject` in `plugins/auth.ts`; generator conventions corrected |
| 79 | P2 | *(third audit)* `cd backend && npm install && npm run dev` could not start on a fresh clone | ADR-112 | Verified while fixing: backend `predev`, frontend `prebuild`; on a real fresh clone the backend alone served health and the frontend alone built |
| 80 | P2 | *(third audit)* The lint gate was documented as 6 accepted `no-console` warnings; eslint reports 5 | docs | Verified while fixing: `npm run lint`, 0 errors, 5 warnings |

**Disposition: 80 confirmed across three audits, 80 addressed, 0 disputed.**

**Rows 1–37: 37 confirmed, 37 fixed.** One of the 37 (number 36) was a false claim in a comment;
the comment is corrected, and the race it had denied is recorded as a known limitation rather than
locked, because an advisory lock is a real change that was not made.

**Rows 38–80, the third audit's #1–#43: 43 confirmed, 43 addressed** — 31 by code, each with a
test or live verification, and 12 as documentation corrections, of which #24 and #25 were also
fixed in code. Severity as filed: 14 P1 (#1, #2, #8, #9, #10, #16, #17, #24, #25, #31, #33, #35,
#38, and #23, which one verifier judged P2) and 29 P2. None was graded P0.

They were not all verified the same way, and the difference is stated rather than smoothed over.
#1–#30 were each confirmed by two independent verifiers who tried to refute them; the split
verdicts on #21 and #22 were judged real. **The verifying agents for #31–#43 (rows 68–80) were lost
to a session limit before returning verdicts.** None of those thirteen was accepted on the finder's
word: each was verified while fixing it, by the evidence in its row — a measurement, a test that
fails on the old code, mutants, planted fixtures, `git merge-base`, a lint run, a fresh clone. That
is a check by the party making the fix, not two attempts at refutation by someone else.

Four defects introduced while fixing the third audit's findings were caught before commit and are
not among the 80: a batch script's stale offsets corrupted `conversation-window.ts` (typecheck
caught it); an orphan-result guard was unreachable (a mutant survived; removed, reasoning in
ADR-110); the contract test's logout cascade (caught by running it against the old document); and
a test that mistook `node -e 1` for an environment flag.

The arithmetic, stated so the numbers cannot be read two ways: **29 of the 30 were present in
the audited tree** — 27 found by the audit, and two (the lockfile, the E2E server reuse) found
while fixing those. The thirtieth was **introduced by the fix for number 25** and did not exist
before this phase.

Numbers 31–37 came from a second independent audit of this phase's diff. Six of them (31, 32, 34,
35, 36, 37) are defects in code written this phase to close 1–30. Number 33 was already present
in the audited tree — boundary check 2's line-based design — and the first audit did not catch it.
So across the first two audits: **30 gaps were present in the tree declared finished, and 7 were
introduced by the work of fixing them.**

Numbers 38–80 came from the third audit, which read `78a0e13..74c7cd0` — this phase's own work:
the frontend/backend split, the first audit's fixes and the second's. This document does not
divide those 43 into present-before and introduced-by, because that was not established finding
by finding. The totals by audit, then: **30 from the first (27 found by it, 3 while fixing), 7
from the second, 43 from the third — 80.**

Number 30 is the one to read twice. It was introduced by the fix for number 25 — closing a gap
created a P0 in the code that closed it — and it was found only because a test written to prove
the DECIMAL address encodings were refused happened to include a hex one. It had also been masked
by an accident: the address never reached the branch that mishandled it, because an earlier step
failed first for an unrelated reason. Making that earlier step more correct is what exposed it.
New security code needs the same suspicion as old security code, and a guard that appears to work
may be working for a reason that is about to change.

---

## Technical debt sweep

Measured on `fd5f5a5`, not asserted. The previous version of this table said all 12
`eslint-disable`s sat in boot and shutdown paths where no logger exists; none does (row 65). It
also listed one `skipIf` and six lint warnings.

| Marker | Count | Note |
|---|---|---|
| `TODO` / `FIXME` / `HACK` / `XXX` in source | **0** | Deferrals are recorded in ADRs and in the feature matrix's Remaining columns, where they are read, rather than in comments where they are not |
| `@ts-ignore` / `@ts-expect-error` | **0** | |
| `: any` / `as any` in non-test code | **0** | |
| `it.skip` / `it.only` / `it.todo` / `describe.skip` / `describe.only` | **0** | A skipped test is not a passing test (brief §29) |
| `skipIf` | 6 | Five `describe.skipIf` on a missing binary — fake-gcs-server (`asset-store.integration`), ffmpeg (`video-longform`, `video-render`, `video-timeline`), clamd (`clamav-scanner`) — and one `it.skipIf` for file symlinks (`search-isolation`). CI installs all three binaries and runs on Linux, where file symlinks work, so CI expects 0 skips and fails on any. Locally on Windows with the binaries present: 1 skip |
| `eslint-disable` | 12 | All `no-console`, **none in boot or shutdown**: 5 skip notices in test files (media's `asset-store`, `video-longform`, `video-render` and `video-timeline` integration tests; scanning's `clamav-scanner.test.ts`); 3 incomplete-telemetry warnings in the streaming LLM adapters (`llm-anthropic:240`, `llm-google:239`, `llm-openai:288`); 4 runtime error sinks where no logger is injected (agent-core `engine.ts` `onUnexpectedError`, database `client.ts` pool `'error'`, jobs `queue.ts` pg-boss `'error'`, security `auth-service.ts` failed audit write) |
| Lint errors | **0** | 5 `no-console` warnings: `database/src/migrate-cli.ts:12` (CLI), `jobs/src/queue.test.ts:145` (test diagnostics), `backend/src/config.ts:300` and `:304` (before the logger exists), `backend/src/index.ts:1223` (fatal startup) |
| Type errors | **0** | `npm run typecheck`, all workspaces |

Three kinds of debt are real, and are named here because a count alone does not say what they cost:

- **Seven production sites bypass the redacting logger.** The three adapter telemetry warnings and
  the four error sinks above run in production and write to the console, so what they print does
  not pass through the structured logger's redaction.
- **Two permissions are granted and govern nothing.** `tools:manage` and `mcp:manage` are in
  `PROJECT_ADMIN`, and both routes they were written for moved to `requireSystemAdmin` (ADR-089,
  ADR-097) because they mutate process-global state. They are kept because the design that would
  use them — per-project tool and MCP policy — is a real schema change that is deliberately not
  done. `shared/src/auth.ts` says so at the definition.
- **The mock providers are reachable outside production by design,** and that is load-bearing for
  the zero-configuration local loop. What makes it safe is asserted rather than assumed: a test
  builds the real provider set from a production config and checks nothing in it is a mock, and
  checks the mock IS present outside production, so the assertion cannot pass vacuously. Since
  row 59 it builds them from a side-effect-free `providers.ts`, not by importing the server.

## What this audit does NOT establish

Stated because an audit that lists only what it proved is half a document.

1. **Nothing has been production verified.** No deployment. Every "no" in the PV column is
   literal. Managed Postgres under connection pressure, Cloud Run cold starts, a real load
   balancer's header rewriting, GCS under concurrent writes, and the behaviour of the whole
   system under sustained real traffic are all unknown.
2. **No hosted AI provider has ever answered this code.** Three hosted LLM adapters (OpenAI,
   Anthropic, Google), the OpenAI image adapter and the Replicate video adapter make real HTTP
   and are fixture-tested against recorded wire shapes. Recorded shapes cannot reproduce a
   provider's real rate-limit semantics, its streaming edge cases, or its error taxonomy under load.
3. **`docker build` has never run,** so the Dockerfiles are reviewed rather than verified. The
   Docker sandbox's isolation flags are asserted by unit tests of `dockerRunArgs`, but whether
   they contain a process in a real container is unknown: the real-container suite
   (`npm run test:docker`) has never run, and here it fails by design because docker is not
   installed. This item used to say the isolation was asserted by flag construction; until row 62
   no test did even that.
4. **The CI workflow has never executed.** Every command in it was run locally and passes, and
   `npm ci` was proven on a fresh clone — but a workflow that has never run is not a workflow
   that works. Three of its steps could never have passed (rows 10, 53 and 61), and nothing showed
   it, because it had never run.
5. **No load, soak or concurrency testing.** The 20-minute video path, the agent loop under many
   simultaneous tasks, and the rate limiter under genuine contention are untested at scale.
6. **No adversarial security testing by a third party.** The 80 gaps above were found by this
   project's own audits and by the work of fixing what they found; that is evidence of effort, not
   of absence.
7. **Another audit would probably find more.** The first found 27 in a tree whose gates were all
   green (30 with the three found while fixing), the second found 7 in the fixes, and the third
   found 43 in this phase's diff. The honest prior is that the number is not yet zero.
8. **`TRUST_PROXY_HOPS=1` for Cloud Run is unverified.** Terraform sets it because Cloud Run's
   front end appends the caller's address, and the hop arithmetic is asserted at 0, 1 and 2 hops —
   but no live Cloud Run service has confirmed 1 is the right number, and every per-IP rate limit
   and audit row depends on it.
9. **The third audit's last 13 findings were verified while fixing, not by independent
   verifiers.** Their verifying agents were lost to a session limit (rows 68–80). Each carries the
   evidence in its row; none had the two refutation attempts #1–#30 had.
10. **The re-run of the third audit's workflow had not happened when this was written.** Its "went
    dry" signal counted failed finders as dry, so it cannot support a claim that no findings
    remain. P0/P1 remaining: 0 known — every one of the 80 gaps above is addressed — and the
    re-audit is pending.

---

# The fourth audit (2026-09-14 … 2026-09-18)

**Tree read:** `acc5416`. **Fixes:** `48eebec … 513e709`, eighteen commits, ADR-123 … ADR-142.
**Confirmed:** 5 P0 · 53 P1 · 98 P2. **Closed:** every P0 and every P1.

## What kind of defects these were

Almost none of the 58 were "this code is wrong". They were, overwhelmingly, **machinery that
existed and nothing reached**:

- `revokeAllSessions` shipped with the docstring "used on password change and by an admin". Neither
  caller was ever written, so a user whose laptop was stolen could only delete their account.
- `MEMORY_EXTRACTION_PROMPT`, `parseExtractedFacts` and `recordExtracted` all shipped with their own
  tests and no caller anywhere else. Memory held only what somebody typed in by hand.
- The reasoning loop's `verify` hook had a self-correction branch behind it, and `planAutonomous`
  explained in a comment that "the reasoning loop runs its own verification pass".
  `grep -rn "verify:" backend/` returned nothing at all. The gate could not fail.
- The loop emitted a `tool_call` and a `tool_result` for every action, and the engine forwarded
  neither: a ten-minute run was a spinner and then an answer, with no record afterwards.
- The approval card read `node.toolId` and `node.input` — the fields of a declarative node — so
  every autonomous run asked a human to approve "Tool call `undefined`" with the arguments hidden.
- The coding screen filtered for `code.apply_literal_fix`, a tool that is not registered anywhere.
- The task-type dropdown omitted `autonomous`, so the model-driven engine the whole platform is
  built around could only be started by posting JSON by hand.
- The agent works in a per-project workspace and **nothing in the product could put a file in it**,
  so "fix the failing test" had no test to fix.

The pattern matters more than any single item: a feature can be built, tested, documented and
completely unreachable, and every gate stays green the whole time. Tests assert what the author
thought to assert; they do not ask whether anything calls the thing.

## The defects that cost money or gave something away

- **The lockout was a password oracle.** `login` verified the password *before* checking
  `lockedUntil`, so a locked account answered a wrong guess "Invalid email or password." and a
  RIGHT one "This account is temporarily locked…". Tripping the lockout turned it into an oracle
  for the password it exists to protect.
- **Quotas could be raised by pressing a button.** Every limit was per project, and any user can
  create projects. `DAILY_TOKEN_LIMIT=100000` meant a hundred thousand tokens *per project*.
- **`image.generate` gave a job 60 seconds** while the providers are allowed 180 and 600. Every
  real generation outran its claim window and was generated twice — and the usage row's
  idempotency key deduplicated the *billing record*, hiding the second charge rather than
  preventing it.
- **`runFfmpeg` had no timeout**, so a wedged render held a worker forever while pg-boss handed the
  same render to another one: a hang produced two ffmpegs writing one project.
- **Dead-letter replay accepted any queue name and any job state.** `sourceQueueNameFor` returns a
  non-`.dlq` name unchanged, so a completed job could be re-sent to the live queue it had already
  run on, repeatedly — and `cancel` is a no-op on a completed job, so nothing ever stopped it.
- **Cancellation stopped one layer short.** ADR-119 built the chain carefully and verified every
  layer but the last: `parseSseStream` took the response reader and never released it, so the
  upstream connection stayed open and a provider kept generating, and charging, for a reader that
  had gone.
- **Streamed answers were discarded by the browser.** The SSE response set
  `Access-Control-Allow-Origin` but not `Access-Control-Allow-Credentials`, and the client sends
  `credentials: "include"`. `curl`, `fetch` from Node and `app.inject()` all ignore CORS, which is
  why every green run stayed green.

## The gates that could not fail

- **CI could not pass.** Its zero-skip step asserts that no test skipped, on the stated premise
  that every gated binary is installed above it. Four suites needed binaries CI never installed.
- **The deployed API could not start.** The Dockerfile sets `NODE_ENV=production`, the Terraform
  service sets `ROLE=api`, and the code refuses that combination under process isolation unless an
  operator explicitly accepts it. `grep -rn "SANDBOX" infrastructure/` returned one line of prose.
- **`roleRuns` was the only coverage the api/worker split had** — a pure decision table. Nothing
  started a process, which is exactly why nobody noticed that one of them refused to.
- **The metrics described one branch of one route.** `provider_request_count` was written only in
  the chat route's success path, below a `continue`. A dashboard built on it showed 100% success
  during an outage: the failures were not recorded as failures, they were not recorded at all.

## How the fixes were checked

Every fix was re-run **with itself removed**, to watch the covering test fail. That discipline
found three tests that were worthless and one that was actively misleading:

- An end-to-end sandbox-escape test passed against the unfixed resolver — a junction to a missing
  directory fails the write anyway, for an ordinary reason. Replaced with a file-symlink case,
  correctly reported as skipped on Windows and run in CI.
- The first browser test of the CORS fix asserted `not.toBeEmpty()` on the assistant bubble, which
  the in-flight "…" placeholder satisfies. It went green against a transport that never delivered a
  single word. It asserts a word character now.
- A probe test named "gives up on a binary that never exits" probed a binary that exits.
- A quota test asserted fail-closed behaviour on a ledger that could, by then, measure the thing.

The same discipline applied to the live run, and **UAT-11 found a defect in a fix from this very
audit**. The new MCP Enable button was offered to every user, but the endpoint is system-admin only
(ADR-089) and answers 404 — so a project member would have pressed it and been told "Not found."
The component test could not have caught it, because it mocks the API and the refusal lives in the
API.

## What was run, and what was not

Sixteen of seventeen acceptance tests pass against a real stack, with every measurement recorded in
`docs/LOCAL_USER_ACCEPTANCE_TEST.md`: a real local model answering chat and RAG with a real
citation and an honest refusal; an agent choosing `fs.read_file` itself and being verified; a
576,011-byte 512×512 PNG from a local diffusion model; a 3.98 s WAV whose stored duration was
measured rather than estimated; a 249,579-byte MP4 confirmed by ffprobe as h264 + aac + mov_text,
with captions reading back as the narration; real 429s; cross-tenant reads answered 404; and the
agent's own tool call sitting in the `audit_log` table.

**UAT-17 — the coding agent — did not complete, and is reported as FAIL.** Every component worked,
and the platform refused three stale patches rather than corrupting a file. The 7B local model
invoked the terminal tool with the binary duplicated into its own arguments, so the test never ran
and it never saw the failure it was meant to fix; the patch it then wrote was its own no-op. That
is a model-capability ceiling rather than a platform defect, and it is the one capability here
never observed working end to end.

**Still BLOCKED_EXTERNAL, unchanged:** container builds and the CI workflow (no Docker, no git
remote), the cloud deployment (no GCP project), and the three hosted model providers plus Replicate
(no credentials). Nothing in this repository has ever run in a deployed environment.

## The 98 P2s

Triaged, not fixed. None is a broken capability, a security hole or a false claim — the three
classes this phase treated as blocking. They are recorded in the audit artefacts and remain open
work; a phase that closed 58 defects and called the remaining 98 "done" would be repeating the
mistake this document exists to catch.
