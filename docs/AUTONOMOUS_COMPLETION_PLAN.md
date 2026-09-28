# Autonomous completion plan

The plan the 2026-09-27 and 2026-09-28 completion passes worked to, what they found, and the
checklist they closed against. The checklist uses the state vocabulary of
[PROJECT_STATUS.md](PROJECT_STATUS.md), and every state past `IMPLEMENTED` names its evidence
(files under `docs/evidence/`, a command, or a CI run). The verdicts are in
[FINAL_PRODUCTION_READINESS_REPORT.md](FINAL_PRODUCTION_READINESS_REPORT.md).

## Method

No claim in an earlier report was taken as true. Each capability went through the same loop:
**discover** (run it for real) → **reproduce** (a failing test or a recorded real run) → **fix**
(the smallest change at the root cause) → **test** (the regression test fails without the fix)
→ **verify** (the real run again) → **commit**. Mocks are not evidence. A capability that could
not be exercised only because something outside the platform was missing is
`BLOCKED_EXTERNAL`, with the exact requirement named.

Real runtime used throughout (one machine, 4 CPU cores, 16 GB RAM, no GPU): Ollama with
`qwen2.5:7b` (chat, tools, agent, memory extraction, RAG, storyboards) and `nomic-embed-text`
(768-d embeddings); stable-diffusion.cpp built from source, running SDXL base 1.0 (q8_0); Piper
TTS; ffmpeg/ffprobe; clamd; fake-gcs-server; Docker 29; pgvector/pg16.

## What running it for real found

Each of these was a defect in the platform, found by using it, not by reading it. Each fix has a
regression test that fails without it.

| # | Found | Fix |
|---|---|---|
| 1 | Ollama serves 4096 tokens by default and **silently truncates** a longer prompt from the front: the agent lost its system prompt and task mid-run | The real context window is read from `/api/ps`; prompts are fitted to it, and overflowing is an error, never a truncation; compose sets 16K |
| 2 | `AGENT_NODE_TIMEOUT_MS` was a dead setting; a node was cancelled at 602 s and recorded `cancelled` with no error | One `agentLimits` object; the persisted deadline is enforced and reported as a timeout |
| 3 | `code.apply_patch` overwrote an existing file with a `/dev/null` creation diff, and applied a miscounted hunk that corrupted `sum.js` | Creation onto an existing file is refused; `git apply --recount` semantics with a doubled-marker guard; new `code.replace_text` |
| 4 | The coding agent tried to make the test pass by editing the **test** | The test is read-only to every edit tool, and restored from a snapshot before each test run |
| 5 | The in-loop test run had no project scope and was refused | Scoped to the task's project |
| 6 | A 7B model gave up and described the fix in prose after its edits were refused | The failing verdict states that no edit tool has succeeded, and names `code.replace_text` |
| 7 | A RAG refusal that echoed `[1]` was reported `grounded: true` | Explicit `outcome`: `grounded`, `refused`, `empty` or `violation` (incl. an uncited answer) |
| 8 | A fact stated as a bare token ("NIGHTHAWK-172918") was stored as a memory that could not be recalled | Extraction asks for one sentence naming its subject; bare values are rejected |
| 9 | Mock LLM/image/video providers were registered by default in development | Opt-in only (`ALLOW_MOCK_PROVIDERS=true`), refused in production |
| 10 | Two concurrent SDXL runs beside the 7B model exhausted 16 GB; the OOM killer took both | Providers declare `maxConcurrency`; stable-diffusion.cpp runs one at a time and the scene worker sizes itself from it |
| 11 | The video storyboard ran inside the POST under a 25 s ceiling that a local 7B model never met, so **every** video lost its narration, audio and subtitles | The storyboard is a `video.plan` job with a 180 s deadline |
| 12 | The storyboard model's JSON was intermittently unusable, and the video again rendered silent | JSON mode where the provider has it, plus one corrective retry; both metered |
| 13 | The bundled MCP filesystem server spans every project's workspace: once enabled, one tenant's agent could read another's files | Each path argument is confined to the caller's project workspace |
| 14 | The sandbox's Windows-path check failed on Linux | `win32.basename` |
| 15 | `docs/API.md`'s generator missed `requireSessionCredential` routes | Generator fixed; 403 for an API key verified live |
| 16 | The API image could not write under `/repo/data` (EACCES) | Runtime paths under `/data`, owned by the runtime user |
| 17 | Images could not build behind a TLS-intercepting proxy, or where huggingface.co is blocked | An optional BuildKit `build_ca` secret; an alternative Piper voice URL |
| 18 | stable-diffusion.cpp detected converted SDXL as SD 1.x | `scripts/models/fix-sdxl-gguf-names.py` |
| 19 | `verify-boot.sh` hung on Linux | Portable port probe and process handling |
| 20 | Retrying a video still in `planning` bypassed the video-seconds budget | The full target duration is checked |
| 21 | The model stored "NIGHTHAWK-252597" when told "NIGHTHAWK-252997", and recall answered with the wrong code | A fact whose digit-bearing tokens are not in the user's message is dropped (and logged) |
| 22 | The coding model wrote tool calls as **text** (a stray token where `<tool_call>` belonged) and each was taken as a final answer | Well-formed calls to offered tools are recovered and run through the ordinary, validated, approval-gated path |
| 23 | The model edited `sum.cjs` (the file is `sum.js`); errors were bare ENOENTs with the server's absolute path, and one suggested creating the file | A missing-file error lists the files that exist, relative to the workspace |
| 24 | Diffs with the wrong indentation were reported as "the file has changed since the diff was produced" | The error names the line that is not in the file, what the file has, and says when only indentation differs |
| 25 | **Every standalone-Postgres boot failed**: pg-boss 12 rejects an explicit `backend: undefined` (found by starting the compose stack) | Unset options are omitted; CI now boots the API image against a real `pgvector/pg16` and checks the migrations |
| 26 | With the API and worker split, the worker's metrics (generations, most jobs) were unreachable: it has no listener | `METRICS_PORT`, a metrics-only listener for any role; the acceptance sums counters across processes |
| 27 | A blank numeric setting (`LIMIT: ${LIMIT:-}` in compose) stopped the boot | Blank means unset, as for strings |
| 28 | The chat screen said "mock by default" under a real model's answer; `/api/v1/models` answered 500 when no model was configured | The screen names the configured model (or says none is); the route answers an empty list |
| 29 | The bundled MCP filesystem server would have let one tenant read another's workspace once enabled | (Also #13) confirmed live: the compose MCP check's probe of another project's directory is refused |
| 30 | A rendered video did not play in a browser without H.264/AAC (the test Chromium) | A WebM (VP9/Opus) rendition beside the MP4; the player offers both (DL-19) |
| 31 | The compose stack could not follow the documented 30-minute agent node budget for a 7B model on CPU | Compose passes `AGENT_NODE_TIMEOUT_MS` (DL-20) |
| 32 | The patch parser dropped a blank context line and refused a model's correct diff twice | An empty line inside a hunk is empty context, as `git apply` reads it (DL-21) |
| 33 | A generation still streaming was killed by a 300 s total deadline | The deadline is for silence; the request closes when its caller stops (DL-21) |
| 34 | An agent turn or model call that died mid-stream was never billed | An estimate is charged under a `:partial` key (DL-21) |
| 35 | After a restart, the warm-up abandoned a cold model load; Ollama cancelled it, and the model never became ready | The warm-up has its own load deadline, `LLM_LOAD_TIMEOUT_MS` (DL-22) |
| 36 | With Postgres stopped, liveness answered 500 to a caller with a session cookie | Liveness never looks up a credential (DL-23) |
| 37 | A database outage answered 500; RAG answered 500 with Ollama stopped | 503 `DATABASE_UNAVAILABLE`; the embedding failure is a 502 `ProviderError` (DL-23) |

The acceptance script had its own defects, fixed the same way. It asked for chat history without
sending it, although the API takes history from the client as OpenAI's does. It also read metric
names the platform does not export.

## Checklist

Machine-readable: the JSON block below is the checklist. `state` is the highest state reached; no
item is `PRODUCTION_VERIFIED`. An item left at `IMPLEMENTED` was run and did not pass: its
evidence says why.

```json
{
  "date": "2026-09-28",
  "branch": "claude/zen-brahmagupta-6l5o4u",
  "verified_code_commit": "51a66a5",
  "states": [
    "NOT_STARTED",
    "IN_PROGRESS",
    "IMPLEMENTED",
    "LOCALLY_VERIFIED",
    "E2E_VERIFIED",
    "REAL_RUNTIME_VERIFIED",
    "PRODUCTION_VERIFIED",
    "BLOCKED_EXTERNAL"
  ],
  "items": [
    {
      "id": "structure.frontend_backend_separate",
      "state": "E2E_VERIFIED",
      "evidence": "scripts/verify-boundary.sh 8/8; each app builds and runs alone"
    },
    {
      "id": "gate.build",
      "state": "E2E_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/verify.md BUILD"
    },
    {
      "id": "gate.typecheck",
      "state": "E2E_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/verify.md TYPECHECK, 0 errors"
    },
    {
      "id": "gate.lint",
      "state": "E2E_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/verify.md LINT, 0 errors"
    },
    {
      "id": "gate.unit",
      "state": "LOCALLY_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/verify.md UNIT 996 passed, 2 skipped; CI 36420864142"
    },
    {
      "id": "gate.integration",
      "state": "LOCALLY_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/verify.md INTEGRATION 273 passed"
    },
    {
      "id": "gate.api_contract",
      "state": "LOCALLY_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/verify.md API, 76 routes"
    },
    {
      "id": "gate.security",
      "state": "E2E_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/verify.md SECURITY (run 2 PASS); docs/evidence/2026-09-28/attacks-compose-final.md 11/11"
    },
    {
      "id": "gate.e2e_playwright",
      "state": "E2E_VERIFIED",
      "evidence": "verify E2E 14 passed; CI e2e job"
    },
    {
      "id": "gate.database",
      "state": "E2E_VERIFIED",
      "evidence": "verify DATABASE 3/3; compose on Postgres 16"
    },
    {
      "id": "gate.boot",
      "state": "E2E_VERIFIED",
      "evidence": "verify BOOT 8/8"
    },
    {
      "id": "real.chat_streaming",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/acceptance-compose-final.md CHAT-STREAM; browser CHAT-STREAMING"
    },
    {
      "id": "real.chat_cancel_multiturn_refresh",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/browser-compose-final.md CHAT-CANCEL, CHAT-MULTI-TURN"
    },
    {
      "id": "real.memory",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/acceptance-compose-final.md MEMORY-*; browser MEMORY-UI"
    },
    {
      "id": "real.rag",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/acceptance-compose-final.md RAG-*; browser RAG-UI; attacks RAG-INJECTION"
    },
    {
      "id": "real.coding_agent.first_task",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/acceptance-compose-final.md CODING-AGENT, COMPLETED 246 s"
    },
    {
      "id": "real.coding_agent.bad_patch",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/extra-scenarios-run3.md CODING-BAD-PATCH"
    },
    {
      "id": "real.coding_agent.second_task",
      "state": "IMPLEMENTED",
      "evidence": "docs/evidence/2026-09-28/extra-scenarios-run3.md CODING-SECOND FAIL in all 3 runs (model); reported honestly each time"
    },
    {
      "id": "real.image",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/acceptance-compose-final.md IMAGE (SDXL)"
    },
    {
      "id": "real.image.negative",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/extra-scenarios-run3.md IMAGE-NEGATIVE"
    },
    {
      "id": "real.image.reproducible",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/extra-scenarios-run3.md IMAGE-REPRODUCIBLE"
    },
    {
      "id": "real.audio",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/acceptance-compose-final.md AUDIO; browser AUDIO-UI"
    },
    {
      "id": "real.video",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/acceptance-compose-final.md VIDEO; docs/evidence/2026-09-28/browser-video-webm.md"
    },
    {
      "id": "real.mcp",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/acceptance-compose-final.md MCP; failure-injection-run2.md MCP-CRASH"
    },
    {
      "id": "real.quota_usage",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/acceptance-compose-final.md USAGE, QUOTA"
    },
    {
      "id": "real.tenant_isolation",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/acceptance-compose-final.md TENANT-ISOLATION; attacks TENANT-IDOR"
    },
    {
      "id": "real.metrics",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/acceptance-compose-final.md METRICS"
    },
    {
      "id": "real.failure_injection",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/failure-injection-run2.md 5/5"
    },
    {
      "id": "real.browser_routes",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/browser-compose-final.md ROUTES"
    },
    {
      "id": "performance.measured",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/latency-compose-final.md"
    },
    {
      "id": "docker.images_and_compose",
      "state": "REAL_RUNTIME_VERIFIED",
      "evidence": "verify DOCKER; every runtime script ran against the compose stack"
    },
    {
      "id": "docker.sandbox",
      "state": "E2E_VERIFIED",
      "evidence": "docs/evidence/2026-09-28/verify.md DOCKER run 2, sandbox 4/4"
    },
    {
      "id": "terraform.validate",
      "state": "LOCALLY_VERIFIED",
      "evidence": "verify TERRAFORM; CI infrastructure job"
    },
    {
      "id": "terraform.plan_apply",
      "state": "BLOCKED_EXTERNAL",
      "evidence": "docs/PRODUCTION_DEPLOYMENT_BLOCKER.md: GCP project and credentials"
    },
    {
      "id": "cloud.deployment",
      "state": "BLOCKED_EXTERNAL",
      "evidence": "docs/PRODUCTION_DEPLOYMENT_BLOCKER.md"
    },
    {
      "id": "ci",
      "state": "E2E_VERIFIED",
      "evidence": "ci.yml five jobs green: 36420864142 (51a66a5)"
    },
    {
      "id": "audit.independent",
      "state": "E2E_VERIFIED",
      "evidence": "docs/DECISION_LOG.md DL-18; findings fixed in 81cedf8"
    }
  ]
}
```
