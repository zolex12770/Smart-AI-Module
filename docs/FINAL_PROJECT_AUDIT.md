# Final Project Audit

**Date:** 2026-09-12 · **Audited commit:** the tree at `9e794b3` · **Auditor:** a 32-agent
independent audit, plus the fixes it forced and a full re-run of every gate.

This is the per-dimension record the project brief (§44) asks for. It is not a summary of
`docs/PROJECT_STATUS.md` — that file says what the state IS; this one says how each claim was
established, and what was found wrong when someone went looking.

## How this audit was run, and why that matters

The tree audited had already been declared finished. Every gate was green: build, typecheck,
lint, 556 tests with zero skips, boundary 9/9, migrations 3/3, boot 7/7, E2E 7/7. The status
document said CODE COMPLETION 96%, "P0 remaining: 0 · P1 remaining: 0".

The audit confirmed **27 gaps**, including two P0s. Three more were found while fixing them —
one of which was a P0 introduced BY one of the fixes. The
most useful thing in this document is therefore not the table below but that sentence: a complete
set of passing gates established almost nothing about the properties anyone actually cared about,
because several of the gates *could not fail*.

**The recurring defect class, stated plainly.** Six of the 30 were gates that reported success
unconditionally:

| Gate | How it could not fail |
|---|---|
| `verify-boundary.sh` check 6 (secret leakage) | Passed both `-E` and `-P`; GNU grep aborts with "conflicting matchers", `2>/dev/null` hid it and `\|\| true` swallowed the exit. Two real secrets planted in frontend source still gave PASS |
| CI "no fake implementation" | Line-based grep for a guard that sits on the *previous* line — fired on correct code, so the `security` job could never pass at all |
| CI "gated suites actually ran" | Matched one of the five real skip messages; four suites could skip silently |
| `verify-boot.sh` refusal cases | Asserted only that health never answered — which a port clash or a syntax error satisfies as well as the refusal under test |
| Playwright `reuseExistingServer` | Silently reused a backend from an earlier session, so E2E tested code that was not under test |
| `npm test` timeouts | Passed on an idle machine and failed on a loaded one with a different count each run |

Every one is now proven able to fail, by planting the violation it exists to catch. That is the
standard this document applies: a check nobody has watched fail is a check of unknown value.

---

## Per-dimension audit

Columns: **I**mplemented · **T**ested · **RV** Runtime Verified · **PV** Production Verified ·
**Blocked** · Remaining.

### Architecture and structure

| Dimension | I | T | RV | PV | Blocked | Remaining |
|---|---|---|---|---|---|---|
| Frontend/backend physical separation | yes | 9 boundary checks | yes — each builds and boots alone from a cold tree | no | — | — |
| Boundary enforcement | yes | yes | yes — every check proven able to fail | no | — | — |
| `shared/` is a contract, not a coupling | yes | check 2 | yes — every frontend import of it is `import type` | no | — | — |
| Monorepo build graph (26 workspaces) | yes | `tsc -b` | yes — backend builds standalone after 4 missing project references were added | no | — | — |
| Lockfile integrity | yes | `npm ci` | yes — fresh `git clone` + `npm ci`, exit 0, first time ever | no | — | — |

### Security

| Dimension | I | T | RV | PV | Blocked | Remaining |
|---|---|---|---|---|---|---|
| Authentication (scrypt, sessions, API keys, CSRF, lockout) | yes | 43 in `security` | yes — live 401/403/404 | no | — | Password reset, email verification, MFA, SSO |
| Authorization as a SQL predicate | yes | yes | yes — cross-tenant 404 in a real browser | no | — | Per-project tool/MCP policy |
| Deny-by-default authentication | yes | 4 | yes | no | — | — |
| Administrator role | yes | 4 | yes — **admin 200, ordinary user 404, live** | no | — | No administration UI |
| Tenant isolation: database | yes | yes | yes | no | — | — |
| Tenant isolation: agent workspaces | yes | 9 | yes | no | — | — |
| Tenant isolation: **search tools** | yes | 9 | yes — **was a proven cross-tenant read** | no | — | — |
| Tenant isolation: **RAG ingestion** | yes | 3 | yes — **was a proven cross-tenant read** | no | — | — |
| Sandbox containment (symlinks, traversal) | yes | 8 + 9 | yes — real junctions into host directories | no | — | — |
| SSRF guard (`web.fetch`) | yes | 32 | yes — metadata endpoint, `localhost` via `::1`, `10.0.0.1`, `file://` and every hex/octal/decimal spelling refused live | no | — | A public host that PROXIES to a private one is indistinguishable; `WEB_FETCH_ALLOWLIST` is the answer. Egress is also an exfiltration channel for a prompt-injected agent, and is not metered |
| Malware scanning | yes | 7 | yes — real clamd, real EICAR | no | — | — |
| Upload controls (type, sniff, size, disposition) | yes | yes | yes | no | — | — |
| Secret handling | yes | staged-diff scan before every commit | yes | no | — | — |
| Account and data deletion (NFR-008) | yes | 12 | yes — live, including the file on disk | no | — | No operator-initiated deletion or export-before-delete |
| Rate limiting | yes | 10 | yes — 201,201,201,429,429 | no | — | Fail-open by design |
| Dependency audit | yes | `npm audit` in CI | partly — 6 moderate advisories, none high | no | — | — |

### AI capability

| Dimension | I | T | RV | PV | Blocked | Remaining |
|---|---|---|---|---|---|---|
| Chat + streaming (SSE) | yes | yes | yes — real qwen2.5, real token accounting | no | — | — |
| Provider-neutral routing, fallback, breaker | yes | 18 | yes — real failures, real fallback | no | — | — |
| Hosted LLM adapters (OpenAI, Anthropic, Google) | yes | 36 fixture tests | **no** | no | **No credentials** | — |
| Self-hosted LLM adapter | yes | 12 | yes | no | — | — |
| Agent engine (task graph, retries, approval, recovery) | yes | 51 | yes — real model, real tool calls | no | — | — |
| Tool calling (11 native tools) | yes | 97 | yes — real `tool_calls` from a real model | no | — | — |
| Multi-call turn + approval transcript | yes | 1 (fails on old code) | partly — proven by test, not yet by a live multi-call approval | no | — | — |
| Coding agent | yes | yes | partly — 6 real tool calls, verification correctly refused to pass unchanged source | no | — | Full FAIL→patch→PASS not completed; limited by the local model |
| MCP (stdio + HTTP) | yes | 39 | yes — 14 tools, 0 enabled by default | no | — | — |
| Memory (store, retrieve, inject) | yes | 25 | yes — **changed a real model's answer** | no | — | — |
| Conversation summarization (FR-030) | yes | 8 | yes — fact from turn 1 recalled through the summary, live | no | — | Per-deployment threshold, not per-model |
| RAG (chunk, embed, retrieve, cite) | yes | 47 | yes — citation at real cosine distance | no | — | CSV/code-aware chunking, OCR |
| Grounding refusal | yes | 10 | yes — refuses where it once fabricated | no | — | — |
| Embeddings | yes | yes | yes — real nomic-embed-text, 768d | no | — | — |
| Web retrieval (FR-011) | yes | 32 | yes — real public URLs read | no | — | **Web search not built** |
| Image generation | yes | 12 | **no** — mock pipeline only | no | **No credentials** | — |
| Video generation | yes | 31 | **no** — mock pipeline only | no | **No token** | — |
| Long-form video composition | yes | 26 | yes — h264+aac+mov_text MP4 confirmed by ffprobe | no | — | Scene clips from the mock |
| Narration (TTS) | yes | yes | yes — real Windows SAPI | no | — | Windows-only offline path |
| Subtitles | yes | 7 | yes — ffprobe-measured timings | no | — | — |

### Data and platform

| Dimension | I | T | RV | PV | Blocked | Remaining |
|---|---|---|---|---|---|---|
| PostgreSQL + pgvector (22 tables, 45 indexes) | yes | yes | yes — real Postgres | no | — | — |
| Migrations | yes | 3 | yes — clean empty DB, no drift | no | — | — |
| Repository pattern with scope in the `WHERE` | yes | yes | yes | no | — | — |
| Queues (pg-boss), DLQ, replay | yes | 16 | yes | no | — | — |
| Quotas, enforced before spending | yes | 11 | yes — real 429s | no | — | — |
| Usage ledger, idempotent | yes | yes | yes — **key was a per-process counter; fixed** | no | — | — |
| Asset storage (local + GCS) | yes | yes | partly — local verified; GCS via fake-gcs-server | no | Real bucket needs GCP | — |
| Graceful shutdown | yes | yes | yes | no | — | — |

### Operability

| Dimension | I | T | RV | PV | Blocked | Remaining |
|---|---|---|---|---|---|---|
| Structured logging with redaction | yes | yes | yes | no | — | — |
| Traces (OpenTelemetry) | yes | in 26 | yes — real 3-level span tree | no | — | No collector configured |
| Metrics (Prometheus) | yes | in 26 | yes — real exposition | no | — | — |
| Health and admin endpoints | yes | 4 | yes | no | — | — |
| Request correlation | yes | 2 | yes — **was a per-process counter; now a UUID** | no | — | — |
| Config validation and boot refusal | yes | 7 boot checks | yes — refusals now assert their reason | no | — | — |
| `.env` loading | yes | 4 | yes — **repo-root path resolved OUTSIDE the repo; fixed** | no | — | — |

### Delivery

| Dimension | I | T | RV | PV | Blocked | Remaining |
|---|---|---|---|---|---|---|
| Test suite | yes | **646 / 79 files, 0 failed, 0 skipped** | yes | no | — | — |
| Test gate reliability | yes | n/a | yes — timeouts sized for real infrastructure | no | — | — |
| E2E (real browser, real API) | yes | 7 | yes — against freshly started servers | no | — | — |
| Lint (3 type-aware rules) | yes | n/a | yes — 0 errors | no | — | 6 accepted `no-console` warnings |
| CI workflow | yes | n/a | partly — every step run locally, `npm ci` on a fresh clone; **the workflow has never executed** | no | **No git remote** | — |
| Dockerfiles | yes | no | **no** | no | **No container runtime** | — |
| Terraform | yes | fmt + validate | partly | no | **No GCP project** | — |
| Deployment runbook | yes | n/a | partly — its `docker build` commands named files that no longer existed; fixed | no | — | — |
| Documentation accuracy | yes | n/a | yes — reconciled against source twice; three rows were still wrong after the first pass | no | — | — |

---

## Every gap this audit confirmed, and its disposition

P0 = exploitable or a gate that cannot fail. P1 = a requirement unmet, or a gate that cannot
pass. P2 = a real defect with a bounded blast radius.

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

**Disposition: 30 confirmed, 30 fixed, 0 deferred, 0 disputed.**

Number 30 is the one to read twice. It was introduced by the fix for number 25 — closing a gap
created a P0 in the code that closed it — and it was found only because a test written to prove
the DECIMAL address encodings were refused happened to include a hex one. It had also been masked
by an accident: the address never reached the branch that mishandled it, because an earlier step
failed first for an unrelated reason. Making that earlier step more correct is what exposed it.
New security code needs the same suspicion as old security code, and a guard that appears to work
may be working for a reason that is about to change.

---

## Technical debt sweep

Measured, not asserted. Each command is reproducible from the repository root.

| Marker | Count | Note |
|---|---|---|
| `TODO` / `FIXME` / `HACK` / `XXX` in source | **0** | Deferrals are recorded in ADRs and in the feature matrix's Remaining columns, where they are read, rather than in comments where they are not |
| `@ts-ignore` / `@ts-expect-error` | **0** | The only matches are in Next.js's generated `.next/dev/types/` |
| `: any` / `as any` in production code | **0** | The grep hits are the English word "any" in prose comments |
| `eslint-disable` | 12 | All `no-console`, in boot and shutdown paths where the structured logger is not yet constructed or is already closed |
| `it.skip` / `it.todo` / `it.only` | **0** | A skipped test is not a passing test (brief §29), and CI now fails on any skip |
| Lint errors | **0** | 6 accepted `no-console` warnings, same paths as above |
| Type errors | **0** | `tsc --noEmit` across all 26 workspaces |

Two kinds of debt are real and are named rather than counted, because a grep cannot see them:

- **Two permissions are granted and govern nothing.** `tools:manage` and `mcp:manage` are in
  `PROJECT_ADMIN`, and both routes they were written for moved to `requireSystemAdmin` (ADR-089,
  ADR-097) because they mutate process-global state. They are kept because the design that would
  use them — per-project tool and MCP policy — is a real schema change that is deliberately not
  done. `shared/src/auth.ts` says so at the definition.
- **The mock providers are reachable outside production by design,** and that is load-bearing for
  the zero-configuration local loop. What makes it safe is asserted rather than assumed: a test
  builds the real provider set from a production config and checks nothing in it is a mock, and
  checks the mock IS present outside production, so the assertion cannot pass vacuously.

## What this audit does NOT establish

Stated because an audit that lists only what it proved is half a document.

1. **Nothing has been production verified.** No deployment. Every "no" in the PV column is
   literal. Managed Postgres under connection pressure, Cloud Run cold starts, a real load
   balancer's header rewriting, GCS under concurrent writes, and the behaviour of the whole
   system under sustained real traffic are all unknown.
2. **No hosted AI provider has ever answered this code.** Four adapters are fixture-tested
   against recorded wire shapes. Recorded shapes cannot reproduce a provider's real rate-limit
   semantics, its streaming edge cases, or its error taxonomy under load.
3. **`docker build` has never run,** so the Dockerfiles are reviewed rather than verified, and
   the Docker sandbox's isolation properties are asserted by flag construction only.
4. **The CI workflow has never executed.** Every command in it was run locally and passes, and
   `npm ci` was proven on a fresh clone — but a workflow that has never run is not a workflow
   that works.
5. **No load, soak or concurrency testing.** The 20-minute video path, the agent loop under many
   simultaneous tasks, and the rate limiter under genuine contention are untested at scale.
6. **No adversarial security testing by a third party.** Fifteen defects were found by directed
   probing; that is evidence of effort, not of absence.
7. **A third audit would probably find more.** The second one found 27 in a tree whose gates were
   all green, after the first had found 30. The honest prior is that the number is not yet zero.
