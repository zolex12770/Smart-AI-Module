# Project Status — the single source of truth

**Date:** 2026-09-13 · **Commit:** `fa296c6`

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
six of them in code written this phase to close the first audit's gaps. The scores below are lower than the previous version's in places where the previous
version was simply wrong, and the reasoning for each number is stated rather than asserted.

---

## Matrix

| Area | Status | Implemented | Tested | Runtime Verified | Production Verified | Remaining |
|---|---|---|---|---|---|---|
| **Architecture** (frontend/backend split) | VERIFIED | yes | yes (9 boundary checks) | yes — each app builds & runs alone | no | — |
| **Frontend** (`frontend/`, 17 screens) | VERIFIED | yes | 32 unit + 7 E2E | yes — real browser vs real API | no | Long-form video progress UI is basic |
| **Backend** (`backend/`, 54 routes) | VERIFIED | yes | 79 in `backend/src` | yes — live boots, live curl | no | — |
| **API contract** | IMPLEMENTED | yes | yes | yes | no | No generated OpenAPI document |
| **Authentication** | VERIFIED | yes | 46 in `security` + route tests | yes — 401/403/404 live | no | No password reset, email verification, MFA or SSO |
| **RBAC / authorization** | VERIFIED | yes | yes | yes — 404 cross-tenant live | no | Per-project tool/MCP policy (ADR-089/097 are the narrow fixes) |
| **Deny-by-default auth** | VERIFIED | yes | 4 tests | yes | no | — |
| **Account + data deletion** (NFR-008) | VERIFIED | yes | 10 service + 5 route | yes — live, incl. file on disk | no | No operator-initiated deletion, no export-before-delete |
| **Database** (22 tables, 45 indexes) | VERIFIED | yes | yes | yes — real Postgres + pgvector | no | — |
| **Migrations** | VERIFIED | yes | 3 checks | yes — clean empty DB, no drift | no | — |
| **Tenant isolation** | VERIFIED | yes | yes | yes — data, files, workspaces, search | no | — |
| **AI runtime** | VERIFIED | yes | yes | yes — real qwen2.5 via Ollama | no | — |
| **LLM providers** (5 adapters) | PARTIAL | yes | 60 fixture tests | self-hosted only | no | **BLOCKED_EXTERNAL:** no hosted credentials |
| **Embeddings** | VERIFIED | yes | yes | yes — real nomic-embed-text, 768d | no | — |
| **Agent engine** | VERIFIED | yes | 51 tests | yes — real model, real tool calls | no | — |
| **Tool calling** (11 native tools) | VERIFIED | yes | 104 in `tools` (+1 skipped on Windows) | yes — real `tool_calls` from a real model | no | — |
| **Coding agent** | IN_PROGRESS | yes | yes | partial | no | Full FAIL→patch→PASS cycle not driven by a real model; limited by the local model, not the platform |
| **Web retrieval** (`web.fetch`) | VERIFIED | yes | 32 tests | yes — real public URLs fetched, SSRF refused | no | **Web SEARCH not built** (needs a provider's credentials); egress is an exfiltration channel for a prompt-injected agent — set `WEB_FETCH_ALLOWLIST`; egress is not metered |
| **Conversation summarization** (FR-030) | VERIFIED | yes | 10 tests | yes — real model, fact recalled through the summary | no | Threshold is per-deployment config, not per-model automatic |
| **Sandbox** (process) | VERIFIED | yes | 8 sandbox + 104 in `tools` | yes — real subprocesses | no | — |
| **Sandbox** (Docker) | BLOCKED_EXTERNAL | yes | unit only | **no** | no | **No Docker CLI/service/WSL, no admin rights** |
| **Memory** | VERIFIED | yes | 27 tests | yes — **changed a real model's answer** | no | — |
| **RAG** | VERIFIED | yes | 47 tests | yes — real retrieval + citation | no | CSV/code-aware chunking; no OCR |
| **Grounding** | VERIFIED | yes | 10 tests | yes — refuses where it once fabricated | no | — |
| **Files / uploads** | VERIFIED | yes | yes | yes | no | — |
| **Malware scanning** | VERIFIED | yes | 7 tests | yes — real clamd, real EICAR | no | — |
| **Image generation** | PARTIAL | yes | 12 tests | mock pipeline only | no | **BLOCKED_EXTERNAL:** no image credentials |
| **Video generation** | PARTIAL | yes (Replicate) | 31 tests | mock pipeline only | no | **BLOCKED_EXTERNAL:** no Replicate token |
| **Long-form video** | VERIFIED | yes | 26 tests | yes — **h264+aac+mov_text MP4 via API** | no | Scene clips still from the mock provider |
| **Speech / narration** | PARTIAL | yes | yes | yes — real SAPI synthesis | no | Windows-only offline path; Linux needs an HTTP provider |
| **Subtitles** | VERIFIED | yes | 7 tests (the renderer had none) | yes — ffprobe-measured timings | no | — |
| **MCP** | VERIFIED | yes | 39 tests | yes — 14 tools, 0 enabled by default | no | — |
| **Queues / jobs** | VERIFIED | yes | 16 tests | yes — real pg-boss, DLQ + replay | no | — |
| **Rate limiting** | VERIFIED | yes | 10 tests | yes — 201,201,201,429,429 | no | Fail-open is deliberate & documented |
| **Quotas** | VERIFIED | yes | 11 tests | yes — real 429s | no | — |
| **Usage / cost** | VERIFIED | yes | yes | yes — idempotent, attributed | no | — |
| **Observability: logs** | VERIFIED | yes | yes | yes | no | — |
| **Observability: traces** | VERIFIED | yes | in `observability`'s 26 | yes — real 3-level span tree | no | — |
| **Observability: metrics** | VERIFIED | yes | in `observability`'s 26 | yes — real Prometheus exposition | no | — |
| **Security** | VERIFIED | yes | yes | yes — 18 defects found & fixed | no | See § below |
| **Admin / operations** | VERIFIED | yes | 4 tests | yes — **admin 200, ordinary user 404** | no | No user/project administration UI; two replicas booting at once with DIFFERENT bootstrap emails could both create an admin |
| **Docker** | BLOCKED_EXTERNAL | yes | no | **no** | no | `docker build` has never run |
| **Terraform** | IMPLEMENTED | yes | fmt+validate | validate only | no | `terraform apply` needs a GCP project |
| **CI/CD** | IMPLEMENTED | yes | n/a | **partly** — `npm ci` proven on a fresh clone; workflow never executed | no | **BLOCKED_EXTERNAL:** no git remote |
| **Documentation** | VERIFIED | yes | n/a | yes — reconciled against source twice | no | — |
| **Testing** | VERIFIED | 653 passed / 79 files | 1 skipped on Windows, 0 in CI | yes | no | — |

---

## Completion

**CODE COMPLETION: 92%** — 36 of the 39 capability rows in `docs/29_FEATURE_MATRIX.md` are
DONE, MVP DONE or MOCKED (a real implementation behind a real interface, awaiting only
credentials). That denominator is chosen because it is reproducible: anyone can recount it from
that file. The three that are not are **Coding Agent** (the loop, tools and verification are real
and the limit is the local model's capability — see below), **Cloud deployment** (written and
validated, never applied), and **Extensible architecture**, which is a property rather than a
deliverable and will read IN PROGRESS for as long as the project is alive.

Four of those rows only became honest this phase: NFR-008 account deletion and FR-011 web
retrieval did not exist at all, FR-030 summarization was dead columns, and the administrator role
could not be granted by any code path. The previous version of this file scored 96% **while
omitting all four from its own accounting** — which is the specific way a completion score goes
wrong: not by miscounting what it lists, but by not listing something.

Named and deliberately not built: web SEARCH (needs a provider's credentials), per-project tool
and MCP policy (a schema change), CSV/code-aware chunking, OCR for scanned PDFs, a user and
project administration UI, password reset / email verification / MFA / SSO, and a generated
OpenAPI document.

**VERIFICATION: 83%** — 38 of the 46 rows above are Runtime Verified. Counted, not estimated;
the eight that are not are named here in full:

| Row | Why not |
|---|---|
| LLM providers (5 adapters) | Self-hosted path verified end to end; the four hosted adapters have no credentials |
| Coding agent | The loop and tools run against a real model; a full FAIL→patch→PASS cycle has not completed |
| Sandbox (Docker) | No container runtime in this environment |
| Image generation | Pipeline verified end to end against the mock; no image credentials |
| Video generation | Replicate adapter complete and fixture-tested; no token |
| Docker | `docker build` has never run |
| Terraform | `fmt`, `init` and `validate` pass; `apply` needs a GCP project |
| CI/CD | `npm ci` proven on a fresh clone and every step run locally; the workflow itself has never executed |

An earlier draft of this section said 89%. It was wrong — the figure had been estimated rather
than counted, and recounting the column gave 38. It is recorded because a verification score that
drifts upward when nobody checks is the failure this document exists to prevent.

**PRODUCTION VERIFICATION: 0%** — no deployment has occurred. Nothing in this repository has run
in a deployed environment, under real traffic, on real managed Postgres, behind a real load
balancer.

**P0 remaining: 0 · P1 remaining: 0.** Both were also claimed by the previous version of this
file, which was wrong; the difference now is that an independent audit was run against the tree
making the claim, every confirmed gap was fixed, and the gates that would have caught them were
themselves repaired and proven able to fail.

**And the fixes were audited too.** A second independent audit read only this phase's own diff
and confirmed seven defects: an account deletion that destroyed an invited collaborator's project,
a summarization window that permanently dropped a turn, three IPv6 ranges the new SSRF guard
missed, a boundary check that could not fail for the third time, a test that passed with zero
assertions, an audit record written before the event it described, and a comment claiming a race
guarantee the code did not provide. All seven are fixed, each proven against the old code. That
closing gaps creates new ones is not a reason to stop closing them; it is the reason the fixes
get the same scrutiny as the code they replace.

---

## Gates, and what each one now proves

All commands below were run on the commit this file names.

| Gate | Result | What it would catch |
|---|---|---|
| `npm run build` | pass | — |
| `npm run typecheck` | 0 errors | — |
| `npm run lint` | 0 errors, 6 accepted `no-console` warnings | — |
| `npm test` | **653 passed, 0 failed, 1 skipped, 79 files** | ffmpeg, clamd and fake-gcs all present. The one skip is a file-symlink case Windows refuses unelevated; it is reported as a skip rather than passed with no assertions, and CI fails the build on any skip |
| `scripts/verify-boundary.sh` | 9/9 | Every check proven able to FAIL by planting the violation it exists to catch |
| `scripts/verify-migrations.sh` | 3/3 | Clean empty DB, no drift |
| `scripts/verify-boot.sh` | 7/7 | Refusal cases now assert the REASON, not merely that health never answered |
| `npx playwright test` | 7/7 | Servers always started fresh (ADR-105) — a stale one had been silently reused |
| `npm ci` on a fresh clone | pass | CI's install step, executed for the first time |
| `terraform fmt -check && validate` | pass | — |

### Test counts, per workspace

From the `npm test` run on this commit. Given per workspace because a per-AREA count is a
judgement about which file belongs to which feature, and this way the numbers are reproducible:

| Workspace | Tests | Workspace | Tests |
|---|---|---|---|
| `tools` | 104 (+1 skipped) | `observability` | 26 |
| `api` (backend/src) | 79 | `memory` | 27 |
| `agent-core` | 51 | `model-router` | 18 |
| `rag` | 47 | `jobs` | 16 |
| `security` | 46 | `llm-openai` | 13 |
| `mcp` | 39 | `llm-google` / `llm-local` | 12 / 12 |
| `media` | 38 | `quota` | 11 |
| `web` (frontend) | 32 | `llm-anthropic` | 11 |
| `video-replicate` | 31 | `image-openai` / `video-mock` | 8 / 8 |
| `shared` | 7 | `scanning` | 7 |
| `image-mock` | 4 | `database` / `embeddings` | 3 / 3 |

**653 passed and 1 skipped across 79 files, 0 failed.** Plus 7 Playwright E2E tests, which run
against real servers rather than in a workspace.

---

## External blockers

### 1. No container runtime

**BLOCKER:** Docker is unavailable.
**WHY:** No `docker` CLI, no Docker service, no WSL, and the session is **not elevated** — Docker
Desktop needs administrator rights, WSL2 and a reboot. All four checked directly, not assumed.
**WHAT WAS AUTOMATED:** `DockerSandbox` is complete — `--network none`, `--cap-drop ALL`,
`--read-only`, tmpfs `/tmp`, non-root, pid/memory/cpu limits, workspace-only mount, environment
built from scratch. Both Dockerfiles are written; CI builds them and asserts the API image boots.
`.dockerignore` was repaired this phase — it still excluded `apps/*/data/`, which matched nothing
after the restructure, so 82 MB of live databases and an 11 GB local toolchain were in the build
context.
**WHAT WAS VERIFIED:** Flag construction, provider selection, and the production refusal to use
process isolation without an explicit opt-in (boot check 5, which now asserts the refusal reason).
**EXACT ACTION REQUIRED:** Install Docker Desktop as administrator, then
`SANDBOX_RUNTIME=docker npm test --workspace=@ai-platform/security` and
`docker build -f backend/Dockerfile .`

### 2. No hosted-provider credentials

**BLOCKER:** No API keys for OpenAI, Anthropic, Google or Replicate; no search-provider key.
**WHY:** None exist in this environment, and the security rules forbid soliciting them.
**WHAT WAS AUTOMATED:** All five LLM adapters, both image adapters and the Replicate video
adapter are complete, with real HTTP, real error mapping, real streaming and real cancellation.
**WHAT WAS VERIFIED:** Fixture-driven tests against recorded wire shapes for every adapter, and
the **self-hosted** path fully end to end against a real local model — which is what makes "no
mandatory hosted vendor" a property rather than a claim.
**EXACT ACTION REQUIRED:** Set the relevant key and re-run; no code change. Web search
additionally needs an adapter written against whichever provider is chosen.

### 3. No git remote

**BLOCKER:** The CI workflow has never executed.
**WHY:** `git remote -v` is empty.
**WHAT WAS AUTOMATED:** A complete workflow — install, typecheck, lint, boundary, migrations,
build, tests with the gated binaries installed, E2E, secret scan, dependency audit, Docker build,
Terraform validate. Two of its steps were **broken** and are fixed: the fake-implementation gate
fired on correct code, so the `security` job could never pass, and the skipped-suite gate matched
one of five real skip messages.
**WHAT WAS VERIFIED:** Every command the workflow runs was run locally and passes, and `npm ci`
was executed against a genuinely fresh `git clone` for the first time (exit 0).
**EXACT ACTION REQUIRED:** `git remote add origin <url> && git push`.

### 4. No GCP project

**BLOCKER:** `terraform apply` cannot run.
**WHAT WAS VERIFIED:** `terraform fmt -check`, `init` and `validate` all pass. The runbook's two
`docker build` commands were repaired this phase — they still named `apps/api/Dockerfile` and
`apps/web/Dockerfile`, so the only documented way to produce the images Terraform requires failed
with "failed to read dockerfile".
**EXACT ACTION REQUIRED:** Authenticate to a project, then `terraform plan`.

---

## Security posture

Eighteen defects have been found and fixed across the audit cycles, each **demonstrated before
being fixed**:

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

Still true and deliberate: the rate limiter **fails open** (it is a mitigation, not an
authorization boundary — the malware scanner fails closed, which is the opposite trade for the
opposite reason).

**One security-relevant deferral was closed by building the feature it depended on.** docs/13
deferred SSRF analysis because "no URL-fetching tool exists yet". `web.fetch` (ADR-104) ships
with address validation in both IP families, a socket pinned to the validated address against
DNS rebinding, and per-hop redirect revalidation — verified live by refusing
`169.254.169.254`, `localhost` (via `::1`), `10.0.0.1` and `file://`.

---

## How to run

```bash
# Backend
cd backend && npm install && npm run dev

# Frontend
cd frontend && npm install && npm run dev

# Everything, from the root
npm run dev

# Every gate
npm run build && npm run typecheck && npm run lint && npm test
bash scripts/verify-boundary.sh
bash scripts/verify-migrations.sh
bash scripts/verify-boot.sh
cd frontend && npx playwright test
```
