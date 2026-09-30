# Final production-readiness report

**Current final verification: 2026-09-30.**
- **Branch:** `claude/zen-brahmagupta-6l5o4u`.
- **Final application code:** `14c94f9`, which is the API image every result in §0 ran against
  (CI run 36703750342).
- **Later commits:** they change only the attack script (a Retry-After wait) and documentation.

Sections 1–29 are the 2026-09-28 record. Where §0 gives a newer result, §0 is current.

## 0. Final verification, 2026-09-30 (current)

### Git and GitHub

- **Repository:** `origin` = `https://github.com/zolex12770/Smart-AI-Module`.
- **Where the code was:** all work since the initial commit is on `claude/zen-brahmagupta-6l5o4u`.
  The default branch, `main`, still held only `a8dac11` "Initial commit". That is why GitHub's
  front page showed an old commit.
- **`main` is not updated:** it is behind the delivery branch and 0 commits ahead, so a
  fast-forward loses nothing. It was not pushed from this session: pushing to the default branch
  was refused by this environment's permission policy and is left to the repository owner.
  - **To make GitHub's front page show the final code,** do one of these:
    - fast-forward `main`: `git fetch origin && git push origin
      origin/claude/zen-brahmagupta-6l5o4u:main`, or merge the branch into `main` through a pull
      request;
    - or make `claude/zen-brahmagupta-6l5o4u` the default branch (Settings → Branches).
- **The final code is on GitHub:** the remote delivery branch equals local `HEAD` (checked with
  `git ls-remote`).

### What this pass found and fixed

- **DL-27:** the first cold start after a machine restart showed that the local model adapter was
  bound by Node `fetch`'s 300-second header timeout. The warm-up failed at 303.9 s and Ollama
  cancelled the load. The adapter now sets its own connection timeouts.
  - Before the fix: the warm-up failed at 303.9 s.
  - After the fix: with the load deliberately forced past 300 s (page cache dropped, disk reads
    limited to 12 MiB/s), the warm-up waited 383.1 s and succeeded
    (`evidence/2026-09-30/cold-model-load.md`).
- **DL-28:** two high npm advisories published since the last run (`fast-uri`, `brace-expansion`)
  were fixed by non-breaking updates.
- **The attack script** now waits out a 429 once. Run straight after the acceptance, two checks
  met the rate-limit bucket that the acceptance empties on purpose. The server was not changed.

### Results on the final image (`14c94f9`), all in `evidence/2026-09-30/`

| Suite | Result |
|---|---|
| `npm run verify` | **19 PASS · 0 FAIL · 0 BLOCKED_EXTERNAL**, exit 0 |
| Automated tests | **1284 passed, 0 failed, 2 skipped**: 1003 unit, 276 integration, 5 contract. The 2 skips are the model-file SD suites, which CI runs |
| Playwright | 14/14 |
| Full-system acceptance (real qwen2.5:7b, SDXL, Piper, ffmpeg, Postgres) | **24/24** |
| Attack suite | **11/11**. The first run was 9/11 because of the rate-limit bucket (above), and is kept as `attacks-run1-rate-limited.md` |
| Browser suite (real Chromium) | **11/11**, including video playback through the WebM rendition in a browser without H.264 |
| Failure injection | **5/5**: LLM, DB, worker, media process and MCP server each killed |
| Extra scenarios | 3 PASS · 1 FAIL: IMAGE-REPRODUCIBLE (seed 4242 twice byte-identical, seed 777 different), IMAGE-NEGATIVE and CODING-BAD-PATCH pass; CODING-SECOND fails, a model limitation (below) |
| Cold model load past 300 s | PASS, 383.1 s |

**Media, on the final image:**
- **Image:** SDXL 512×512 PNG, decoded, with measured pixel variety; retrieved through the asset
  route.
- **Audio:** Piper WAV, 4.07 s, RMS 0.149; played in the browser (3.06 s clip).
- **Video:** MP4 with `h264` video, `aac` audio and a `mov_text` subtitle track, 8.0 s. A WebVTT
  track, and a VP9/Opus WebM that the browser decoded.

**Coding agent, final controlled run:**
- **The acceptance task:** COMPLETED in 246.4 s. The audit log shows the complete loop: it ran
  the failing test, read the test, read the correct source file (`sum.js`), made one exact edit
  (`a - b` → `a + b`), and re-ran the test. The independent re-run exited 0, and the test file
  was untouched.
- **The second, unrelated task (`slugify`) failed again. This is a model-quality limitation, not
  a platform bug.** For 30 minutes the model kept patching `slugify.cjs`, a file that does not
  exist, and twice tried to edit the read-only test. Every refusal was correct and named the real
  files ("Files in ".": slugify.js, slugify.test.cjs"). It never read `slugify.js`. The platform
  ended the node at its deadline, reported `FAILED`, and left the test untouched, and the
  independent run agreed. The platform was not weakened to turn that into a success.

### Production

**BLOCKED_EXTERNAL.** On 2026-09-30, this environment's `CLOUDSDK_AUTH_ACCESS_TOKEN` was rejected
by Google (401 `CREDENTIALS_MISSING`). No project, service-account key or `gcloud` exists here.
[PRODUCTION_DEPLOYMENT_BLOCKER.md](PRODUCTION_DEPLOYMENT_BLOCKER.md) names the variables to provide
and the commands to run. Terraform `fmt`, `init` and `validate` pass. `plan` and `apply` were not
run.

### Final matrix (PASS / FAIL / BLOCKED_EXTERNAL / NOT_IMPLEMENTED)

| Capability | Code | Local | E2E | Real Runtime | Production | Status |
|---|---|---|---|---|---|---|
| Auth and sessions | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Multi-tenancy and authorization | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Chat and streaming | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Memory | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| RAG | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Tool calling and agent | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Coding agent: acceptance task | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Coding agent: second, unrelated task | PASS | PASS | PASS | FAIL | BLOCKED_EXTERNAL | FAIL: model-quality limitation (the platform verdict is correct) |
| Image | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Audio | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Video | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| MCP | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Usage, quota, rate limits | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Security | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Resilience | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Observability | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Frontend | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Backend and database | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Docker | PASS | PASS | PASS | PASS | BLOCKED_EXTERNAL | PASS locally; production BLOCKED_EXTERNAL |
| Terraform | PASS | PASS | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | validate PASS; plan/apply BLOCKED_EXTERNAL |
| CI/CD | PASS | PASS | PASS | PASS | NOT_IMPLEMENTED | CI PASS; no CD pipeline, by decision |
| Cloud deployment | PASS | PASS | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL |

---

The state vocabulary is the one in [PROJECT_STATUS.md](PROJECT_STATUS.md):
`NOT_STARTED` → `IN_PROGRESS` → `IMPLEMENTED` → `LOCALLY_VERIFIED` → `E2E_VERIFIED` →
`REAL_RUNTIME_VERIFIED` → `PRODUCTION_VERIFIED`, and `BLOCKED_EXTERNAL`. **No capability is
`PRODUCTION_VERIFIED`:** nothing has been deployed to a cloud.

---

## 1. Executive summary

The platform runs end to end on self-hosted software as a Docker Compose stack: Postgres with
pgvector, Ollama, the API, a separate worker and the web app.
- **AI capabilities** run on a real local model (qwen2.5:7b on 4 CPU cores): chat, streaming,
  memory, RAG, tool calling, the agent and the coding agent.
- **Media** runs on real generators: image with SDXL via stable-diffusion.cpp, speech with Piper,
  and narrated, subtitled video with ffmpeg.

On the final API image (`16d352b`):

- `npm run verify`: **19 PASS, 0 FAIL, 0 BLOCKED_EXTERNAL**, exit 0. Earlier runs failed, and
  each failure was fixed (§22).
- The full-system acceptance: **24/24**.
- The attack suite: **11/11**, twice.
- Browser video playback in a Chromium without H.264: PASS.

On images from earlier in the pass:

- Failure injection: **5/5** (`51a66a5`).
- The full browser suite: **11/11** (`51a66a5`).

CI is green on every code commit.

**Running the platform for real this pass found 16 platform defects that tests had not caught.**
Each is fixed with a test that fails against the previous code (DL-19 to DL-26):

- a video that would not play in a browser without H.264;
- a correct model diff refused by the patch parser;
- a live generation killed at 300 s;
- agent turns never billed when they died mid-stream;
- a cold model load that could never finish after a restart;
- liveness failing during a database outage;
- 500s where 503 and 502 were honest;
- an empty setting that stopped the boot;
- an unhelpful edit-tool error that cost a coding run;
- oversized uploads whose 413 was lost to a TCP reset.

A fresh independent audit of the new code found no P1 (DL-24).

**Not shown:** the coding agent completing a second, unrelated task. It failed in all three runs
(§9). The platform reported every failure honestly, but qwen2.5:7b on CPU did not complete it.
**Blocked:** every production cell needs a GCP project and credentials (§25).

## 2. Commit

| What | Commit |
|---|---|
| API image for the final verify, acceptance, attacks and browser video run | `16d352b` |
| API image for the failure-injection, extra-scenario and full browser runs | `51a66a5` (§24) |
| Web image | `149bd22` (the frontend is unchanged since) |
| Last CI-verified code commit | `16d352b`, CI run 36444462653 |

Code commits this pass, in order (all CI-green):
- `ef08c48`, `9651a83`, `567bc93`, `14123b5`, `10abb12`, `81cedf8`: before this report's runs.
- `149bd22` (DL-19), `77e7e41` (DL-20), `87f1b1b` (DL-21), `70b4229` (DL-22), `51a66a5` (DL-23).
- `f0f3d13` (a test canary), `816674a` (DL-24), `a34ac79` (DL-25), `9f9dc86` (verify's Terraform
  gate), `16d352b` (DL-26).

## 3. Frontend

`frontend/` is a Next.js 16 app, built and run on its own (`cd frontend && npm install && npm run
dev`, port **3000**).
- **Screens:** 18. Chat, tasks, agent and coding runs, Ask (RAG), files, memory, images, audio,
  videos, usage, platform and settings, plus the auth pages.
- **Boundary:** it imports only types from `shared/`. `scripts/verify-boundary.sh` enforces that it
  reaches no database, queue, filesystem or server environment variable (8/8).
- **Tests:** 124 unit tests. 14 Playwright tests against a real API and database.
- **Changes this pass:** the video player offers an MP4 and a WebM source (DL-19). Same-origin
  proxy mode (`NEXT_PUBLIC_API_PROXY_TARGET`) avoids third-party cookies in a cross-site
  deployment.

## 4. Backend

`backend/` is a Fastify 5 API, port **8787**, built and run on its own (`cd backend && npm install
&& npm run dev`).
- **Routes:** 76, all in [API.md](API.md), each requested by the contract test.
- **Roles:** `ROLE=all` for local, `api` and `worker` in compose and Cloud Run.
- **Packages:** 14 workspace packages plus 11 provider adapters.
- **Changes this pass:**
  - Outage handling: liveness never touches the database; an unreachable database answers 503;
    provider failures answer 502 (DL-23).
  - An oversized upload is drained before its 413 is sent, so the answer is not lost to a TCP
    reset (DL-26).
  - A blank setting means unset for every variable (DL-24).
  - Agent partial-turn billing (DL-21).
  - The warm-up's load deadline (DL-22).

## 5. Database

- **Development and tests:** embedded PGlite with pgvector.
- **Compose and production:** Postgres 16 + pgvector via `DATABASE_URL`.
- **Migrations:** 7 (`0000`–`0006`; `0006` adds `render_webm_asset_id`). The DATABASE gate applies
  them to an empty database, re-applies them cleanly, and checks that they match the schema.
- **Queues:** pg-boss, in Postgres.
- **Rate-limit counters:** shared in Postgres.
- **Outage:** failure injection stopped Postgres. The authenticated read answered 503 at once,
  liveness stayed 200, and the API recovered without a restart.

## 6. AI runtime

- **Chat and tools:** Ollama `qwen2.5:7b` (`MODEL_RUNTIME`: `LLM_BASE_URL` + `LLM_MODEL`, or
  auto-detected in development).
- **Embeddings:** `nomic-embed-text` (768-d).
- **Hosted adapters:** OpenAI, Anthropic and Google are fixture-tested only; no key exists here.
- **Changes this pass:**
  - The local adapter's deadline is for silence and re-arms on every chunk. A generation still
    streaming is no longer cut off (Ollama had logged 5m0s).
  - The adapter closes the request when its caller stops reading.
  - The boot warm-up waits up to `LLM_LOAD_TIMEOUT_MS` (20 minutes) for a cold load, because
    Ollama cancels a load whose request gives up.

## 7. Chat

- **Behaviour:** SSE streaming, stored conversations, rename and delete. A rolling summary fits the
  model's real context window. Output is capped by `CHAT_MAX_OUTPUT_TOKENS`, and a request asking
  for more is refused with 400.
- **Billing:** a turn cut off by an error or a cancel is charged an estimate.
- **Evidence:**
  - Acceptance CHAT-STREAM: 34 token events, first at 927 ms.
  - Acceptance CHAT-HISTORY: a word planted two turns earlier was recalled.
  - Browser CHAT-STREAMING: 78 distinct rendered lengths while streaming, through the web app.

## 8. Agent

- **Design:** a persisted task graph with approvals, per-node deadlines, cancellation, crash
  recovery and an execution lease. An autonomous reasoning loop whose harness owns the limits.
- **Billing:** every turn is charged, including one that dies mid-stream (DL-21).
- **Configuration:** the compose stack passes `AGENT_NODE_TIMEOUT_MS` (30 minutes) for a 7B model
  on CPU (DL-20).
- **Evidence:** acceptance MCP (a real MCP tool inside an agent task) and CODING-AGENT.

## 9. Coding agent

`fix_failing_test` runs the real test, reads and edits the source, and re-runs the test. The test
file is read-only to it.

| Scenario | Result | Evidence |
|---|---|---|
| Acceptance CODING-AGENT (`sum.js`) | **PASS** on the final image: COMPLETED in 301 s, independent re-run exit 0, test untouched. PASS in 4 of this pass's 5 acceptance runs (`81cedf8`, `51a66a5`, `a34ac79`, `16d352b`); the failure on `816674a` led to DL-25 (below) | `acceptance-compose-final.md`, `acceptance-compose-816674a.md` |
| CODING-BAD-PATCH (a naive fix is wrong) | **PASS** in runs 2 and 3: the verdict (`FAILED`) agrees with an independent run of the test, and the test is untouched | `extra-scenarios-run3.md` |
| CODING-SECOND (a second, unrelated task: `slugify`) | **FAIL** in all 3 runs | `extra-scenarios-run1-600s-node-budget.md`, `extra-scenarios-run2-partial.log`, `extra-scenarios-run3.md` |

CODING-SECOND is reported as it happened:
- **Run 1** was stopped by the 10-minute node deadline. The fix was the compose node budget
  (DL-20).
- **Run 2** exposed three platform defects (DL-21):
  - the patch parser refused the model's *correct* diff twice;
  - the 300 s total deadline killed a live generation;
  - that turn was never billed.
- **Run 3** had all fixes. The model's first edit replaced the closing `}` with a `return`, which
  broke the file. Every later edit was correctly refused, and the run stopped at 12 turns.

In every run, the platform reported `FAILED` with the reason, never `COMPLETED` over a failing
test.

The acceptance task failed once, on `816674a` (verify run 3). The model had found the fix but sent
the wrong indentation to `code.replace_text` five times, and the tool answered only "not found".
It now quotes the file's own text when only the indentation differs (DL-25). On the final image,
the model's first edit was correct, so the new message was not exercised in a real run; its test
replays the failing call.

## 10. Memory

Facts are extracted from chat turns; an identifier the user did not write is dropped. They are
recalled in new conversations, and can be deleted from the Memory screen.
- **Acceptance:** MEMORY-FORMATION stored "The user's project codename is NIGHTHAWK-384272." A new
  conversation recalled it (MEMORY-RECALL). MEMORY-DELETE left 0 matching items.
- **Browser:** MEMORY-UI.
- **Across tenants:** the TENANT-ISOLATION and TENANT-IDOR probes cover memory rows by project
  scope.

## 11. RAG

PDF, DOCX and text uploads are scanned (clamd, optional), chunked and embedded into pgvector. The
answer is cited, and an unanswerable question is refused.
- **Acceptance:**
  - RAG-ANSWER: "An engineer receives 27 days of paid leave per calendar year. [1]", with the
    handbook excerpt cited.
  - RAG-REFUSAL: the outcome was `refused`, and a refusal is never called grounded.
- **Attack RAG-INJECTION:** an instruction planted in a document was not followed.
- **Failure:** with Ollama stopped, RAG answers 502 (it was 500 before DL-23).

## 12. Image

stable-diffusion.cpp (built from source) runs SDXL base 1.0 (q8_0) in the worker. That is
`MEDIA_RUNTIME` for images; see [MEDIA_SETUP.md](MEDIA_SETUP.md).

| Check | Result |
|---|---|
| Acceptance IMAGE (red apple, 512×512) | PASS on the final image, 360.7 s. PNG decoded: luminance stddev 75.9, 420 distinct colours |
| IMAGE-NEGATIVE | PASS: 5 invalid requests → 400, and no generation was created |
| IMAGE-REPRODUCIBLE (the idempotence check) | PASS: seed 4242 twice → byte-identical (sha256 `f7c2c1b9…`); seed 777 → a different image |
| MEDIA-CRASH (sd-cli killed mid-run) | PASS: settled `failed` with no internals in the message, and not charged |
| Browser IMAGE-UI | PASS: the browser decoded the generated 512×512 image |

## 13. Audio

Piper (`en_US-lessac-low`) is baked into the API image.
- **Acceptance AUDIO (final image):** synthesised in 3 s. A 16 kHz WAV, 4.02 s, RMS 0.147
  (silence would be 0).
- **Browser AUDIO-UI:** the page's `<audio>` loaded and measured it.

## 14. Video

The pipeline has four steps:
1. The model writes the storyboard (a `video.plan` job).
2. Each scene is an SDXL still animated by ffmpeg ("image-motion": **motion, not a video model**),
   with Piper narration.
3. The render muxes an MP4 with H.264 video, AAC audio and a `mov_text` subtitle track.
4. The render also produces a WebVTT file and a **WebM (VP9/Opus) rendition** (DL-19).

- **Acceptance VIDEO (final image):** 518.4 s. 2 narrated scenes. `ffprobe` shows `[video:h264,
  audio:aac, subtitle:mov_text]`, 8.0 s.
- **Browser VIDEO-UI:** the test Chromium has no H.264 support (`canPlayType` returned `""`). It
  chose and decoded the WebM, with the caption track: 8.0 s on `51a66a5`, and 8.4 s on the image
  where DL-24 reordered how render assets are stored. Before DL-19 this check failed.
- **Cancel just before the last ffmpeg step:** nothing is stored (DL-24). Tested with real ffmpeg.

## 15. MCP

stdio and Streamable HTTP clients. Tools register disabled. The bundled filesystem server is
confined to the caller's project workspace.
- **Acceptance MCP:** an agent task read a planted word through the real server, and another
  project's directory was refused.
- **MCP-CRASH:** the killed server was marked `failed` with 0 tools, and reconnect restored its 14
  tools.

## 16. Security

- **Attack suite on the final API: 11/11, in two consecutive runs.** Checks:
  - 72 protected routes return 401 without credentials;
  - CSRF;
  - 6 cross-tenant IDOR probes → 404;
  - API-key scope;
  - path traversal;
  - upload validation;
  - malformed input (413 and 400, no 5xx). On `816674a` this check failed: the 413 for an 8 MiB
    upload was lost to a TCP reset in about 20% of tries. The upload is now drained before the
    413 is sent (DL-26), and 40 of 40 raw-socket tries through the compose port received it;
  - chat overrides;
  - enumeration;
  - response headers;
  - RAG prompt injection.
- **Earlier on compose:** X-Forwarded-For spoofing.
- **`verify` SECURITY:** `npm audit` has no high or critical findings; the secret scan finds all
  594 tracked files clean; no mock serves production.
- **CI:** gitleaks.
- **Sandbox:** the real-container sandbox runs with no network, a read-only root, a non-root user
  and one workspace (4/4).
- **Stated limits** ([SECURITY.md](SECURITY.md)): on Cloud Run the agent sandbox is process
  isolation, there is no SSO or MFA, and `web.fetch` needs an allowlist to stop exfiltration.

## 17. Observability

- **Logs:** structured JSON, with request ids across the API, jobs and providers.
- **Traces:** OpenTelemetry spans, exported to logs; no collector is deployed.
- **Metrics:** Prometheus, from the API and from the worker's own `METRICS_PORT` listener.
- **Acceptance METRICS (final image):** both endpoints were scraped, and every counter was
  non-zero: `http_requests_total` 873, `provider_request_count` 23, `token_usage_total` 23245.

## 18. Docker

- **Images:** `backend/Dockerfile` (API and worker: ffmpeg, Piper and a voice) and
  `frontend/Dockerfile`.
  - Both build in CI.
  - Locally the API image's runtime stage is Ubuntu, because `deb.debian.org` is blocked here.
    The build stage is identical.
- **Compose stack** (with the `docker-compose.sdcpp.yml` overlay): postgres, ollama, api, worker
  and web. Every runtime script in this report ran against it.
- **`verify` DOCKER:** the compose file is valid and the sandbox passes 4/4.

## 19. Terraform

`infrastructure/terraform` defines:
- a Cloud Run API service (internal ingress, 3600 s timeout, `cpu_idle = false`);
- a worker pool;
- a web service with Direct VPC egress;
- Cloud SQL, GCS, Artifact Registry, Secret Manager and a VPC.

`terraform fmt -check`, `init` and `validate` pass, in CI and in `verify` (from a filesystem
provider mirror, because the registry is unreachable here). `plan` and `apply` are
`BLOCKED_EXTERNAL`.

## 20. CI/CD

`.github/workflows/ci.yml` has five jobs:
- **build-and-test:** includes the binary-gated suites, with an assertion that none were skipped.
- **frontend.**
- **e2e:** Playwright.
- **security:** gitleaks, `npm audit`, no-fake-in-production.
- **infrastructure:** the sandbox suite, both image builds, boots in the worker role and against
  real Postgres, and Terraform.

Green runs this pass:

| Commit | CI run |
|---|---|
| `10abb12` | 36385621375 |
| `81cedf8` | 36389714948 |
| `149bd22` | 36394898273 |
| `87f1b1b` | 36400678818 |
| `70b4229` | 36414199421 |
| `51a66a5` | 36420864142 |
| `15ef9b7` (the tree after `f0f3d13`) | 36427828941 |
| `816674a` | 36429962808 |
| `9f9dc86` (after `a34ac79`) | 36436331495 |
| `16d352b` | 36444462653 |

There is no deployment pipeline (CD); deployment is the runbook.

## 21. Cloud

**`BLOCKED_EXTERNAL`.** Nothing is deployed. [PRODUCTION_DEPLOYMENT_BLOCKER.md](PRODUCTION_DEPLOYMENT_BLOCKER.md)
names each missing item (GCP project, credentials, database password, a reachable model runtime),
the exact command it unblocks, and the result each command must produce.

## 22. Test counts

From the final `npm run verify` (API image `16d352b`), which exited 0. Every run, including the
three that failed and what each failure led to, is in `docs/evidence/2026-09-28/verify.md`.

| Gate | Result |
|---|---|
| BUILD | PASS |
| TYPECHECK | PASS, 0 errors |
| LINT | PASS, 0 errors (5 warnings, all `no-console` at boot) |
| UNIT | PASS, **1001 passed, 0 failed, 2 skipped** across 26 workspaces |
| INTEGRATION | PASS, **276 passed**, 0 failed (backend application) |
| API | PASS, 5 contract tests, 76 routes each requested once, no drift |
| SECURITY | PASS: `npm audit` clean at high, 594 tracked files clean, no mock in production |
| E2E | PASS, Playwright 14 |
| DATABASE | PASS, 3/3 |
| BOUNDARY | PASS, 8/8 |
| BOOT | PASS, 8/8 |
| REAL RUNTIME, MEDIA, AGENT, RAG, MEMORY, MCP | PASS (the 24/24 acceptance run) |
| DOCKER | PASS, sandbox 4/4 |
| TERRAFORM | PASS |

Earlier runs failed as follows:
- **Run 1** (`51a66a5`): SECURITY flagged a key-shaped test canary; DOCKER found the sandbox image
  missing after a Docker Hub 429.
- **Run 3** (`816674a`): AGENT failed (DL-25).

**Automated tests: 1282 passed, 0 failed, 2 skipped** (1001 unit + 276 integration + 5 contract).
The 2 skips are the real-model SD image and video suites, which need a model file; CI runs them
with SD-Turbo.

Per workspace:

| Workspace | Tests |
|---|---|
| web | 124 |
| tools | 169 |
| media | 107 |
| agent-core | 101 |
| security | 87 |
| rag | 65 |
| memory | 44 |
| mcp | 39 |
| observability | 31 |
| video-replicate | 31 |
| model-router | 30 |
| jobs | 23 |
| llm-local | 21 |
| quota | 16 |
| llm-openai | 16 |
| llm-google | 15 |
| image-sdcpp | 13 (+1 skipped) |
| llm-anthropic | 13 |
| shared | 11 |
| image-openai | 10 |
| video-motion | 10 (+1 skipped) |
| video-mock | 8 |
| scanning | 7 |
| image-mock | 4 |
| database | 3 |
| embeddings | 3 |

## 23. E2E counts

- **Playwright:** 14 tests in 5 specs, against the real API and database: chat and history, auth
  and cross-tenant isolation, account security, the admin boundary, and the autonomous agent with
  live SSE and approval. 14 passed in `verify` and in CI.
- **Browser acceptance** (`scripts/acceptance/browser.mjs`, a real Chromium driving the compose
  web app with real models): the results are in
  [evidence/2026-09-28/browser-compose-final.md](evidence/2026-09-28/browser-compose-final.md).

**Browser acceptance, full suite: 11/11 PASS** on the `51a66a5` image. Every screen was checked for
console errors and failed requests. VIDEO-UI was run again on the final image: PASS
(`browser-video-final.md`).

| Check | Observed |
|---|---|
| SIGNUP | signed up in the browser and landed on `/chat` |
| CHAT-STREAMING | 78 distinct rendered lengths while streaming; the header names `local (qwen2.5:7b)` |
| CHAT-MULTI-TURN | 4 messages before a reload, 4 after, same URL |
| CHAT-CANCEL | stopped at 12 characters and still 12 three seconds later; Send came back; the next answer arrived |
| MEMORY-UI | "teal-599" filed on `/memory`; a new chat answered "teal-599" |
| RAG-UI | answered "22:00" with the source shown; an unanswerable question was refused |
| IMAGE-UI | the browser decoded the generated 512×512 image; a download link is present |
| AUDIO-UI | the browser loaded the speech: 3.18 s |
| VIDEO-UI | the browser (H.264 support `""`) decoded the WebM rendition: 8.0 s, 640 px, 1 subtitle track, 2 narration players |
| ROUTES | 12 screens, no browser errors, no placeholder text |
| LOGOUT-LOGIN | 4 conversations listed after signing back in |

## 24. Real-runtime evidence

All in [evidence/2026-09-28/](evidence/2026-09-28/):

| Run | Result | File |
|---|---|---|
| Full-system acceptance, final image (`16d352b`) | **24/24** | `acceptance-compose-final.md` |
| Full-system acceptance, earlier images | `51a66a5` 24/24; `816674a` 23/24 (CODING-AGENT, DL-25) | `acceptance-compose-51a66a5.md`, `acceptance-compose-816674a.md` |
| Attacks, final image | **11/11**, run twice | `attacks-compose-final.md` |
| Attacks, earlier images | `51a66a5` 11/11; `816674a` 10/11 (the lost 413, DL-26) | `attacks-compose-51a66a5.md`, `attacks-compose-816674a-413-race.md` |
| Failure injection (`51a66a5`) | run 1: 1/5 (three platform defects, two script defects); run 2: **5/5** | `failure-injection-run1.md`, `failure-injection-run2.md` |
| Extra scenarios (`70b4229`) | run 3: 3 PASS, 1 FAIL (CODING-SECOND, §9) | `extra-scenarios-run*.md` |
| Browser, VIDEO-UI after DL-19 | PASS (WebM decoded) | `browser-video-webm.md` |
| Browser, full suite (`51a66a5`) | **11/11** | `browser-compose-final.md` |
| Browser, VIDEO-UI on the final image | PASS | `browser-video-final.md` |
| `npm run verify` | §22 | `verify.md` |
| Latency | measured, below | `latency-compose-final.md` |

**Latency** (the `51a66a5` stack; 4 CPU cores, 16 GB, no GPU; observations, not targets):

| Measurement (ms) | n | p50 | p95 | max |
|---|---|---|---|---|
| liveness `GET /api/health` | 50 | 2.8 | 4.3 | 6.5 |
| authenticated read `GET /api/v1/conversations` | 30 | 6.2 | 14.9 | 29.5 |
| readiness `GET /api/v1/admin/health` (database + queue) | 20 | 12.3 | 15.4 | 15.4 |
| embedding, one passage (nomic-embed-text) | 10 | 138.5 | 219.5 | 219.5 |
| chat: time to first token | 3 | 3370 | 3911 | 3911 |
| chat: interval between tokens | 154 | 224 | 306 | 391 |

Durations from the final acceptance run:

| Operation | Duration |
|---|---|
| Chat, first token | 755 ms |
| Image (SDXL, 512×512) | 360.7 s |
| Speech (Piper) | 3 s for 4.02 s of audio |
| Video (8 s, 2 narrated scenes) | 518.4 s |
| Coding agent | 301 s |
| RAG answer | 12.8 s |

## 25. Blockers

Only external ones remain:

1. **A GCP project with billing, credentials, a database password and a model runtime reachable
   from Cloud Run.** These gate `terraform plan`/`apply`, the deployment, and every production
   smoke test. They also gate verifying `TRUST_PROXY_HOPS`, internal ingress and the
   one-hour proxy timeout on real Cloud Run. See
   [PRODUCTION_DEPLOYMENT_BLOCKER.md](PRODUCTION_DEPLOYMENT_BLOCKER.md).
2. **Hosted provider credentials** (optional). The OpenAI, Anthropic and Google LLM adapters, the
   OpenAI-compatible images adapter and the Replicate video adapter are fixture-tested but have
   served no real request.

## 26. Limitations

- **A 7B model on 4 CPU cores is slow and sometimes wrong.** It did not complete the second coding
  task (§9). The harness contains the damage: honest verdicts, a read-only test, bounded turns and
  time.
- **Media speed and fidelity:** SDXL at 512 px takes about 6 minutes per image and is
  low-fidelity. Local video is animated stills, not a video model.
- **Cold model load:** the fix is covered by a unit test. The runtime restart after it found the
  model already in the page cache (warmed in 1.4 s), so a cold load after the fix was not observed
  on this machine.
- **Not every runtime run was repeated on the final image.** Failure injection, the full browser
  suite and the latency run are from the `51a66a5` image. The extra scenarios are from `70b4229`.
  What changed after those images (DL-24 to DL-26) was re-verified: by `verify` (19/19, with the
  24/24 acceptance), the attack suite, and browser VIDEO-UI on the final image.
- **One API instance:** the agent's live event bus is in-process (ADR-159).
- **Sandbox on compose and Cloud Run:** agent commands run under process isolation; the Docker
  sandbox needs a Docker socket.
- **No SSO, MFA, password reset or email verification**, by decision.
- **Local Docker images:** built with an Ubuntu runtime stage, and the sandbox image came from
  `mirror.gcr.io`, both because of this network. CI builds the committed Debian Dockerfile.

## 27. Local commands

```bash
# Model runtime (optional in development; required for the real-runtime gates)
ollama pull qwen2.5:7b && ollama pull nomic-embed-text      # OLLAMA_CONTEXT_LENGTH=16384

# Each application on its own
cd backend  && npm install && npm run dev      # BACKEND_PORT 8787, PGlite unless DATABASE_URL
cd frontend && npm install && npm run dev      # FRONTEND_PORT 3000

# The stack
docker compose up -d --build
docker compose -f docker-compose.yml -f docker-compose.sdcpp.yml up -d   # with local image generation

# Every gate
ACCEPT_API_URL=http://127.0.0.1:8787 ACCEPT_ADMIN_EMAIL=… ACCEPT_ADMIN_PASSWORD=… \
ACCEPT_EXTRA_METRICS_URLS=http://127.0.0.1:9464/metrics npm run verify

# Runtime scripts against a running stack
node scripts/acceptance/full-system.mjs
WEB_URL=http://localhost:3000 node scripts/acceptance/browser.mjs
node scripts/acceptance/attacks.mjs
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.sdcpp.yml" node scripts/acceptance/failure-injection.mjs
node scripts/acceptance/extra-scenarios.mjs
node scripts/acceptance/latency.mjs
```

The setup details are in [LOCAL_SETUP.md](LOCAL_SETUP.md) and [MEDIA_SETUP.md](MEDIA_SETUP.md), every
environment variable is in [ENVIRONMENT.md](ENVIRONMENT.md), and known problems are in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## 28. Production commands

[PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md) and
`infrastructure/DEPLOYMENT_RUNBOOK.md` give the full sequence:
1. The Terraform bootstrap apply.
2. Build and push the API image.
3. Apply the API service.
4. Build the web image with `NEXT_PUBLIC_API_PROXY_TARGET=<api url>`.
5. The full apply.
6. Migrations through the Cloud SQL Auth Proxy.
7. Verification through the web URL.

[PRODUCTION_DEPLOYMENT_BLOCKER.md](PRODUCTION_DEPLOYMENT_BLOCKER.md) lists each command with its
expected result. None has been run.

## 29. Final matrix

| Capability | Code | Local | E2E | Real runtime | Production |
|---|---|---|---|---|---|
| Auth | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Invitations and roles | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Multi-tenancy | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Chat | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Streaming | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Tool calling | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Agent | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Coding agent | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED (first task; the second task was not completed, §9) | BLOCKED_EXTERNAL |
| Memory | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| RAG | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Image | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Audio | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Video | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| MCP | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Usage and quota | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Security | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Resilience | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Observability | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Frontend | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Backend | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Docker | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | REAL_RUNTIME_VERIFIED | BLOCKED_EXTERNAL |
| Terraform | IMPLEMENTED | LOCALLY_VERIFIED | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL |
| CI/CD | IMPLEMENTED | LOCALLY_VERIFIED | E2E_VERIFIED | E2E_VERIFIED | BLOCKED_EXTERNAL |
| Cloud deployment | IMPLEMENTED | LOCALLY_VERIFIED | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL | BLOCKED_EXTERNAL |

The evidence, test command, runtime command and known limitations for each row are in
[PROJECT_STATUS.md](PROJECT_STATUS.md).
