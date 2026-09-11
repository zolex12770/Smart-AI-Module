# Final Implementation Report

**Date:** 2026-09-11 · **Commit:** `3074680` · **Scope:** the autonomous-completion brief

**Status: IMPLEMENTATION COMPLETE — RUNTIME VERIFICATION BLOCKED for two external dependencies
(a container runtime, and hosted-provider credentials).**

Four of the six blockers the previous report listed have been **removed** rather than restated:
ffmpeg, ClamAV, fake-gcs-server, Terraform and a real local LLM runtime are now installed and
exercised (ADR-078). A real model, real embeddings and real speech synthesis serve the platform
end to end. Every environment-gated test now runs — there are **zero skips**.

Section 37 of the brief forbids claiming "implemented", "working", "production ready",
"AI-powered", "memory implemented", "image generation implemented", "video generation
implemented" or "autonomous coding agent" where those are not true. Every claim below names its
evidence; everything else is in [§ What is NOT done](#what-is-not-done).

---

## Headline

| Metric | Original audit | Previous report | Now |
|---|---|---|---|
| Tests passing / files | 189 / 35 | 416 / 50 | **556 / 69** |
| Skipped tests | 0 | 13 | **0** |
| End-to-end (real browser) | 0 | 7 | **7** |
| Boot configurations | 0 | 7/7 | **7/7** |
| Lint | *no linter existed* | *no linter existed* | **0 errors, in CI** |
| Type errors | 0 | 0 | **0** |
| ADRs | 44 | 66 | **87** |
| A real LLM has served a request | **no** | **no** | **yes** |
| Memory changes a real answer | no | asserted on the array | **verified with a real model** |
| Real RAG answer with citations | no | no | **yes** |
| Long-form video: script/audio/subtitles | **none** | **none** | **all three, verified by ffprobe** |
| Real video provider | **none** | **none** | **adapter complete, no credentials** |
| MCP transports | stdio | stdio | **stdio + HTTP/SSE** |
| Metrics | **none** | **none** | **Prometheus, live-verified** |
| Terraform validated | never | never | **yes** |

---

## What was completed, and how it was verified

### The runtime blocker, removed — ADR-078

ffmpeg 7.1, ClamAV 1.4.2, fake-gcs-server 1.56.1, Terraform 1.9.8 and Ollama (with `qwen2.5:1.5b`
and `nomic-embed-text`) installed under a gitignored `.local-tools/`. Consequences: the render
pipeline executed for the first time, Cloud Storage tests ran against a real server, malware tests
detected a real EICAR sample through a real `clamd`, Terraform validated the IaC for the first time
— **immediately finding a `fmt -check` failure that would have broken CI** — and a real model now
serves the platform.

### Real AI runtime — P0

**Verified live:** `POST /api/v1/chat` streamed a real `qwen2.5:1.5b` answer with real token
accounting; the model chose a tool and returned a real `tool_calls` finish reason; `nomic-embed-text`
produced real 768-dimension vectors. The self-hosted OpenAI-compatible path is the default, so no
hosted vendor is a runtime dependency.

### Memory that provably changes an answer — §16

Stored "My production cluster codename is ORION-4"; a later conversation asked the codename and a
real model answered **ORION-4** — a fact it could not otherwise know. Retrieval, ranking, injection
and thread containment all exercised by a real request.

### RAG, and the fabrication it used to produce — ADR-075, ADR-076

`POST /api/v1/rag/query` did not exist: documents could be ingested and never queried. It exists now,
with sources and distances.

**A real model exposed a real defect.** Asked a question with zero retrieved passages, it answered by
citing *"Document 12, titled 'Payments Service Maintenance Procedures'"*. No such document existed.
The prompt already said to use only the given context — **a prompt is a request, not a constraint**,
so the harness now verifies the answer: citing a marker never offered, or answering at all with no
evidence, fails the node. **Verified live:** the same path now replies "The passage does not provide
any information about…".

### The terminal tool was handing models every secret — ADR-077

`createTerminalTools` called `spawn` with no `env`, so Node passed the parent's entire `process.env`
to a child. A command written by a **model** could print `ANTHROPIC_API_KEY` and `DATABASE_URL`.
Demonstrated: `stdout: "sk-ant-CANARY-12345 | postgres://u:p@host/db"`.

The real defect was **two execution paths**: `ExecutionSandbox` already scrubbed, and the tool
registry was wired to the one that did not. There is one now, and no default parameter — a caller
that supplies no sandbox gets a compile error.

### Long-form video: script, storyboard, narration, subtitles — ADR-079/080/081

Previously the entire shot description for every scene was `"Scene 3 of 7: <the prompt>"`, nothing
was narrated, and two schema columns had never been written to.

**Verified end to end through the real HTTP API:** a prompt produced a model-written script titled
*"The Keeper's Call"*, two distinct shots, two narration lines, two synthesised audio assets, and an
MP4 that `ffprobe` reports as `h264` + `aac` + `mov_text`, 8.203s.

Subtitle timings are **measured** from the synthesised audio, not estimated — a words-per-minute
guess drifts until the captions describe a different part of the video.

### A real video provider — ADR-085

A complete Replicate adapter: submission, bounded polling with a hard deadline, real cancellation,
byte download into the asset store, and typed error mapping. 31 tests.

**Review found three defects, two of which spend real money**, all verified before fixing: a
transient poll error orphaned a running prediction (a 429 produced zero cancel requests while the
GPU kept billing, and each retry doubled the orphans); the "hard deadline" bounded no body read, so a
stalled CDN pinned a worker forever; and CDN failures were diagnosed through the API's status table,
telling operators to check a token that is never sent there.

### MCP over HTTP, and a trust boundary — ADR-083

Streamable HTTP with SSE fallback, alongside stdio. **Reconnect had never worked** — `disconnect`
only disabled tools and nothing could unregister one, so rediscovery always collided.

A remote server supplies tool *definitions* and is untrusted: ids may not collide with an existing
tool, discovered tools arrive **disabled**, and both transport and refused ids are reported.
**Verified live: 14 discovered tools, 0 enabled; 8 native tools, 8 enabled.**

Review found two more defects: `isLoopbackHost` used `/^127\./`, so `127.0.0.1.attacker.tld` passed
the guard that refuses plaintext credentials — the bearer token went out in clear; and the SSE
fallback connect was unbounded, pending at 5016ms against a 500ms timeout, which would have hung the
boot.

### Metrics — ADR-082

docs/20 §2.1 specified a full table and none of it existed. Now real, pulled rather than pushed, and
served from the system-admin-only `/api/v1/admin/metrics` — `PrometheusExporter` would have published
token and cost counters on an unauthenticated port.

**Verified live:** `token_usage_total{direction="input"} 32`, `provider_request_count`,
`tool_call_count{status="error"}` from a real model call and a real failed tool call.

An unpriced model records **no** cost rather than zero — the default provider is self-hosted and has
no price, and a zero would read as "free".

### What a final zero-gap audit found — and it was not nothing

An independent multi-agent audit read the finished tree against the requirements with no access
to this session's account of what was built. It confirmed **thirty gaps**, several P0, each
adversarially re-verified before being accepted. The ones that mattered most:

- **A symlink walked straight out of the sandbox** (ADR-088). Path containment was lexical only —
  its own docstring admitted "symlink-free" while docs/13 §11 required otherwise, and
  `packages/security` had been resolving symlinks all along. Two containment implementations, and
  the filesystem tools used the weak one. Proven by probe: `fs.read_file` returned
  `"TOP SECRET HOST FILE CONTENTS"` from outside the workspace.
- **Every tenant's agent shared one workspace** (ADR-090). Project A's agent could read, overwrite,
  delete or *list* project B's files. `projectId` was threaded to the handlers and discarded — the
  one place the `project_id` predicate that IS the authorization model had no equivalent.
- **Tool enablement was a project permission governing a process-global mutation** (ADR-089). Any
  self-registered account could enable an MCP tool for every tenant — defeating the
  disabled-by-default rule that exists because remote MCP servers are untrusted.
- **The coding agent failed 100% of the time.** `fix_failing_test` planned nodes naming two tools
  ADR-062 had deleted, so the planner threw and every such task went straight to FAILED.
- **No asset ever loaded in a browser**, uploads were unauthenticated, and two pages crashed —
  four frontend contract defects (ADR-091).
- **Narration played over the wrong shot** from scene 2 onward: audio was concatenated gapless
  against clips that kept their own lengths, and the subtitle grid was a third timeline again.
- **`POST /api/v1/rag/query` spent tokens with no quota check** — the one hole through FR-063.
- **Five ADRs cited in fifteen places did not exist**, and the "authoritative" feature matrix
  contradicted the code on twelve rows.

Every one is fixed and committed, each with a regression test that reproduces the original
behaviour. That an audit of a tree I had just declared finished found thirty real gaps is the
most useful thing in this report: it is the difference between believing the work is done and
checking.

### A lint gate that can fail — ADR-086

`npm run lint` ran nothing and exited 0; no linter was installed. ESLint 9 with three type-aware
rules now runs in CI. **Proof it can fail:** removing an `await` made it exit 1 on
`no-floating-promises`, a defect `tsc` passes clean.

It immediately found **two dead metrics I had shipped** — `observeQueueDepth` and `recordDeadLetter`
were imported and never called, so `queue_depth` (which docs/20 attaches an alert to) had never been
emitted — and a dead validation schema claiming credit for protection it did not provide.

### Screens for what had none — ADR-084

`/memory` (memory silently shapes answers, so it must be inspectable and deletable), `/ask` (the
ingestion half of RAG had no query UI), and the video screen now shows the script, narration and
audio — stating every time whether a model or the planner wrote the storyboard.

---

## What is NOT done

### Genuinely blocked, verified rather than assumed

| Item | Blocker |
|---|---|
| **Docker sandbox execution** | No Docker CLI, no service, no WSL, and **no administrator rights** to install Docker Desktop — all four checked directly. `DockerSandbox` is unit-tested; no container has run. |
| **Hosted providers serving a request** | No credentials for OpenAI, Anthropic, Google or Replicate. All four adapters are fixture-tested against recorded wire shapes. The **self-hosted** path is fully exercised, which is what the brief's "no mandatory hosted vendor" rule requires. |
| `docker build`, `terraform apply`, CI | No Docker, no GCP project, no git remote. Terraform now **validates**; applying needs a project. |

### Known and deliberate

- **Video cancellation is provider-level only.** `processVideoScene` passes no `AbortSignal` and there
  is no video-cancel route, so in production the cancel endpoint is reached via the deadline and
  error paths. Threading a cancellation token through the job system is a real change to unrelated
  files and is not done.
- **Speech on Linux needs an HTTP provider.** The offline synthesiser is Windows SAPI; a Linux
  deployment configures `SPEECH_PROVIDER=openai` against any compatible server, or renders without
  narration and says so.
- **`/api/v1/providers` reports image/video as bare `available` booleans** with no `isMock` flag, so a
  mocked video reads as "available" there. `/api/v1/models` does carry `isMock`.

---

## Architecture preserved

- **`apps/web` and `apps/api` remain entirely separate applications.** Zero code imports in either
  direction — the only reference is Playwright launching the API as a subprocess. They build, test,
  containerise and deploy independently and communicate only over HTTP.
- The monorepo shape is unchanged: npm workspaces, TypeScript project references. One package was
  added (`video-replicate`), following the existing provider shape exactly.
- No framework was swapped, no data model rewritten, no public contract broken. Every change is
  additive or a corrected defect, each recorded as an ADR.

---

## Honest assessment

The largest change since the last report is not a feature — it is that **claims are now checked
against a running system instead of a test double**. Installing a real model runtime turned four
"blocked" lines into verified ones, and in the process a real model produced a fabricated citation
that no mock would ever have produced. Three of this session's security fixes (the secret leak, the
credential leak, the orphaned billing) were each found by exercising real behaviour rather than by
reading code.

What remains is a container runtime this machine cannot install without administrator rights, and
credentials this environment does not have. Both are named above rather than papered over.

**FINAL STATUS: IMPLEMENTATION COMPLETE — RUNTIME VERIFICATION BLOCKED BY: no container runtime
(Docker), and no hosted-provider credentials.**
