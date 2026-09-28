# Final production-readiness report

**Date:** 2026-09-28 · **Branch:** `claude/zen-brahmagupta-6l5o4u` · **Code verified at:** `51a66a5`
(API image and CI). The later commits change a test fixture and documentation only; the report's
own commit is listed in §2.

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

On the final API image:

- `npm run verify`: **17 PASS, 2 FAIL** on the first run. Both failures were fixed and pass on
  re-run (§22).
- The full-system acceptance: **24/24**.
- The attack suite: **11/11**.
- Failure injection: **5/5**.
- The browser suite: see §23.
- CI is green on every code commit.

**Running the platform for real this pass found 13 platform defects that tests had not caught.**
Each is fixed with a test that fails against the previous code (DL-19 to DL-23):

- a video that would not play in a browser without H.264;
- a correct model diff refused by the patch parser;
- a live generation killed at 300 s;
- agent turns never billed when they died mid-stream;
- a cold model load that could never finish after a restart;
- liveness failing during a database outage;
- 500s where 503 and 502 were honest.

**Not shown:** the coding agent completing a second, unrelated task. It failed in all three runs
(§9). The platform reported every failure honestly, but qwen2.5:7b on CPU did not complete it.
**Blocked:** every production cell needs a GCP project and credentials (§25).

## 2. Commit

| What | Commit |
|---|---|
| API image used for every runtime result in this report | `51a66a5` |
| Web image | `149bd22` (the frontend is unchanged since) |
| Last CI-verified code commit | `51a66a5`, CI run 36420864142 |
| Commits after it | `f0f3d13` (a test canary joined at runtime), then documentation and evidence only |

Code commits this pass, in order (all CI-green):
- `ef08c48`, `9651a83`, `567bc93`, `14123b5`, `10abb12`, `81cedf8`: before this report's runs.
- `149bd22` (DL-19), `77e7e41` (DL-20), `87f1b1b` (DL-21), `70b4229` (DL-22), `51a66a5` (DL-23).

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
| Acceptance CODING-AGENT (`sum.js`) | **PASS**: COMPLETED in 246 s, independent re-run exit 0, test untouched | `acceptance-compose-final.md` |
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
| Acceptance IMAGE (red apple, 512×512) | PASS, 352.8 s. PNG decoded: luminance stddev 75.9, 420 distinct colours |
| IMAGE-NEGATIVE | PASS: 5 invalid requests → 400, and no generation was created |
| IMAGE-REPRODUCIBLE (the idempotence check) | PASS: seed 4242 twice → byte-identical (sha256 `f7c2c1b9…`); seed 777 → a different image |
| MEDIA-CRASH (sd-cli killed mid-run) | PASS: settled `failed` with no internals in the message, and not charged |
| Browser IMAGE-UI | see §23 |

## 13. Audio

Piper (`en_US-lessac-low`) is baked into the API image.
- **Acceptance AUDIO:** a 16 kHz WAV, 4.09 s, RMS 0.142 (silence would be 0).
- **Browser AUDIO-UI:** the page's `<audio>` loaded and measured it.

## 14. Video

The pipeline has four steps:
1. The model writes the storyboard (a `video.plan` job).
2. Each scene is an SDXL still animated by ffmpeg ("image-motion": **motion, not a video model**),
   with Piper narration.
3. The render muxes an MP4 with H.264 video, AAC audio and a `mov_text` subtitle track.
4. The render also produces a WebVTT file and a **WebM (VP9/Opus) rendition** (DL-19).

- **Acceptance VIDEO:** 486.9 s. 2 narrated scenes. `ffprobe` shows `[video:h264, audio:aac,
  subtitle:mov_text]`, 8.0 s.
- **Browser VIDEO-UI:** the test Chromium has no H.264 support (`canPlayType` returned `""`). It
  chose and decoded the WebM: 8.0 s, 640 px, with the caption track. Before DL-19 this check
  failed.

## 15. MCP

stdio and Streamable HTTP clients. Tools register disabled. The bundled filesystem server is
confined to the caller's project workspace.
- **Acceptance MCP:** an agent task read a planted word through the real server, and another
  project's directory was refused.
- **MCP-CRASH:** the killed server was marked `failed` with 0 tools, and reconnect restored its 14
  tools.

## 16. Security

- **Attack suite on the final API: 11/11.** Checks:
  - 72 protected routes return 401 without credentials;
  - CSRF;
  - 6 cross-tenant IDOR probes → 404;
  - API-key scope;
  - path traversal;
  - upload validation;
  - malformed input (413 and 400, no 5xx);
  - chat overrides;
  - enumeration;
  - response headers;
  - RAG prompt injection.
- **Earlier on compose:** X-Forwarded-For spoofing.
- **`verify` SECURITY:** `npm audit` has no high or critical findings; the secret scan finds all
  579 tracked files clean; no mock serves production.
- **CI:** gitleaks.
- **Sandbox:** the real-container sandbox runs with no network, a read-only root, a non-root user
  and one workspace (4/4).
- **Stated limits** ([SECURITY.md](SECURITY.md)): on Cloud Run the agent sandbox is process
  isolation, there is no SSO or MFA, and `web.fetch` needs an allowlist to stop exfiltration.

## 17. Observability

- **Logs:** structured JSON, with request ids across the API, jobs and providers.
- **Traces:** OpenTelemetry spans, exported to logs; no collector is deployed.
- **Metrics:** Prometheus, from the API and from the worker's own `METRICS_PORT` listener.
- **Acceptance METRICS:** both endpoints were scraped, and every counter was non-zero:
  `http_requests_total` 606, `provider_request_count` 25, `token_usage_total` 18966.

## 18. Docker

- **Images:** `backend/Dockerfile` (API and worker: ffmpeg, Piper and a voice) and
  `frontend/Dockerfile`.
  - Both build in CI.
  - Locally the API image's runtime stage is Ubuntu, because `deb.debian.org` is blocked here.
    The build stage is identical.
- **Compose stack** (with the `docker-compose.sdcpp.yml` overlay): postgres, ollama, api, worker
  and web. Every runtime script in this report ran against it.
- **`verify` DOCKER:** the compose file is valid and the sandbox passes 4/4 (on re-run, §22).

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

There is no deployment pipeline (CD); deployment is the runbook.

## 21. Cloud

**`BLOCKED_EXTERNAL`.** Nothing is deployed. [PRODUCTION_DEPLOYMENT_BLOCKER.md](PRODUCTION_DEPLOYMENT_BLOCKER.md)
names each missing item (GCP project, credentials, database password, a reachable model runtime),
the exact command it unblocks, and the result each command must produce.

## 22. Test counts

From `npm run verify` on the final tree (`docs/evidence/2026-09-28/verify.md`):

| Gate | Result |
|---|---|
| BUILD | PASS |
| TYPECHECK | PASS, 0 errors |
| LINT | PASS, 0 errors (5 warnings) |
| UNIT | PASS, **996 passed, 0 failed, 2 skipped** across 26 workspaces |
| INTEGRATION | PASS, **273 passed**, 0 failed (backend application) |
| API | PASS, 5 contract tests, 76 routes each requested once, no drift |
| SECURITY | FAIL on run 1 (a test canary matched the key pattern; fixed in `f0f3d13`), then **PASS** |
| E2E | PASS, Playwright 14 |
| DATABASE | PASS, 3/3 |
| BOUNDARY | PASS, 8/8 |
| BOOT | PASS, 8/8 |
| REAL RUNTIME, MEDIA, AGENT, RAG, MEMORY, MCP | PASS (the 24/24 acceptance run) |
| DOCKER | FAIL on run 1 (the sandbox image was missing and Docker Hub answered 429), then **PASS**, 4/4 |
| TERRAFORM | PASS |

**Automated tests: 1274 passed, 0 failed, 2 skipped** (996 unit + 273 integration + 5 contract).
The 2 skips are the real-model SD image and video suites, which need a model file; CI runs them
with SD-Turbo.

Per workspace:

| Workspace | Tests |
|---|---|
| web | 124 |
| tools | 167 |
| media | 106 |
| agent-core | 101 |
| security | 87 |
| rag | 65 |
| memory | 44 |
| mcp | 39 |
| observability | 31 |
| video-replicate | 31 |
| model-router | 30 |
| jobs | 23 |
| llm-local | 19 |
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

_This run was still in progress at this commit. Its results are added in the next commit._

## 24. Real-runtime evidence

All in [evidence/2026-09-28/](evidence/2026-09-28/):

| Run | Result | File |
|---|---|---|
| Full-system acceptance, final image | **24/24** | `acceptance-compose-final.md` |
| Attacks, final image | **11/11** | `attacks-compose-final.md` |
| Failure injection | run 1: 1/5 (three platform defects, two script defects); run 2: **5/5** | `failure-injection-run1.md`, `failure-injection-run2.md` |
| Extra scenarios | run 3: 3 PASS, 1 FAIL (CODING-SECOND, §9) | `extra-scenarios-run*.md` |
| Browser, VIDEO-UI after DL-19 | PASS (WebM decoded) | `browser-video-webm.md` |
| Browser, full suite, final stack | see §23 | `browser-compose-final.md` |
| `npm run verify` | §22 | `verify.md` |
| Latency | see below | `latency-compose-final.md` |

_The latency measurement runs after the browser suite. Its results are added in the next commit._

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
