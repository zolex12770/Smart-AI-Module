# Project Status — the single source of truth

**Date:** 2026-09-13 · **Code commit:** `fd5f5a5` — every result below was measured on that tree

This file supersedes every other status claim in the repository. Where it disagrees with a
report, a README, an ADR or the root `PROJECT_STATUS.md` (which is a historical phase log, not a
status document), **this file is correct**.

## How to read the columns

| Column | Means |
|---|---|
| **Implemented** | The code exists and does the thing. Not "a stub exists". |
| **Tested** | Automated tests assert the real behaviour, not that a function exists. |
| **Runtime Verified** | It was actually executed against real infrastructure and observed working. |
| **Production Verified** | It ran in a real deployed environment. |

Statuses: `NOT_STARTED` · `IN_PROGRESS` · `PARTIAL` · `IMPLEMENTED` · `VERIFIED` · `BLOCKED_EXTERNAL`

**`VERIFIED` requires Runtime Verified = yes.** Nothing is marked `VERIFIED` on the strength of
passing tests alone, because a test suite verifies code against its author's expectations and a
runtime verifies it against reality.

**Production Verified is `no` for every row.** No deployment has happened. That column exists so
its emptiness is visible rather than implied.

**What the previous version of this file got wrong.** It claimed CODE COMPLETION 96% with
"P0 remaining: 0 · P1 remaining: 0". An independent 32-agent audit of that tree confirmed **27
gaps**, including two P0s (a proven cross-tenant read through `fs.search`, and a boundary check
structurally incapable of failing) and a P1 privacy requirement — NFR-008, account deletion —
that was **entirely absent** while being counted as complete. Three more were found while fixing
those, and a second independent audit — of the FIXES, not the old tree — confirmed seven more,
six of them in code written in that phase to close the first audit's gaps. The scores below are lower than the previous version's in places where the previous
version was simply wrong, and the reasoning for each number is stated rather than asserted.

The version this one replaces (at `fa296c6`) was wrong again. A third audit read that phase's own
diff (`78a0e13..74c7cd0`) and returned **43 findings**, none rated P0; all 43 are addressed
(ADR-108 to ADR-112). The most serious: one human approval let a *different* destructive tool call
skip the gate later, because adapters reuse call ids; the system administrator held owner+admin on
every tenant's project; one hostile web page froze the API for about 90 s for every tenant; account
deletion kept a private project no one could reach, left every agent-written file on disk, and kept
the person's login IPs and email in the audit trail; CI's zero-skip gate could never pass on Linux;
the boundary checks could still be defeated by ordinary syntax (single quotes, `import()`, a `.js`
file); `docs/API.md` was wrong in six rows; and `trustProxy: true` let any caller choose its own
address for every per-IP rate limit and audit row. Five of the 43 corrected claims this file itself
made: "0 in CI" skips (#24), Docker "unit only" and "flag construction verified" with no test behind
either (#25), "the four hosted adapters" (#30), a `cd backend && npm install && npm run dev` that
could not start on a fresh clone (#42), and six lint warnings where eslint reports five (#43).

---

## Matrix

| Area | Status | Implemented | Tested | Runtime Verified | Production Verified | Remaining |
|---|---|---|---|---|---|---|
| **Architecture** (frontend/backend split) | VERIFIED | yes | yes — a syntax-tree checker: 7 rules, run only after its self-test catches 39 planted violations | yes — from a fresh clone, the backend alone served `/api/health` and the frontend alone built | no | — |
| **Frontend** (`frontend/`, 17 screens) | VERIFIED | yes | 34 unit + 7 E2E | yes — real browser vs real API | no | Long-form video progress UI is basic |
| **Backend** (`backend/`, 54 routes) | VERIFIED | yes | 91 in `backend/src` | yes — live boots, live curl | no | — |
| **API contract** | VERIFIED | yes | yes — `docs/API.md` is generated from the routes, and `api-contract.test.ts` checks every row against a real request (anonymous, viewer, rate limit) | yes | no | No OpenAPI document |
| **Authentication** | VERIFIED | yes | 65 in `security` + route tests | yes — 401/403/404 live | no | No password reset, email verification, MFA or SSO |
| **RBAC / authorization** | VERIFIED | yes | yes | yes — 404 cross-tenant live | no | Per-project tool/MCP policy (ADR-089/097 are the narrow fixes) |
| **Deny-by-default auth** | VERIFIED | yes | 4 tests | yes | no | — |
| **Account + data deletion** (NFR-008) | VERIFIED | yes | 14 service + 9 route — decided per project; workspaces removed, queued jobs cancelled, audit rows scrubbed | yes — live, incl. file on disk (before ADR-109; its fixes are test-proven) | no | No operator-initiated deletion, no export-before-delete; a job already running at deletion cannot be stopped (the asset stores remove its bytes) |
| **Database** (22 tables, 45 indexes) | VERIFIED | yes | yes | yes — real Postgres + pgvector | no | — |
| **Migrations** | VERIFIED | yes | 3 checks | yes — clean empty DB, no drift | no | — |
| **Tenant isolation** | VERIFIED | yes | yes | yes — data, files, workspaces, search | no | — |
| **AI runtime** | VERIFIED | yes | yes | yes — real qwen2.5 via Ollama | no | — |
| **LLM providers** (5 adapters: 3 hosted, 1 self-hosted, 1 mock) | PARTIAL | yes | 60 fixture tests | self-hosted only | no | **BLOCKED_EXTERNAL:** no hosted credentials |
| **Embeddings** | VERIFIED | yes | yes | yes — real nomic-embed-text, 768d | no | — |
| **Agent engine** | VERIFIED | yes | 52 tests | yes — real model, real tool calls | no | — |
| **Tool calling** (11 native tools) | VERIFIED | yes | 114 in `tools` (+1 skipped on Windows) | yes — real `tool_calls` from a real model | no | — |
| **Coding agent** | IN_PROGRESS | yes | yes | partial | no | Full FAIL→patch→PASS cycle not driven by a real model; limited by the local model, not the platform |
| **Web retrieval** (`web.fetch`) | VERIFIED | yes | 42 tests | yes — real public URLs fetched, SSRF refused (before ADR-108; its fixes are test-proven) | no | **Web SEARCH not built** (needs a provider's credentials); egress is an exfiltration channel for a prompt-injected agent — set `WEB_FETCH_ALLOWLIST`; egress is not metered |
| **Conversation summarization** (FR-030) | VERIFIED | yes | 15 window + 1 route + 2 client | yes — real model, fact recalled through the summary (before ADR-110; its fixes are test-proven) | no | Threshold is per-deployment config, not per-model automatic |
| **Sandbox** (process) | VERIFIED | yes | 8 sandbox + 114 in `tools` | yes — real subprocesses | no | — |
| **Sandbox** (Docker) | BLOCKED_EXTERNAL | yes | 9 unit: `dockerRunArgs` flags, mount, environment and containment, and provider selection. The 4-test real-container suite (`npm run test:docker`) is written and has never run | **no** | no | **No Docker CLI/service/WSL, no admin rights** — `npm run test:docker` fails here by design |
| **Memory** | VERIFIED | yes | 32 in `memory` (15 of them the conversation window) | yes — **changed a real model's answer** | no | — |
| **RAG** | VERIFIED | yes | 47 tests | yes — real retrieval + citation | no | CSV/code-aware chunking; no OCR |
| **Grounding** | VERIFIED | yes | 10 tests | yes — refuses where it once fabricated | no | — |
| **Files / uploads** | VERIFIED | yes | yes | yes | no | — |
| **Malware scanning** | VERIFIED | yes | 7 tests | yes — real clamd, real EICAR | no | — |
| **Image generation** | PARTIAL | yes | 12 tests | mock pipeline only | no | **BLOCKED_EXTERNAL:** no image credentials |
| **Video generation** | PARTIAL | yes (Replicate) | 31 tests | mock pipeline only | no | **BLOCKED_EXTERNAL:** no Replicate token |
| **Long-form video** | VERIFIED | yes | 26 tests | yes — **h264+aac+mov_text MP4 via API** | no | Scene clips still from the mock provider. Where no synthesiser exists (CI's Linux runner) the composition suite uses a deterministic PCM tone, not speech — 3/3 here on SAPI and 3/3 on the forced tone (ADR-111) |
| **Speech / narration** | PARTIAL | yes | yes | yes — real SAPI synthesis | no | SAPI remains the only offline path and is Windows-only; Linux needs an HTTP provider. The tone the composition suite uses there is a test fixture, not narration |
| **Subtitles** | VERIFIED | yes | 7 tests (the renderer had none) | yes — ffprobe-measured timings | no | — |
| **MCP** | VERIFIED | yes | 39 tests | yes — 14 tools, 0 enabled by default | no | — |
| **Queues / jobs** | VERIFIED | yes | 18 tests (incl. cancelling a deleted project's queued jobs) | yes — real pg-boss, DLQ + replay | no | — |
| **Rate limiting** | VERIFIED | yes | 10 store + 3 `TRUST_PROXY_HOPS` | yes — 201,201,201,429,429 | no | Fail-open is deliberate & documented. Per-IP limits key on `request.ip`, which trusts exactly `TRUST_PROXY_HOPS` proxies (default 0, the socket's address); Terraform's 1 for Cloud Run is unverified against a live service |
| **Quotas** | VERIFIED | yes | 11 tests | yes — real 429s | no | — |
| **Usage / cost** | VERIFIED | yes | yes | yes — idempotent, attributed | no | — |
| **Observability: logs** | VERIFIED | yes | yes | yes | no | — |
| **Observability: traces** | VERIFIED | yes | in `observability`'s 26 | yes — real 3-level span tree | no | — |
| **Observability: metrics** | VERIFIED | yes | in `observability`'s 26 | yes — real Prometheus exposition | no | — |
| **Security** | VERIFIED | yes | yes | yes — 32 defects found & fixed | no | See § below |
| **Admin / operations** | VERIFIED | yes | 4 bootstrap + 3 no implicit tenant access (ADR-108) | yes — **admin 200, ordinary user 404** | no | The administrator role gates `/api/v1/admin/*` and tool/MCP controls only; membership is the only way into a project. No user/project administration UI; two replicas booting at once with DIFFERENT bootstrap emails could both create an admin |
| **Docker** | BLOCKED_EXTERNAL | yes | no | **no** | no | `docker build` has never run |
| **Terraform** | IMPLEMENTED | yes | fmt+validate | validate only | no | `terraform apply` needs a GCP project; `TRUST_PROXY_HOPS=1` for Cloud Run is unverified |
| **CI/CD** | IMPLEMENTED | yes | n/a | **partly** — `npm ci` proven on a fresh clone; workflow never executed | no | **BLOCKED_EXTERNAL:** no git remote |
| **Documentation** | VERIFIED | yes | `docs/API.md` checked against real requests by `api-contract.test.ts`; prose has no gate | yes — reconciled against source by hand, which the third audit showed was not enough: 12 of its 43 findings were documentation-only corrections | no | Prose claims are checked by hand only |
| **Testing** | VERIFIED | 705 passed / 86 files | 1 skipped on Windows; CI expects 0 but has never executed | yes | no | — |

---

## Completion

**CODE COMPLETION: 92%** — 36 of the 39 capability rows in `docs/29_FEATURE_MATRIX.md` are
DONE, MVP DONE or MOCKED (a real implementation behind a real interface, awaiting only
credentials). That denominator is chosen because it is reproducible: anyone can recount it from
that file. The three that are not are **Coding Agent** (the loop, tools and verification are real
and the limit is the local model's capability — see below), **Cloud deployment** (written and
validated, never applied), and **Extensible architecture**, which is a property rather than a
deliverable and will read IN PROGRESS for as long as the project is alive.

Four of those rows only became honest in the previous phase (`78a0e13..74c7cd0`): NFR-008 account
deletion and FR-011 web retrieval did not exist at all, FR-030 summarization was dead columns, and
the administrator role could not be granted by any code path. The version of this file that
preceded that phase scored 96% **while omitting all four from its own accounting** — which is the specific way a
completion score goes wrong: not by miscounting what it lists, but by not listing something.

None of the three scores moved at `fd5f5a5`. The third audit's phase corrected defects and added no
capability row, and the eight rows below that are not Runtime Verified are the same eight.

Named and deliberately not built: web SEARCH (needs a provider's credentials), per-project tool
and MCP policy (a schema change), CSV/code-aware chunking, OCR for scanned PDFs, a user and
project administration UI, password reset / email verification / MFA / SSO, and a generated
OpenAPI document.

**VERIFICATION: 83%** — 38 of the 46 rows above are Runtime Verified. Counted, not estimated;
the eight that are not are named here in full:

| Row | Why not |
|---|---|
| LLM providers (5 adapters) | The self-hosted OpenAI-compatible adapter is verified end to end against a real local model; the three hosted adapters (OpenAI, Anthropic, Google) have no credentials; `llm-mock` makes no network calls and is never constructed in production |
| Coding agent | The loop and tools run against a real model; a full FAIL→patch→PASS cycle has not completed |
| Sandbox (Docker) | No container runtime in this environment; the real-container suite has never run |
| Image generation | Pipeline verified end to end against `image-mock`, which makes no network calls; the OpenAI image adapter is fixture-tested and has no credentials |
| Video generation | Replicate adapter complete and fixture-tested; no token |
| Docker | `docker build` has never run |
| Terraform | `fmt`, `init` and `validate` pass; `apply` needs a GCP project |
| CI/CD | `npm ci` proven on a fresh clone, and the gate commands pass locally except the Docker steps; the workflow itself has never executed — and until ADR-111 its zero-skip step could never have passed on Linux, which no local Windows run could show |

An earlier draft of this section said 89%. It was wrong — the figure had been estimated rather
than counted, and recounting the column gave 38. It is recorded because a verification score that
drifts upward when nobody checks is the failure this document exists to prevent.

**PRODUCTION VERIFICATION: 0%** — no deployment has occurred. Nothing in this repository has run
in a deployed environment, under real traffic, on real managed Postgres, behind a real load
balancer.

**P0 remaining: 0 known · P1 remaining: 0 known; the re-audit is pending.** The version of this
file this one replaces said "0 · 0" with no qualifier, and the third audit then filed #1, #2, #8,
#9, #10, #16, #17, #23, #24, #25, #31, #33, #35 and #38 as P1 against the tree it described (one
verifier judged #23 a P2). Every one is addressed in ADR-108 to ADR-112, which say how each fix was
proven — except #16, a build step added to a CI job, which cannot be proven until the workflow runs
(blocker 3). The word "known" is there because the audit's "went dry" signal was an artifact: finders
that failed were counted as finding nothing. It has to be re-run with that fixed before anyone can
say no findings remain, and that re-run has not happened.

**And the fixes were audited too.** A second independent audit read only that phase's own diff
and confirmed seven defects: an account deletion that destroyed an invited collaborator's project,
a summarization window that permanently dropped a turn, three IPv6 ranges the new SSRF guard
missed, a boundary check that could not fail for the third time, a test that passed with zero
assertions, an audit record written before the event it described, and a comment claiming a race
guarantee the code did not provide. All seven are fixed, each proven against the old code. That
closing gaps creates new ones is not a reason to stop closing them; it is the reason the fixes
get the same scrutiny as the code they replace.

**And then a third time.** A loop-until-dry adversarial workflow read the same phase's diff
(`78a0e13..74c7cd0`) and produced 43 findings. #1–#30 were each confirmed by two independent
verifiers who tried to refute them (split verdicts on #21 and #22 were judged real). The verifiers
for #31–#43 were lost to a session limit before returning verdicts, so none of those was accepted on
the finder's word: each was verified while fixing it — a measurement (64 KB of `<` took 1.4 s before
the rewrite), a test that fails on the old engine, mutants of each fix, violations planted in the new
checker's self-test, `git merge-base --is-ancestor`, a lint run, a fresh clone. All 43 are addressed:
31 by code with a test or live verification, 12 by documentation-only corrections (#24 and #25 were
also fixed in code); none is disputed. Fixing them introduced four more defects, each caught before
commit: a batch script's stale offsets corrupted `conversation-window.ts` (caught by typecheck), a
guard that could never run (caught by a surviving mutant, removed as unreachable — ADR-110), the
contract test's logout cascade (caught by running it against the old document), and a test that
mistook `node -e 1` for an environment flag.

---

## Gates, and what each one now proves

All commands below were run on `fd5f5a5`, the code commit this file names.

| Gate | Result | What it would catch |
|---|---|---|
| `npm run build` | pass (exit 0) | — |
| `npm run typecheck` | 0 errors (all workspaces) | — |
| `npm run lint` | 0 errors, 5 `no-console` warnings | The five: `database/src/migrate-cli.ts:12` (CLI), `jobs/src/queue.test.ts:145` (test diagnostics), `backend/src/config.ts:300` and `:304` (before the logger exists), `backend/src/index.ts:1223` (fatal startup). The previous version of this file said six |
| `npm test` | **705 passed, 0 failed, 1 skipped, 86 files** | ffmpeg, clamd and fake-gcs-server all present. The one skip is the Windows file-symlink case; it is reported as a skip rather than passed with no assertions. CI's zero-skip step fails the build on any skip — and until ADR-111 that step could never pass on Linux, because the long-form suite always skipped there |
| `scripts/verify-boundary.sh` | 8/8 — self-test + 7 rules | The self-test must catch 39 planted violations and report nothing in 10 clean files before any rule judges the real tree (275 source files parsed); each of 15 rule mutants is killed by it. It replaces checks the third audit defeated with ordinary syntax (ADR-111) |
| `scripts/verify-migrations.sh` | 3/3 | Clean empty DB, no drift. Migration 0002 adds `conversations.summary_fingerprint` |
| `scripts/verify-boot.sh` | 7/7 | Refusal cases assert the REASON, not merely that health never answered |
| `npx playwright test` | 7/7 (28.2 s, servers started fresh) | Servers always started fresh (ADR-105) — a stale one had been silently reused |
| `api-contract.test.ts` (inside `npm test`) | pass — one of `api`'s 15 files | A generator that labels a route wrongly: every row of `docs/API.md` is sent a real request — anonymous (public rows admit it, every other row answers 401), a viewer (403 naming exactly the documented permission), and the `x-ratelimit-limit` applied. Run against the previous document, it fails and names each wrong row |
| `docs/API.md` drift (generator output vs the committed file) | identical | A route changed without regenerating the document. The CI step that runs it is new and, like the rest of the workflow, has never executed |
| Fresh `git clone` → `npm ci`; backend alone `npm run dev`; frontend alone `npm run build` | pass | Clone of `fd5f5a5` with 0 files in `shared/dist`; `npm ci` exit 0 in 43 s; `cd backend && npm run dev` answered `GET /api/health` with `{"status":"ok"}` after its predev build; `cd frontend && npm run build` exit 0 through its prebuild. Before ADR-112 the documented backend command could not start there |
| `terraform fmt -check && validate` | pass ("Success! The configuration is valid.") | Run after the `TRUST_PROXY_HOPS` env addition; says nothing about whether 1 is the right value on Cloud Run |
| `npm run test:docker -w @ai-platform/security` | **fails here, by design** | Docker is not installed and the real-container suite refuses to skip. Before ADR-111 the documented Docker check ran no Docker test and passed on this same machine |

### Test counts, per workspace

From the `npm test` run on `fd5f5a5`. Given per workspace because a per-AREA count is a
judgement about which file belongs to which feature, and this way the numbers are reproducible:

| Workspace | Tests · files | Workspace | Tests · files |
|---|---|---|---|
| `tools` | 114 (+1 skipped) · 9 | `observability` | 26 · 4 |
| `api` (backend/src) | 91 · 15 | `jobs` | 18 · 3 |
| `security` | 65 · 5 | `model-router` | 18 · 2 |
| `agent-core` | 52 · 4 | `llm-openai` | 13 · 1 |
| `rag` | 47 · 9 | `llm-google` / `llm-local` | 12 · 1 / 12 · 1 |
| `mcp` | 39 · 4 | `quota` | 11 · 1 |
| `media` | 39 · 8 | `llm-anthropic` | 11 · 1 |
| `web` (frontend) | 34 · 5 | `image-openai` / `video-mock` | 8 · 1 / 8 · 2 |
| `memory` | 32 · 2 | `scanning` | 7 · 1 |
| `video-replicate` | 31 · 3 | `shared` | 7 · 1 |
| `image-mock` | 4 · 1 | `database` / `embeddings` | 3 · 1 / 3 · 1 |

**705 passed and 1 skipped across 86 files, 0 failed.** Plus 7 Playwright E2E tests, which run
against real servers rather than in a workspace. `security`'s 65 do not include the 4-test
real-container suite, which runs only through `npm run test:docker`.

---

## External blockers

### 1. No container runtime

**BLOCKER:** Docker is unavailable.
**WHY:** No `docker` CLI, no Docker service, no WSL, and the session is **not elevated** — Docker
Desktop needs administrator rights, WSL2 and a reboot. All four checked directly, not assumed.
**WHAT WAS AUTOMATED:** `DockerSandbox` is complete — `--network none`, `--cap-drop ALL`,
`--read-only`, tmpfs `/tmp`, non-root, pid/memory/cpu limits, workspace-only mount, environment
built from scratch. Its arguments are built by a separate function, `dockerRunArgs`, so they can be
tested without Docker. A 4-test real-container suite (no network, no writes outside `/workspace` and
`/tmp`, not root, no parent environment) runs only through `npm run test:docker` and fails rather
than skips when docker is unusable. Both Dockerfiles are written; the CI workflow builds them and
asserts the API image boots. `.dockerignore` was repaired in the previous phase — it still excluded
`apps/*/data/`, which matched nothing after the restructure, so 82 MB of live databases and an 11 GB
local toolchain were in the build context.
**WHAT WAS VERIFIED:** Less than the previous version of this file said. It called flag
construction verified when no test built a `DockerSandbox`, and its documented check
(`SANDBOX_RUNTIME=docker npm test`) ran no Docker test and passed on this machine, which has no
Docker (finding #25). Verified now, by unit test: `dockerRunArgs` — the isolation flags, the
pid/memory/cpu limits, the single workspace mount, environment scrubbing, argument order and the
refusal of a workdir outside the sandbox root (6 tests); provider selection, including the refusal
to downgrade silently when docker is requested and unusable (3 tests). Verified by boot check 5,
which asserts the refusal reason: production refuses process isolation without an explicit opt-in.
Whether those flags contain a process in a real container is **unverified**: `npm run test:docker`
fails here, by design.
**EXACT ACTION REQUIRED:** Install Docker Desktop as administrator, then
`npm run test:docker --workspace=@ai-platform/security`, `docker build -f backend/Dockerfile .`
and `docker build -f frontend/Dockerfile .`

### 2. No hosted-provider credentials

**BLOCKER:** No API keys for OpenAI, Anthropic, Google or Replicate; no search-provider key.
**WHY:** None exist in this environment, and the security rules forbid soliciting them.
**WHAT WAS AUTOMATED:** The three hosted LLM adapters (OpenAI, Anthropic, Google), the OpenAI
image adapter and the Replicate video adapter are complete and make real HTTP calls, with real
error mapping; the LLM adapters stream and cancel for real. The fourth LLM adapter is the
self-hosted OpenAI-compatible one. `llm-mock`, `image-mock` and `video-mock` make no network calls
and are never constructed in production. The previous version of this file said "all five LLM
adapters" made real HTTP calls and called four of them hosted; both were miscounts (#30).
**WHAT WAS VERIFIED:** Fixture-driven tests against recorded wire shapes for each adapter that
makes real HTTP calls, and the **self-hosted** OpenAI-compatible adapter fully end to end against a
real local model — which is what makes "no mandatory hosted vendor" a property rather than a claim.
**EXACT ACTION REQUIRED:** Set the relevant key and re-run; no code change. Web search
additionally needs an adapter written against whichever provider is chosen.

### 3. No git remote

**BLOCKER:** The CI workflow has never executed.
**WHY:** `git remote -v` is empty.
**WHAT WAS AUTOMATED:** A complete workflow — install, typecheck, lint, boundary, `docs/API.md`
drift, migrations, build, tests with the gated binaries installed, E2E, secret scan, dependency
audit, Docker build, Terraform validate. Two of its steps were **broken** and are fixed: the
fake-implementation gate fired on correct code, so the `security` job could never pass, and the
skipped-suite gate matched one of five real skip messages. The third audit found two more that
could never pass: the `security` job ran vitest against packages it never built (ADR-108 added the
build step), and the zero-skip step failed on Linux on every run because the long-form suite always
skipped there (ADR-111 gave that suite a tone provider).
**WHAT WAS VERIFIED:** Less than the previous version of this file said. It said every command the
workflow runs was run locally and passes — but the zero-skip step could not have passed on Linux
until ADR-111, which no run on this Windows machine could show, and the workflow's Docker build and
image-boot steps cannot run here at all (blocker 1). What is true: the gate commands in the table
above pass locally on `fd5f5a5`, and `npm ci` was executed against a genuinely fresh `git clone`
(exit 0), from which the backend alone started and the frontend alone built.
**EXACT ACTION REQUIRED:** `git remote add origin <url> && git push`.

### 4. No GCP project

**BLOCKER:** `terraform apply` cannot run.
**WHAT WAS VERIFIED:** `terraform fmt -check`, `init` and `validate` all pass, including after
`TRUST_PROXY_HOPS` was added. The runbook's two `docker build` commands were repaired in the
previous phase — they still named `apps/api/Dockerfile` and `apps/web/Dockerfile`, so the only
documented way to produce the images Terraform requires failed with "failed to read dockerfile".
**NOT VERIFIED:** Terraform sets `TRUST_PROXY_HOPS=1` for Cloud Run's front end, which appends the
caller's address; an external HTTPS load balancer in front would make it 2. No live service has
confirmed the value, and every per-IP rate limit and audit row depends on it (ADR-112).
**EXACT ACTION REQUIRED:** Authenticate to a project, then `terraform plan`. After the first
deploy, check that the audit row a failed login writes records the caller's real address.

---

## Security posture

Thirty-two defects have been found and fixed across the three audit cycles and the work between
them. The first eighteen were each **demonstrated before being fixed**. The last fourteen come from
the third audit: the ten findings it filed under security (#1–#7, #31, #32, #38), three it filed
elsewhere that are security defects all the same (#10, #27, #33), and #3 counted twice, because its
second half — a caller-chosen address — was fixed at the source for every per-IP limit (ADR-112).
#6 and #14 are one defect seen from two sides. #1–#30 were each confirmed by two independent
verifiers; #31 onward were verified while fixing, as the column says:

| Defect | How it was found |
|---|---|
| Terminal tool leaked every API key to model-authored commands | Probe printed `sk-ant-CANARY-…` |
| Symlink escape — agent read a host file | Probe returned the host file's contents |
| Every tenant's agent shared one workspace | Two project ids, same path |
| MCP bearer token sent in clear to `127.0.0.1.attacker.tld` | Review of the loopback regex |
| Tool enablement: project permission, deployment-wide effect | Route/permission audit |
| RAG answered with a fabricated citation | A **real model** produced it |
| Video provider orphaned billing predictions | Probe: 429 → zero cancel requests |
| Video provider hung past its deadline | Probe: pending at 1502ms vs 50ms |
| RAG query spent tokens with no quota check | Cross-checked every spending path |
| **`fs.search`/`fs.glob` read every tenant's workspace** | Probe: `matchCount: 1` with another tenant's secret |
| **The search walk followed symlinks out of the sandbox** | Junction into a host directory, then searched |
| **RAG ingestion indexed another tenant's file** | `POST /api/v1/files` with `<other-tenant>/secrets.txt` succeeded |
| **MCP reconnect: project permission, process-global effect** | The same audit that found ADR-089's, one route later |
| **No code path could grant `is_system_admin`** | The whole `/admin` surface answered 404 to everyone |
| **The boundary gate's secret check could never fail** | Two real secrets planted in frontend source; still PASS |
| **SSRF guard bypassed by a hex-spelled IPv4-mapped IPv6 address** | A test written to prove the DECIMAL forms were refused |
| **SSRF guard missed SIIT-translated, Teredo and site-local IPv6** | Second audit, probing the reviewed guard for ranges it did not name |
| **Account deletion destroyed an invited collaborator's project** | Second audit: invited a user through the real API, deleted the inviter |
| **One approval let a different destructive tool call skip the gate — adapters reuse call ids such as `call_0` every turn** | Third audit #33, verified while fixing: an engine test that fails on the old code |
| **The system administrator held owner+admin on every tenant's project** | Third audit #38, verified while fixing: tests that the administrator cannot authorize into another tenant's project or create one in its organization |
| **One hostile page froze the API for every tenant — quadratic HTML stripping in `web.fetch`** | Third audit #31, measured: 64 KB of `<` took 1.4 s, about 90 s at the byte cap. 512 KB of hostile input is now asserted under 2 s |
| **Account deletion kept a private project no one could reach** | Third audit #2, reproduced through the real app; service test through `createProject` + `addProjectMember` |
| **Account deletion left every agent-written file on disk, and reported 200** | Third audit #1; route test writes a file, deletes the account, asserts the directory is gone |
| **Audit rows kept the deleted person's email and login IPs** | Third audit #7; test: a failed login from an IP, then deletion — no row keeps the email or the IP |
| **Deletion's password re-check could be brute-forced past the lockout** | Third audit #3: twelve guesses with a rotated `X-Forwarded-For` got twelve 401s and no 429, and a locked account still accepted the right password |
| **`trustProxy: true` let any caller choose its own address for every per-IP limit and audit row** | Traced from #3 to its source (ADR-112); test asserts the recorded address at 0, 1 and 2 hops, and fails when `trustProxy: true` is restored |
| **An API key plus the password could delete the account** | Third audit #27, a documented claim ("requires the session") checked against the route; test: an API key gets 403 and the user is still present |
| **Deletion orphaned in-flight storage objects, and queued jobs for deleted projects still ran** | Third audit #4; asset-store test (row insert fails → bytes removed), route test (queued job → cancelled) |
| **An organization kept for a collaborator outlived that collaborator's own deletion** | Third audit #32, verified while fixing; service test: the last collaborator's deletion removes the organization |
| **`web.fetch` refusals let a prompt-injected model map internal DNS** | Third audit #5; test: private and unresolvable names get the identical message |
| **`web.fetch` had no real deadline, and cancellation never reached the socket** | Third audit #6 and #14; a slow-drip server test rejects at the deadline, and an external abort reaches the request |
| **`web.fetch` kept downloading a redirect body after returning** | Third audit #10: 7 GB in six seconds, measured; test: an endless redirect body is closed |

Still true and deliberate: the rate limiter **fails open** (it is a mitigation, not an
authorization boundary — the malware scanner fails closed, which is the opposite trade for the
opposite reason).

**One security-relevant deferral was closed by building the feature it depended on.** docs/13
deferred SSRF analysis because "no URL-fetching tool exists yet". `web.fetch` (ADR-104) ships
with address validation in both IP families, a socket pinned to the validated address against
DNS rebinding, and per-hop redirect revalidation — verified live by refusing
`169.254.169.254`, `localhost` (via `::1`), `10.0.0.1` and `file://`. The third audit then found
five defects in it, fixed in ADR-108; four are in the table above, the fifth (#15) a truncation
that could end the content in U+FFFD.

---

## How to run

This is an npm-workspaces monorepo: install once, at the repository root. `npm install` inside
`backend/` or `frontend/` installs for the whole root anyway.

```bash
# Once, from the repository root
npm ci

# Backend alone — its predev builds the workspace packages it imports
cd backend && npm run dev

# Frontend alone — dev server, or a production build whose prebuild builds shared
cd frontend && npm run dev
cd frontend && npm run build

# Both, from the root
npm run dev

# Every gate
npm run build && npm run typecheck && npm run lint && npm test
bash scripts/verify-boundary.sh
bash scripts/verify-migrations.sh
bash scripts/verify-boot.sh
python3 scripts/generate-api-docs.py && git diff --exit-code -- docs/API.md
cd frontend && npx playwright test
npm run test:docker --workspace=@ai-platform/security   # needs Docker; fails, not skips, without it
```

From a fresh clone of `fd5f5a5`, the backend's `npm run dev` and the frontend's `npm run build` were
each run alone and work (see Gates). The frontend has no `predev`, so its `npm run dev` on a fresh
clone was not part of that check.
