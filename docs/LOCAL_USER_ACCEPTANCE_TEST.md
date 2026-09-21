# Local user acceptance test

A person sitting at this machine, following these steps, gets these results. Every ACTUAL RESULT
below was produced by running the step against a real stack on 2026-09-18 — real local model, real
diffusion model, real speech synthesiser, real ffmpeg — and copied from the output. Nothing here is
predicted, and where a step could not be run the STATUS says so instead of guessing.

## How this run was set up

```
# One terminal: the model runtime (optional — the platform falls back honestly without it)
.local-tools/ollama/ollama.exe serve

# Another: the API and the workers
cd backend && npm install && npm run dev

# Another: the interface
cd frontend && npm install && npm run dev
```

The run behind this document used `node backend/dist/index.js` (a built artefact rather than
`tsx watch`) on port 8900, with the local tool paths exported from `.local-tools/test-env.sh`, so
that ffmpeg, stable-diffusion.cpp and piper resolved. With none of those set, the platform reports
each one unavailable rather than pretending — that case is UAT-2's second half.

Legend: **PASS** / **FAIL** / **BLOCKED_EXTERNAL** (needs something this machine does not have) /
**NOT_IMPLEMENTED**.

---

### UAT-1 — Create an account and get a working session

| | |
|---|---|
| **ACTION** | `POST /api/v1/auth/signup` with an email, a 12+ character password and a display name. |
| **EXPECTED RESULT** | 201, a session cookie, a CSRF cookie, and a default project created in one transaction. |
| **ACTUAL RESULT** | 201. Response carried `user`, `defaultProjectId` and `csrfToken`; `Set-Cookie` returned both `aip_session` and `aip_csrf`. `GET /api/v1/projects` then listed one project, `0588104a-0afe-47a2-9618-3de4ef7ce32e`. |
| **STATUS** | **PASS** |

### UAT-2 — The platform says what it is really running

| | |
|---|---|
| **ACTION** | `GET /api/v1/providers`. |
| **EXPECTED RESULT** | Each capability names its provider and whether it is a mock. No capability claims to be real when it is not, and none hides a real one. |
| **ACTUAL RESULT** | `chat: [('local','qwen2.5:7b',False), ('mock','mock-1',True)]`; `embeddings: local:nomic-embed-text:latest, semantic: True`; `image: {name: 'stable-diffusion.cpp', isMock: False}`; `video: {name: 'image-motion', isMock: False, technique: 'a generated still (stable-diffusion.cpp) animated by ffmpeg — motion, not a video model'}`; `speech: {name: 'piper', isMock: False}`; `sandbox: {isolation: 'process'}`. With the tool paths NOT set, the same boot logged `ffmpeg could not be executed`, `IMAGE GENERATION IS MOCKED`, `VIDEO GENERATION IS MOCKED` and `no speech provider configured` — all true. |
| **STATUS** | **PASS** |

### UAT-3 — Chat answers from a real local model

| | |
|---|---|
| **ACTION** | `POST /api/v1/chat` with "What is the capital of France? Answer in one short sentence." |
| **EXPECTED RESULT** | A streamed answer from the local model, not a mock, with a real token count. |
| **ACTUAL RESULT** | `'The capital of France is Paris.'` — provider `local`, model `qwen2.5:7b`, usage `{inputTokens: 42, outputTokens: 8}`, 13 s. |
| **STATUS** | **PASS** |

### UAT-4 — Memory stores and lists a fact

| | |
|---|---|
| **ACTION** | `POST /api/v1/memory` with a user-scoped fact, then `GET /api/v1/memory`. |
| **EXPECTED RESULT** | The fact is stored, listed, and its provenance distinguishes what a user typed from what the platform inferred. |
| **ACTUAL RESULT** | 1 item: `Prefers concise answers with no preamble | scope: user | source: user`. Extraction from a finished turn (ADR-141) writes `source: extracted` and is covered by 5 route tests; it was not exercised in this run because it needs a second model call per turn and this run measured latency. |
| **STATUS** | **PASS** |

### UAT-5 — RAG answers from an ingested document, with a citation

| | |
|---|---|
| **ACTION** | Write `harbour.txt` to the workspace, register it with `POST /api/v1/files`, wait for `ready`, then ask `POST /api/v1/rag/query` "When was the Kestrel Lighthouse lamp replaced and what did it save?" |
| **EXPECTED RESULT** | The right answer, grounded, with a citation naming the source document and chunk. |
| **ACTUAL RESULT** | Document reached `ready`. Answer: `'The Kestrel Lighthouse lamp was replaced in 2019 with an LED array, which cut power use by 71 percent. [1]'` — `grounded: true`, `retrievedCount: 1`, `model: qwen2.5:7b`, and `sources: [{marker: "[1]", filename: "harbour.txt", chunkIndex: 0, distance: 0.141}]`. 12 s. |
| **STATUS** | **PASS** |

### UAT-6 — RAG refuses what the corpus cannot answer

| | |
|---|---|
| **ACTION** | `POST /api/v1/rag/query` with "What is the melting point of tungsten carbide?" — nothing in the corpus covers it. |
| **EXPECTED RESULT** | An explicit refusal, not an answer from the model's own knowledge, and no invented citation. |
| **ACTUAL RESULT** | `'The provided documents do not contain the answer to this question.'` with zero sources. |
| **STATUS** | **PASS** |

### UAT-7 — The autonomous agent chooses a tool, runs it, and is verified

| | |
|---|---|
| **ACTION** | `POST /api/v1/agent/tasks` with `taskType: "autonomous"` and the goal "Read the file harbour.txt in the workspace and state in one sentence what year the lighthouse was built." |
| **EXPECTED RESULT** | The MODEL picks the tool (no recipe), the tool really runs, the answer is right, verification runs, and what happened is recorded. |
| **ACTUAL RESULT** | `COMPLETED` in 79 s. Answer: `'The lighthouse, Kestrel Lighthouse, was built in 1873 according to the text in harbour.txt.'` The node's persisted activity held 3 entries: `tool_call fs.read_file {"path":"harbour.txt"}` → `tool_result` carrying the real file text → `verification`. `toolCallCount: 1`, usage `{inputTokens: 2881, outputTokens: 50}`. |
| **STATUS** | **PASS** |

### UAT-8 — Image generation produces a real image

| | |
|---|---|
| **ACTION** | `POST /api/v1/images` with "a stone lighthouse at dawn, watercolour", then fetch the asset. |
| **EXPECTED RESULT** | A real PNG from a real model, not a labelled placeholder. |
| **ACTUAL RESULT** | `succeeded` in 47 s, `providerName: stable-diffusion.cpp`. Asset served as `image/png`, **576,011 bytes**, valid PNG signature, **512 × 512**. |
| **STATUS** | **PASS** |

### UAT-9 — Speech synthesis produces real audio with a measured duration

| | |
|---|---|
| **ACTION** | `POST /api/v1/audio` with a sentence, then fetch the asset and probe it. |
| **EXPECTED RESULT** | A real WAV, and a duration that was measured rather than estimated from the text length. |
| **ACTUAL RESULT** | `succeeded` in 4 s, `providerName: piper`, `voiceName: en_US-lessac-medium.onnx`, `durationSeconds: 3.984853`. Asset served as `audio/wav`, **175,776 bytes**; ffmpeg reports `Duration: 00:00:03.98, pcm_s16le, 22050 Hz, mono` — the stored duration matches the file. |
| **STATUS** | **PASS** |

### UAT-10 — Long-form video renders a real, playable file

| | |
|---|---|
| **ACTION** | `POST /api/v1/videos` ("a lighthouse keeper watches the dawn", 8 s in 4 s scenes), wait for the render, fetch the asset and probe it with ffprobe. |
| **EXPECTED RESULT** | A real MP4 with picture, narration and captions. Never "succeeded because a database row says so". |
| **ACTUAL RESULT** | `POST` returned in 36 s with a storyboard written by the real model (`scriptSource: model`, `model: qwen2.5:7b`, `scenesWritten: 2 of 2` — no padding). Both scenes `succeeded`; project `succeeded` 35 s later. Asset served as `video/mp4`, **249,579 bytes**. **ffprobe:** `h264 640×360` + `aac` + `mov_text`, `duration=7.916667`. The WebVTT track reads back as the real narration: `Dawn's first light begins to break on the horizon.` / `As dawn fully lights the sky, he readies the night's watch.` |
| **STATUS** | **PASS** |

### UAT-11 — MCP tools are discovered, and disabled until a human decides

| | |
|---|---|
| **ACTION** | `GET /api/v1/tools`, then attempt `POST /api/v1/tools/<mcp id>/enable` as an ordinary project member. |
| **EXPECTED RESULT** | MCP tools are listed and disabled. Enabling is refused for a non-administrator, because the registry is process-wide (ADR-089). |
| **ACTUAL RESULT** | 11 native tools; 14 MCP tools from `reference-filesystem`, **0 enabled**. The enable attempt returned `404 NOT_FOUND` — correct: ADR-089 restricts it to a system administrator and answers 404 rather than 403 so the endpoint's existence is not disclosed. **This run found a real defect in the new interface**: the Tasks screen offered the Enable button to every user, so a project member would have pressed it and received an unexplained "Not found." The button is now shown only to a system administrator, and everyone else is told whose decision it is. A mocked component test could not have caught it. |
| **STATUS** | **PASS** (after the fix this run produced) |

### UAT-12 — Queued work is visible

| | |
|---|---|
| **ACTION** | `GET /api/v1/jobs`. |
| **EXPECTED RESULT** | The real queues, from pg-boss, not a static list. |
| **ACTUAL RESULT** | 6 queues reported: `document.scan`, `document.ingest`, `audio.generate`, `image.generate`, `video.generate_scene`, `video.render` — matching the boot log's `job workers registered`. |
| **STATUS** | **PASS** |

### UAT-13 — Usage is metered against the work that was really done

| | |
|---|---|
| **ACTION** | `GET /api/v1/usage` after the steps above. |
| **EXPECTED RESULT** | Figures that match what this run actually did, per project. |
| **ACTUAL RESULT** | `llm: {tokensToday: 3372, tokensThisMonth: 3372}`, `images: {generatedToday: 1}`, `video: {secondsGeneratedThisMonth: 8}` — one image (UAT-8), eight seconds of video (UAT-10), and the token total spanning UAT-3, UAT-5, UAT-7 and the storyboard. `limits` were all `null`, this deployment having configured none. |
| **STATUS** | **PASS** |

### UAT-14 — Rate limiting really refuses

| | |
|---|---|
| **ACTION** | Repeatedly `POST /api/v1/auth/login` with a wrong password. |
| **EXPECTED RESULT** | 401 while under the limit, then 429 — not unlimited guesses. |
| **ACTUAL RESULT** | Attempts 1–10: `401`. Attempt 11 onward: `429`, for every subsequent attempt. |
| **STATUS** | **PASS** |

### UAT-15 — One tenant cannot reach another's data

| | |
|---|---|
| **ACTION** | Sign up a second account, then call `GET /api/v1/images` and `GET /api/v1/workspace/files` with the second session and the FIRST project's id. |
| **EXPECTED RESULT** | Refused, and reported as absent rather than forbidden — "not yours" and "does not exist" must look the same. |
| **ACTUAL RESULT** | `404` for both. |
| **STATUS** | **PASS** |

### UAT-16 — Every tool call leaves a durable record

| | |
|---|---|
| **ACTION** | After UAT-7, query `audit_log` in the database this run wrote. |
| **EXPECTED RESULT** | A row naming the tool, its arguments and the outcome — not only a metric. |
| **ACTUAL RESULT** | `tool.call | fs.read_file | success | {"outcome":"ok","arguments":{"path":"harbour.txt"},"durationMs":8}` — the tool the model itself chose in UAT-7, with the argument it chose. The table also held `auth.login × 13` and `auth.signup × 3` from this run. There is no HTTP endpoint to read the audit log; it is queried directly. |
| **STATUS** | **PASS** |

### UAT-17 — The coding agent, on a genuinely broken file

| | |
|---|---|
| **ACTION** | Seed `sum.cjs` (`return a - b`) and `sum.test.cjs` (asserts `sum(2,3) === 5`) into the workspace, confirm by hand that the test really fails, then run `taskType: "fix_failing_test"` against it. |
| **EXPECTED RESULT** | The agent runs the test, sees the failure, edits the source, re-runs, and the test passes. |
| **ACTUAL RESULT** | **The cycle did not complete.** Two attempts, each ending `FAILED` at the reasoning node's 600 s ceiling (601 s and 520 s). The MACHINERY worked correctly at every step, which the persisted activity log shows in full (21 entries): the agent ran a command, searched, read both files with `code.read_lines`, applied a patch with `code.apply_patch`, and a verification pass ran. What failed was the local 7B model's judgement, twice over. First, it invoked `terminal.run_command` with `command: "node"` AND `args: ["node", "sum.test.cjs"]` — duplicating the binary — so Node tried to load a module literally named `node`, and the agent never saw the real assertion failure at all. Second, never having seen it, the patch it wrote was a no-op: its own diff removed `module.exports = { sum };` and added the identical line, leaving `return a - b` untouched. `hunksApplied: 1` was therefore *accurate* — the tool applied exactly the hunk it was given. It then tried three times to patch the test file with stale hunks, and the patch tool correctly refused all three rather than corrupting the file. |
| **STATUS** | **FAIL** on 2026-09-18, **PASS** on 2026-09-21 — see the re-run below. |

#### UAT-17 re-run, 2026-09-21 — the cycle completed

Run three times against the same brief, the same `qwen2.5:7b` and the same platform. The third
**COMPLETED in 311 s**, and it is the first time the FAIL → patch → PASS cycle has been observed
end to end:

```
tool_call  terminal.run_command  {"command":"node","args":["sum.test.cjs"],"cwd":"."}
tool_call  code.read_lines       {"path":"sum.cjs","startLine":1,"endLine":5}
tool_call  code.apply_patch      (malformed diff — refused)
tool_call  code.apply_patch      (malformed diff — refused)
tool_call  code.apply_patch      (malformed diff — refused)
tool_call  code.apply_patch      --- a/sum.cjs +++ b/sum.cjs  - return a - b; + return a + b;
verification
tool_call  terminal.run_command  {"command":"node","args":["sum.test.cjs"],"cwd":"."}
```

Checked from outside the platform rather than taken from the agent's report: `sum.cjs` on disk now
reads `return a + b;`, and running `node sum.test.cjs` by hand prints `ok`.

The other two runs failed the same way as the 2026-09-18 one, and differently from each other's
cause: both read and repeatedly tried to patch the **test** file, which the task's goal explicitly
forbids, and never opened the source. Same brief, same model, same platform — **the variance is the
model's**, and the honest reading of three runs is "this works and is not yet reliable" rather than
"this works".

Two things the re-runs found in the platform, both fixed (ADR-162), and neither visible without
running it: a node that exceeded its deadline was recorded as **CANCELLED** — the state a person
pressing Stop produces — with no reason stored anywhere, and the ceiling it exceeded could not be
configured. The successful run took 311 s, which is inside the planner's 600 s, so the raised
`AGENT_NODE_TIMEOUT_MS` is not what made it pass and is not credited with it.

---

## The interface, in a real browser

The Playwright suite drives Chromium against a real API and a real Next.js build: **10 passed**.
It covers signing up, sending a chat message and reading the streamed answer, the redirect to
`/chat/<id>` and reload persistence, tenant isolation through the browser, the usage screen, the
platform screen reporting whether a model is a mock, changing a password and signing back in with
the new one, and starting an autonomous agent task from the Tasks screen.

---

## The fifth audit's own run — 2026-09-21

Everything above was measured on 2026-09-18. The fifth audit re-ran the platform end to end on a
rebuilt tree, with the same real providers — qwen2.5:7b and nomic-embed-text on a local Ollama,
stable-diffusion.cpp with SD-Turbo q8_0, Windows SAPI, ffmpeg 7.1 — on `127.0.0.1:8799`. Two of
the defects fixed in this audit (ADR-161) were found by this run and by nothing else, and the
numbers below are from the run after those fixes.

| # | Check | Measured result | Status |
|---|---|---|---|
| 1 | Sign up, session, default project | 201; `aip_session` + `aip_csrf` set; project created in one transaction | **PASS** |
| 2 | Effective permissions reach the client | `GET /auth/me` returned 16 permissions for the admin role (`project:read`, `files:read`, `memory:read`, `usage:read`, …) — the field ADR-148 added, which the UI's `Can` guard reads | **PASS** |
| 3 | Chat, streamed, from a real model | `local/qwen2.5:7b`, 4 628 ms, 30 token events, 40 in / 31 out | **PASS** |
| 4 | Memory recalled in a NEW conversation | Stored "deploys on Thursdays"; a fresh conversation answered "Thursdays" — retrieval crossing conversations, with ADR-149's `<untrusted_content>` wrapper in place | **PASS** |
| 5 | Document ingested and embedded | `handbook.txt` → `ready`, chunked and embedded by nomic-embed-text (768 dims) | **PASS** |
| 6 | RAG answers with a citation | "An engineer receives 27 days of paid leave per calendar year. [1]" — `grounded: true`, 1 source, cosine distance 0.208, 10 541 ms | **PASS** |
| 7 | RAG refuses what the corpus cannot answer | Submarine-maintenance question → "The provided documents do not contain the answer to this question." | **PASS** |
| 8 | A bare citation is NOT reported as a grounded answer | Before ADR-161 this run produced the literal answer `[1]` with `grounded: true`; now such a reply is `grounded: false, groundingViolation: "citation_without_answer"` (5 route tests) | **PASS** |
| 9 | The autonomous agent chooses a tool and is verified | `COMPLETED`; the model chose `fs.read_file` itself and answered "The on-call rotation starts on Wednesday at 10:00 UTC." | **PASS** |
| 10 | Every tool call leaves a durable record | `audit_log` held the `tool.call` row for `fs.read_file` written by that run | **PASS** |
| 11 | Image generation produces real pixels | stable-diffusion.cpp, 512×512 PNG, 618 910 bytes, **112 382 distinct colours** (decoded to raw RGB and counted — a placeholder cannot pass this), 45 s | **PASS** |
| 12 | Speech synthesis with a measured duration | SAPI, `succeeded`, duration **4.678458 s** measured from the file rather than estimated | **PASS** |
| 13 | Long-form video renders a real, playable file | 2 scenes, ffprobe: `h264` 640×360, 7.92 s | **PASS** |
| 14 | A narrated video carries audio and subtitles | With `VIDEO_SCRIPT_TIMEOUT_MS=90000`: `scriptSource: "model"`, 2 authored shots with narration, both scenes synthesised, ffprobe: **`h264` + `aac` + `mov_text`**, 7.92 s, subtitle and WebVTT assets stored. At the 25 s default the same brief instead logged `script stage failed … "The script stage exceeded its 25s deadline."` and recorded it on the project — before ADR-161 that line reached no logger at all and the project blamed the model's JSON | **PASS** |
| 15 | The coding agent fixes a genuinely broken file | `fix_failing_test` on a `sum.cjs` returning `a - b`: **COMPLETED in 311 s**, the model read the source, the patch tool refused three malformed diffs and applied the fourth, and `node sum.test.cjs` run by hand afterwards prints `ok`. Two earlier runs of the same brief did not get there — the variance is the model's (docs/27) | **PASS** |
| 16 | Streaming and CORS in a REAL browser | Chromium on `http://localhost:3000` against `http://localhost:8799`: 19 token events, first at 225 ms, last at 2 787 ms (**spread 2 607 ms** — progressive, not one chunk), `text/event-stream`, credentialed session works cross-origin, and a header the allow-list does not name is refused by the browser itself. 10/10 | **PASS** |
| 17 | Rate limiting really refuses | Signup: `x-ratelimit-limit: 5`, `x-ratelimit-remaining: 0`, `retry-after: 305`, body `{"error":{"code":"RATE_LIMITED","message":"Rate limit exceeded, retry in 5 minutes."}}`. It survived a process restart, because the store is Postgres-backed rather than per-process | **PASS** |
| 18 | One tenant cannot reach another's data | A second tenant naming the first's project id received **404**, never 403 (ADR-089) | **PASS** |

The scripts behind this table are `accept.mjs` (11 checks), `accept2.mjs` (5) and `browser/drive.mjs`
(10 browser assertions); they sign up through the real API, drive the real routes and read the
resulting bytes back through `GET /api/v1/assets/:id` rather than off the disk.

## What this run did not cover

- **Container images** — `BLOCKED_EXTERNAL`. No Docker on this machine. The API image is built and
  booted by the CI `infrastructure` job; `docker build` has never been executed here.
- **Cloud deployment** — `BLOCKED_EXTERNAL`. `terraform fmt -check` and `terraform validate` pass
  locally; there is no GCP project, so no plan or apply has ever run.
- **CI itself** — `BLOCKED_EXTERNAL`. No git remote, so no workflow run exists. The download URLs,
  archive layouts and binary names its new steps rely on were each verified by hand.
- **Hosted providers** (OpenAI, Anthropic, Google, Replicate) — `BLOCKED_EXTERNAL`. No credentials.
  Their adapters are covered by fixture-based tests against the same SSE parser real traffic uses.
- **Memory extraction end to end** — covered by 5 route tests against a real database; not run in
  this session, which was measuring latency and would have doubled every chat turn's model calls.
