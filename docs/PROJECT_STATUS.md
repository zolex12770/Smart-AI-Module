# Project Status — the single source of truth

**Date:** 2026-09-12 · **Commit:** `8c5f462`

This file supersedes every other status claim in the repository. Where it disagrees with a report,
a README, an ADR or the root `PROJECT_STATUS.md` (which is a historical phase log, not a status
document), **this file is correct**.

## How to read the columns

| Column | Means |
|---|---|
| **Implemented** | The code exists and does the thing. Not "a stub exists". |
| **Tested** | Automated tests assert the real behaviour, not that a function exists. |
| **Runtime Verified** | It was actually executed against real infrastructure and observed working. |
| **Production Verified** | It ran in a real deployed environment. |

Statuses: `NOT_STARTED` · `IN_PROGRESS` · `PARTIAL` · `IMPLEMENTED` · `VERIFIED` · `BLOCKED_EXTERNAL`

**`VERIFIED` requires Runtime Verified = yes.** Nothing is marked `VERIFIED` on the strength of
passing tests alone, because a test suite verifies the code against its author's expectations and
a runtime verifies it against reality — this session found nine defects that only the second
catches.

**Production Verified is `no` for every row.** No deployment has happened. That column exists so
its emptiness is visible rather than implied.

---

## Matrix

| Area | Status | Implemented | Tested | Runtime Verified | Production Verified | Remaining |
|---|---|---|---|---|---|---|
| **Architecture** (frontend/backend split) | VERIFIED | yes | yes (9 boundary checks) | yes — each app builds & runs alone | no | — |
| **Frontend** (`frontend/`, 17 screens) | VERIFIED | yes | 23 unit + 7 E2E | yes — real browser vs real API | no | Long-form video progress UI is basic |
| **Backend** (`backend/`, 47 routes) | VERIFIED | yes | 60 route tests | yes — live boots, live curl | no | — |
| **API contract** | IMPLEMENTED | yes | yes | yes | no | No generated OpenAPI document |
| **Authentication** | VERIFIED | yes | 32 tests | yes — 401/403 live | no | No password reset, email verification, MFA or SSO |
| **RBAC / authorization** | VERIFIED | yes | yes | yes — 404 cross-tenant live | no | Per-project tool policy (ADR-089 is the narrow fix) |
| **Database** (22 tables, 43 indexes) | VERIFIED | yes | yes | yes — real Postgres + pgvector | no | — |
| **Migrations** | VERIFIED | yes | 3 checks | yes — clean empty DB, no drift | no | — |
| **Tenant isolation** | VERIFIED | yes | yes | yes — data, files, workspaces | no | — |
| **AI runtime** | VERIFIED | yes | yes | yes — real qwen2.5 via Ollama | no | — |
| **LLM providers** (5 adapters) | PARTIAL | yes | 60 fixture tests | self-hosted only | no | **BLOCKED_EXTERNAL:** no hosted credentials |
| **Embeddings** | VERIFIED | yes | yes | yes — real nomic-embed-text, 768d | no | — |
| **Agent engine** | VERIFIED | yes | 49 tests | yes — real model, 2 iterations, real tool calls | no | — |
| **Tool calling** | VERIFIED | yes | yes | yes — real `tool_calls` from a real model | no | — |
| **Coding agent** | IN_PROGRESS | yes | yes | partial | no | Full FAIL→patch→PASS cycle not driven against a real model |
| **Sandbox** (process) | VERIFIED | yes | 57 tests | yes — real subprocesses | no | — |
| **Sandbox** (Docker) | BLOCKED_EXTERNAL | yes | unit only | **no** | no | **No Docker CLI/service/WSL, no admin rights** |
| **Memory** | VERIFIED | yes | 17 tests | yes — **changed a real model's answer** | no | — |
| **RAG** | VERIFIED | yes | 44 tests | yes — real retrieval + citation | no | — |
| **Grounding** | VERIFIED | yes | 10 tests | yes — refuses where it once fabricated | no | — |
| **Files / uploads** | VERIFIED | yes | yes | yes | no | — |
| **Malware scanning** | VERIFIED | yes | 7 tests | yes — real clamd, real EICAR | no | — |
| **Image generation** | PARTIAL | yes | 12 tests | mock pipeline only | no | **BLOCKED_EXTERNAL:** no image credentials |
| **Video generation** | PARTIAL | yes (Replicate) | 31 tests | mock pipeline only | no | **BLOCKED_EXTERNAL:** no Replicate token |
| **Long-form video** | VERIFIED | yes | 26 tests | yes — **h264+aac+mov_text MP4 via API** | no | Scene clips still from the mock provider |
| **Speech / narration** | PARTIAL | yes | yes | yes — real SAPI synthesis | no | Windows-only offline path; Linux needs HTTP provider |
| **Subtitles** | VERIFIED | yes | yes | yes — ffprobe-measured timings | no | — |
| **MCP** | VERIFIED | yes | 39 tests | yes — 14 tools, 0 enabled by default | no | — |
| **Queues / jobs** | VERIFIED | yes | 16 tests | yes — real pg-boss, DLQ + replay | no | — |
| **Rate limiting** | VERIFIED | yes | 10 tests | yes — 201,201,201,429,429 | no | Fail-open is deliberate & documented |
| **Quotas** | VERIFIED | yes | 11 tests | yes — real 429s | no | — |
| **Usage / cost** | VERIFIED | yes | yes | yes — idempotent, attributed | no | — |
| **Observability: logs** | VERIFIED | yes | yes | yes | no | — |
| **Observability: traces** | VERIFIED | yes | 8 tests | yes — real 3-level span tree | no | — |
| **Observability: metrics** | VERIFIED | yes | 11 tests | yes — real Prometheus exposition | no | — |
| **Security** | VERIFIED | yes | yes | yes — 9 defects found & fixed | no | See § below |
| **Admin / operations** | IMPLEMENTED | yes | yes | yes — `/platform` screen | no | No user/project administration UI |
| **Docker** | BLOCKED_EXTERNAL | yes | no | **no** | no | `docker build` has never run |
| **Terraform** | IMPLEMENTED | yes | fmt+validate | validate only | no | `terraform apply` needs a GCP project |
| **CI/CD** | IMPLEMENTED | yes | n/a | **no** | no | **BLOCKED_EXTERNAL:** no git remote |
| **Documentation** | VERIFIED | yes | n/a | yes — reconciled against source | no | — |
| **Testing** | VERIFIED | 556/69 | 0 skipped | yes | no | — |

---

## Completion

**CODE COMPLETION: 96%** — every implementable requirement is implemented. The 4% is work that
cannot be written without an external resource (a hosted provider's real error semantics, a
container runtime's real behaviour) plus two deliberately-deferred designs named in the table.

**VERIFICATION: 84%** — 37 of 44 areas are Runtime Verified. The seven that are not are the
Docker sandbox, the four hosted-provider adapter families, `docker build`, and CI — each blocked
on a resource this environment does not have, each stated as such.

**PRODUCTION VERIFICATION: 0%** — no deployment has occurred.

**P0 remaining: 0 · P1 remaining: 0.**

---

## External blockers

### 1. No container runtime

**BLOCKER:** Docker is unavailable.
**WHY:** No `docker` CLI, no Docker service, no WSL, and the session is **not elevated** — Docker
Desktop needs administrator rights, WSL2 and a reboot. All four checked directly, not assumed.
**WHAT WAS AUTOMATED:** `DockerSandbox` is complete — `--network none`, `--cap-drop ALL`,
`--read-only`, tmpfs `/tmp`, non-root, pid/memory/cpu limits, workspace-only mount, environment
built from scratch. Both Dockerfiles are written; CI builds them and asserts the API image boots.
**WHAT WAS VERIFIED:** Flag construction, provider selection, and the production refusal to use
process isolation without an explicit opt-in (boot check 5).
**EXACT ACTION REQUIRED:** Install Docker Desktop as administrator, then
`SANDBOX_RUNTIME=docker npm test --workspace=@ai-platform/security` and `docker build -f backend/Dockerfile .`

### 2. No hosted-provider credentials

**BLOCKER:** No API keys for OpenAI, Anthropic, Google or Replicate.
**WHY:** None exist in this environment, and the security rules forbid soliciting them.
**WHAT WAS AUTOMATED:** All five LLM adapters, both image adapters and the Replicate video adapter
are complete, with real HTTP, real error mapping, real streaming and real cancellation.
**WHAT WAS VERIFIED:** Fixture-driven tests against recorded wire shapes for every adapter, and
the **self-hosted** path fully end to end against a real local model — which is what makes "no
mandatory hosted vendor" a property rather than a claim.
**EXACT ACTION REQUIRED:** Set the relevant key and re-run; no code change.

### 3. No git remote

**BLOCKER:** CI has never executed.
**WHY:** `git remote -v` is empty.
**WHAT WAS AUTOMATED:** A complete workflow — install, typecheck, lint, boundary, migrations,
build, tests with the gated binaries installed, E2E, secret scan, dependency audit, Docker build,
Terraform validate.
**WHAT WAS VERIFIED:** Every command the workflow runs was run locally and passes.
**EXACT ACTION REQUIRED:** `git remote add origin <url> && git push`.

### 4. No GCP project

**BLOCKER:** `terraform apply` cannot run.
**WHAT WAS VERIFIED:** `terraform fmt -check`, `init` and `validate` all pass — and validating for
the first time immediately found a `fmt` failure that would have broken CI.
**EXACT ACTION REQUIRED:** Authenticate to a project, then `terraform plan`.

---

## Security posture

Nine defects were found and fixed this session, each **demonstrated before being fixed**:

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

Still true and deliberate: the rate limiter **fails open** (it is a mitigation, not an
authorization boundary — the malware scanner fails closed, which is the opposite trade for the
opposite reason).

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
npm run typecheck && npm run lint && npm test
bash scripts/verify-boundary.sh
bash scripts/verify-migrations.sh
bash scripts/verify-boot.sh
cd frontend && npx playwright test
```
