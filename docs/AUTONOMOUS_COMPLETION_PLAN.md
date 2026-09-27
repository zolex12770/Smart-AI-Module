# Autonomous completion plan

The plan the 2026-09-27 completion pass worked to, what it found, and the checklist it closed
against. Statuses use only `PASS`, `FAIL`, `BLOCKED_EXTERNAL` and `NOT_IMPLEMENTED`, and every
`PASS` names its evidence. The verdicts and the full status matrix are in
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

The acceptance script had its own defects, fixed the same way. It asked for chat history without
sending it, although the API takes history from the client as OpenAI's does. It also read metric
names the platform does not export.

## Checklist

Machine-readable: the JSON block below is the checklist. `evidence` names a file, a command or a
CI run.

```json
{
  "date": "2026-09-27",
  "branch": "claude/zen-brahmagupta-6l5o4u",
  "statuses": ["PASS", "FAIL", "BLOCKED_EXTERNAL", "NOT_IMPLEMENTED"],
  "items": [
    { "id": "structure.frontend", "status": "PASS", "evidence": "frontend/ builds and runs alone; scripts/verify-boundary.sh 8/8" },
    { "id": "structure.backend", "status": "PASS", "evidence": "backend/ builds and runs alone; scripts/verify-boundary.sh 8/8" },
    { "id": "startup.backend", "status": "PASS", "evidence": "fresh clone: cd backend && npm install && npm run dev -> GET /api/health 200" },
    { "id": "startup.frontend", "status": "PASS", "evidence": "fresh clone: cd frontend && npm install && npm run dev -> GET /chat 200" },
    { "id": "gate.build", "status": "PASS", "evidence": "npx tsc -b; npm run build (CI build-and-test)" },
    { "id": "gate.typecheck", "status": "PASS", "evidence": "npm run typecheck, 0 errors" },
    { "id": "gate.lint", "status": "PASS", "evidence": "npm run lint, 0 errors" },
    { "id": "gate.tests", "status": "PASS", "evidence": "npm test (docs/TESTING.md)" },
    { "id": "gate.e2e_browser", "status": "PASS", "evidence": "cd frontend && npx playwright test; CI e2e job" },
    { "id": "gate.acceptance", "status": "PASS", "evidence": "docs/evidence/acceptance-compose-2026-09-27.md (23/24; the failure fixed) + acceptance-compose-metrics-rerun-2026-09-27.md (7/7)" },
    { "id": "real.chat_streaming", "status": "PASS", "evidence": "CHAT-STREAM, CHAT-HISTORY with qwen2.5:7b (dev and compose)" },
    { "id": "real.memory", "status": "PASS", "evidence": "MEMORY-FORMATION/RECALL/DELETE (compose); 4/4 memory probes" },
    { "id": "real.rag", "status": "PASS", "evidence": "RAG-INGEST/ANSWER/REFUSAL (dev and compose)" },
    { "id": "real.coding_agent", "status": "PASS", "evidence": "3/3 probes + compose CODING-AGENT; docs/evidence/coding-agent-probes-2026-09-27.log" },
    { "id": "real.image", "status": "PASS", "evidence": "IMAGE, SDXL via stable-diffusion.cpp (dev and compose worker)" },
    { "id": "real.audio", "status": "PASS", "evidence": "AUDIO, Piper (dev and compose)" },
    { "id": "real.video", "status": "PASS", "evidence": "VIDEO: h264+aac+mov_text, model storyboard, narrated (dev run 2 and compose)" },
    { "id": "real.mcp", "status": "PASS", "evidence": "MCP (compose): real MCP server read inside an agent task; cross-project path refused" },
    { "id": "real.quota", "status": "PASS", "evidence": "QUOTA (compose): 429 QUOTA_EXCEEDED, nothing created" },
    { "id": "real.metrics", "status": "PASS", "evidence": "METRICS re-run on compose: API + worker /metrics, all counters non-zero" },
    { "id": "real.tenant_isolation", "status": "PASS", "evidence": "TENANT-ISOLATION (compose): 404, 404, 404" },
    { "id": "performance.measured", "status": "PASS", "evidence": "docs/evidence/latency-compose-2026-09-27.md; timings in the final report" },
    { "id": "docker.images", "status": "PASS", "evidence": "CI infrastructure job builds both images" },
    { "id": "docker.sandbox", "status": "PASS", "evidence": "npm run test:docker -w @ai-platform/security, 4/4" },
    { "id": "docker.compose", "status": "PASS", "evidence": "compose stack up (5 services healthy); acceptance + browser smoke against it" },
    { "id": "docker.real_postgres_boot", "status": "PASS", "evidence": "CI infrastructure job: API image against pgvector/pg16, 23 tables" },
    { "id": "terraform.validate", "status": "PASS", "evidence": "terraform fmt -check, init, validate (CI)" },
    { "id": "terraform.plan_apply", "status": "BLOCKED_EXTERNAL", "evidence": "needs a GCP project and credentials" },
    { "id": "cloud.deployment", "status": "BLOCKED_EXTERNAL", "evidence": "needs a GCP project and credentials" },
    { "id": "ci", "status": "PASS", "evidence": "GitHub Actions ci.yml, all five jobs green" }
  ]
}
```
