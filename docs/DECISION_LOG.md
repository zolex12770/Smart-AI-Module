# Decision log

Decisions made during the production-completion pass that started on 2026-09-27. Every decision
before it is in [26_DECISIONS.md](26_DECISIONS.md) (ADR-001 to ADR-162) and is still in force
unless an entry below says otherwise. Each entry says what was found, how it was reproduced, what
changed, and which test fails without the change.

---

## DL-1: The web app proxies the API (same-origin mode)

**Found by:** the independent audit (finding 2), confirmed while building the real-browser
acceptance.

**Problem:** the deployment put the web app and the API on two `*.run.app` hosts. `run.app` is on
the public suffix list, so those are two different *sites*. The session cookie therefore had to be
`SameSite=None`, which makes it a third-party cookie. Safari blocks third-party cookies outright
and Chrome is phasing them out, so sign-in would silently fail for those users. The double-submit
CSRF token was also unreadable: `document.cookie` cannot see another host's cookie.

**Decision:**

- Add an optional same-origin mode. Build the web app with `NEXT_PUBLIC_API_PROXY_TARGET=<api origin>` and an
  empty `NEXT_PUBLIC_API_URL`, and Next rewrites `/api/*` to the API. The Terraform deployment
  uses this mode, with `COOKIE_SAMESITE=lax`.
- The API also returns the CSRF token from signup, login and `/auth/me`, and the client keeps it.
  That makes the cross-host mode work too.

**Measured, and fixed, while doing it:**

1. **Next's gzip buffered the whole SSE stream.** It arrived as one late block.
   - Fix: the chat and agent streams now send `Cache-Control: no-cache, no-transform` and
     `X-Accel-Buffering: no`.
   - Measured through the proxy: 84 token events, the first at 0.9 s and the last at 19.4 s.
2. **Next's proxy destroys a proxied request after 30 s with no bytes.** A server that answered
   after 40 s was cut at exactly 30.0 s with an empty reply. A CPU model can take longer than that
   to its first token.
   - Fix: `experimental.proxyTimeout` is one hour.
   - It is set unconditionally, because `next start` re-evaluates `next.config.mjs` at runtime.
     While the value was set only alongside the rewrites, a server started without
     `NEXT_PUBLIC_API_PROXY_TARGET` still proxied (the rewrites are fixed at build time) but fell back to
     30 s.
   - Re-measured after the fix: the 40 s response arrives whole.
3. **Next forwards `X-Forwarded-For` unchanged and appends nothing** (measured: the value a
   caller sent reached the API verbatim). That settles the hop count below.

**Tests:**

- `frontend/test/next-config.test.ts`: 2 of 3 fail against the previous config.
- `frontend/app/lib/auth-client.test.ts`: "CSRF when the API is on another host".
- `backend/src/routes/v1/password-and-sessions.test.ts`: "returns the double-submit token from
  /auth/me".

## DL-2: The API on Cloud Run: internal ingress, two trusted hops, one warm instance

**Found by:** audit finding 3, plus DL-1.

**Decision (infrastructure/terraform/main.tf):**

- **`ingress = INGRESS_TRAFFIC_INTERNAL_ONLY` on the API.** The web service reaches the API
  through Direct VPC egress (all traffic) on a subnet with Private Google Access. Callers,
  including API-key clients, use `<web URL>/api/v1/...`.
- **`TRUST_PROXY_HOPS=2`.**
  - The chain is: caller → web front end (appends the caller) → Next (appends nothing) → API
    front end (appends the web instance).
  - That count is safe only because nobody can reach the API without going through the web
    service. Were the API public, a direct caller could write the entry the API trusts and choose
    their own rate-limit key.
- **`timeout = 3600s`** on both services. The default of 300 s cuts a long agent stream.
- **`min_instance_count = 1` and `cpu_idle = false` on the API.**
  - With scale-to-zero, the in-process agent engine loses the task it is driving when the
    instance is reclaimed.
  - Request-based CPU throttles everything that runs outside a request.
  - This is a standing cost, and the runbook says so.

**Verification:**

- `terraform fmt -check` and `terraform validate` pass. The providers were installed from
  releases.hashicorp.com through a filesystem mirror, because the registry is unreachable here.
- The hop count and the internal routing have not been checked against a live Cloud Run
  deployment. That is `BLOCKED_EXTERNAL`.

## DL-3: A chat caller cannot choose the model, and output counts toward quota

**Found by:** audit finding 4.

**Problem:**

- The public chat body accepted `model`. Every adapter sends that value verbatim, so a caller
  could pick any model the operator's key reaches, at any price.
- It also accepted `maxOutputTokens` up to 200,000.
- The quota pre-check counted only the prompt.

**Decision:**

- `model` is refused with 400.
- `provider` stays. It only selects among the providers the operator registered.
- `maxOutputTokens` above `CHAT_MAX_OUTPUT_TOKENS` (default 4096) is refused with 400, not
  silently clamped. When it is absent, the cap applies.
- The quota pre-check counts prompt + `maxOutputTokens`.
- All of these checks run before a conversation is created or a provider is called.

**Tests:** `backend/src/routes/v1/chat-overrides.test.ts`. All 4 fail against the previous route.

## DL-4: No screen renders before the session is known

**Found by:** the real-browser acceptance (`scripts/acceptance/browser.mjs`, LOGOUT-LOGIN).

**Problem:** after "Sign out", the chat screen requested `/conversations` and `/models` again,
without a session, and the console showed two 401s. A request trace showed both requests were
*issued* after the logout response, so this is not an in-flight race.

**Cause:** only 5 of the 16 authenticated screens were wrapped in `RequireSession`. The rest:

- fetched before the session was known (every one of them fetched twice on load);
- re-fetched when sign-out cleared the project.

**Decision:** `AppChrome` wraps every non-public screen in `RequireSession`. This covers present
and future screens. Screens that need a project still say so themselves.

**Tests:** `frontend/app/lib/app-chrome.test.tsx`. 2 of 3 fail without the gate.

## DL-5: Every backend variable is in both env templates

`LLM_WARMUP`, `CHAT_MAX_OUTPUT_TOKENS`, `METRICS_PORT` and `METRICS_TOKEN` were read by
`config.ts` but written down nowhere an operator would look. `backend/src/env-example.test.ts`
compares the schema's keys against `.env.example` and `backend/.env.example`.

## DL-6: Warm the local model at boot; probe ffmpeg patiently

**Found by:** the first real-browser run after a restart.

**Problem:**

- The first chat waited for Ollama to load a 4.7 GB model from a cold disk. That took over five
  minutes, and Ollama's own load deadline failed the request.
- In the same cold start, the API's 5 s ffmpeg probe timed out, so video was reported unavailable
  for the life of the process.

**Decision:**

- `LLM_WARMUP` (default on) sends one 1-token request at boot when the default chat provider is
  local. It never fails boot.
- The ffmpeg probe allows 30 s and makes 2 attempts.

**Tests:** `backend/src/local-runtime.test.ts`: a fake ffmpeg that takes 6 s is found, and the
warm-up tests.

## DL-7: Members join by invitation, and the last admin cannot be demoted

**Found by:** audit findings 9 and 10.

**Problem:**

- `POST /projects/:id/members` attached **any** account on the deployment, immediately, by
  email.
- For an unknown address it answered `404 No account exists for <email>`. Every self-signed-up
  user administers their own project, so anyone could probe which addresses are registered
  (defeating the login's enumeration resistance, ADR-125) and put a stranger on their project.
- The same route changed a member's role with no last-admin check. The remove route has one, so
  an admin could lock a project out of administration by re-adding themselves as `viewer`.

**Decision:**

- **Invitations.** An address that is not a current member gets an invitation
  (`project_invitations`, migration 0005, 14-day expiry). The answer is `202 {status:"invited"}`
  whether or not an account has that address.
- The invitee lists their invitations (`GET /api/v1/invitations`) and accepts or declines them
  (`POST /api/v1/invitations/:id/accept|decline`). Both routes are session-only: an API key is
  bound to one project and must not join others. Anything else answers 404: another account's
  invitation, an expired one, one already answered, or a deleted project.
- Admins see and revoke open invitations (`GET` / `DELETE /projects/:id/invitations`).
- For a current member's address, the route changes the role (200). The admin already sees the
  member list, so nothing is disclosed.
- A role change that would leave no admin is refused (400), the same as removal.
- Settings shows the invitation flow: "Invite", the pending list with Revoke, and an
  "Invitations" card with Accept/Decline. Accepting switches to the new project.

**Remaining limitation:** there is no email verification (listed as not implemented). An
invitation goes to whoever signs in with that address, which is the same trust the old route
placed in it.

**Tests:**

- `backend/src/routes/v1/project-members.test.ts`: 6 new tests. The last-admin test fails with
  the guard removed (checked by rebuilding the package under the mutation).
- `frontend/app/settings/invitations.test.tsx`.
- The viewer fixtures in the contract, platform-authority and audio tests now join through
  invite + accept (`joinProjectAs`), the product's only path.

## DL-8: A removed document is gone, not hidden

**Found by:** audit finding 8.

**Problem:** `DELETE /files/:id` soft-deleted the row and dropped its chunks. The serve-gate
looked only at `status`, so the file stayed downloadable by its asset id, and its bytes were
never deleted.

**Decision:**

- The gate refuses a soft-deleted document (404).
- DELETE removes the stored bytes before the soft delete. If that fails, the document is still
  listed and a retried DELETE finishes the job.
- The asset *row* stays, because the soft-deleted document references it.

**Tests:** `rag.test.ts` "a removed document is no longer served, and its bytes are gone from
the store". It fails against the previous route and gate.

**A mistake worth recording:** the first version logged a failed byte deletion and returned
success. It used `assetStore.delete`, which also deletes the asset row, and the documents FK
refused that. The test passed only because the `.catch` swallowed the error. It now uses
`deleteByPath` and lets failures surface.

## DL-9: Deleting a project stops its work

**Found by:** audit finding 11.

**Problem:** `DELETE /projects/:id` only stamped `deletedAt`. After that:

- queued image, speech and video jobs still ran against paid providers;
- a running agent task kept calling the model;
- the agent's workspace stayed on disk, where nothing could reach it.

Account deletion already cleaned up all three.

**Decision:** after the soft delete, the route cancels the project's queued jobs, cancels its
non-terminal agent tasks (a new scoped `listNonTerminalForProject`), and removes its workspace.
The response reports what was stopped, plus a `notStopped` list. A failure is logged at error
and named in that list. It is not folded into a plain success.

**Tests:** `backend/src/routes/v1/project-delete.test.ts`. It failed against the previous route:
the response reported nothing, the job stayed queued and the task stayed open.

## DL-10: Every turn a provider started is charged, and quota refuses before any write

**Found by:** audit findings 12, 13 and 25.

**Problems:**

- **Finding 12.** Chat usage was written only on the provider's `done` event. A client that
  disconnected just before the end, or a provider that failed partway, consumed the prompt and
  every streamed token, and none of it reached the ledger or the quota. ADR-151 had decided that
  such a turn records *no* row ("inventing one would put a fabricated token count in the
  ledger"). That rule made stopping just before the end a way to chat for free.
- **Finding 13.** Memory extraction charged itself *last*, after a parse and a store that could
  throw.
- **Finding 25.** The conversation and the user's message were written *before* the quota check.
  So an over-quota project collected an orphan conversation on every retry.

**Decision:**

- The router reports its **commit**: the provider that produced the first event, after which it
  no longer fails over (`StreamChatOptions.onCommit`).
- A turn that committed and did not finish is charged an **estimate**:
  - the prompt as sent, plus the text and tool calls streamed;
  - under `llm:message-partial:<requestId>`, so it can never double a `done` charge;
  - `estimatedCostUsd` computed from those estimates.
  - This supersedes ADR-151 on this point. The other halves of ADR-151 stand: the partial answer
    is stored, and the span says ERROR.
- The extraction's usage row is written as soon as its call completes, before parse and store.
- A lower-bound quota check (the newest message plus the output cap) runs before anything is
  written. The precise check after windowing and memory injection is unchanged.

**Tests:**

- `backend/src/routes/v1/chat-billing.test.ts`: 4 tests, all failing against the previous route.
  One of them cancels over a real socket, because a client disconnect is what the route listens
  for and `inject` cannot produce one.
- `chat-midstream-failure.test.ts` "does not record the failed turn as a completed one" now
  asserts the new rule: there is no completed-message charge, and there is exactly one partial
  charge.

## DL-11: Agent charges name the real model, survive a retry, and an unrun check is not "passed"

**Found by:** audit findings 14, 15 and 23.

**Finding 23: agent usage was unpriceable.**

- **Problem:** every agent turn was recorded as provider `reasoning`, model `loop`. No price
  table knows that pair, so autonomous runs cost $0 in the usage figures.
- **Decision:** the loop's `usage` event carries the provider and model from the `done` event.

**Finding 14: a reconcile retry lost its charges.**

- **Problem:** a reconcile "retry" restarts the conversation, so its turns count from 1 again.
  They reused `agent.node:<id>:turn:<n>`, which the interrupted attempt had already recorded, and
  the ledger's unique index silently dropped the retry's real charges.
- **Decision:**
  - A retry increments `reconciledRuns` in the node's output.
  - The park path carries that count forward, because it replaces `output` wholesale.
  - Turn and verify keys become `agent.node:<id>:run:<n>:...`.
  - A run never retried keeps its old keys, so the ADR-054 dedupe is unchanged for it.

**Finding 15: an unrun verification read as passed.**

- **Problem:** a verification that could not run (quota refused, the verifier failed, or an
  unparseable verdict) returned `ok: true`. The screen then said "Verification passed —
  verification could not be evaluated".
- **Decision:**
  - The verdict carries `inconclusive: true` through the loop, the stored activity, the SSE event
    and the shared type.
  - The task screen says "Verification could not be completed".
  - The answer is still let through. Blocking on a broken check would spend more.

**Tests:**

- 3 in `agent-core/src/autonomous.test.ts`. All fail against the previous engine and loop.
- 1 in `TaskDetail.test.tsx`.

## DL-12: Sign-out that did not happen says so; video actions report refusals

**Found by:** audit findings 16 and 17.

**Problem:**

- **Sign-out (finding 16).** A failed logout was swallowed, and the screen showed signed-out
  while the server session stayed valid.
- **Video actions (finding 17).**
  - Video Retry and Cancel had no `catch`, so a 429 or 501 was an unhandled rejection that
    showed nothing.
  - A single failed poll replaced the whole video screen, for good.

**Decision:**

- Sign-out clears this browser's state only on success or on a 401 (no session to end).
  Anything else is shown in the nav, and the user stays signed in.
- On the video screen:
  - A refused Retry or Cancel is shown.
  - A failed poll is a banner over the loaded video, cleared by the next successful poll.
  - Retry is also offered for a cancelled project ("Resume", which the backend already supports
    through ADR-150) and for one stuck in planning for more than ten minutes ("Plan again").

**Tests:**

- `app-chrome.test.tsx`: refused sign-out and 401 sign-out.
- `videos/[id]/page.test.tsx`: 3 tests, all failing against the previous page.

## DL-13: Reachable product actions, and text that is true

**Found by:** audit findings 18, 24 and 26.

**Decision (finding 18):**

- Conversations get a title from the opening message (cut at a word).
  - New routes: `PATCH` and `DELETE /api/v1/conversations/:id` (require `chat:write`).
  - The chat header has Rename and Delete controls.
- Settings has Delete on each project the user administers. It reports anything the server
  could not stop.
- The Tasks workspace list has View, which shows a file's contents. `readWorkspaceFile` had no
  caller.

**Text corrections (findings 24 and 26):**

- `IMAGE_UNAVAILABLE` names stable-diffusion.cpp. `VIDEO_UNAVAILABLE` names the local
  image-motion path.
- The videos page says ffmpeg is needed where the worker runs.
- An answer cut off at the output limit (`finishReason: "length"`) is marked as cut off.
- The frontend's `VideoScene.projectId` is `videoProjectId`, matching the backend.

**Tests:**

- `backend/src/routes/v1/conversations.test.ts`.
- `ChatView.test.tsx`: rename, delete and truncation.
- `settings/projects.test.tsx`.
- The Tasks workspace viewer test.

## DL-14: Cancelling media stops the process that is running it

**Found by:** audit findings 5, 6 and 7.

**Problem:**

- **Finding 5.** `ImageProvider.generateImage` had no signal. Cancel on a *processing* image
  therefore did nothing: sd-cli ran to the end, the result was written `succeeded` over the
  request, and the image was charged.
- **Finding 6.** The local motion-video provider could not be stopped either. docs/MEDIA.md said
  cancellation "reaches a running provider call".
- **Finding 7.** `POST /jobs/:queue/:id/cancel` called `boss.cancel` only. The image or audio row
  stayed `pending` forever, and a video scene kept its `jobId`, so orchestration skipped it for
  good.

**Decision:**

- **Image (finding 5).** `generateImage(req, store, signal?)`.
  - sd-cli is killed (SIGKILL) on abort, and a generation cancelled while it waited its turn
    never starts.
  - The OpenAI-compatible adapter aborts its fetch.
  - The image worker runs the same cancellation watch as audio and video.
  - `processImageGeneration` settles a stopped generation as `cancelled`. It is not charged,
    because no usage row is written for a non-success. A provider that finished before the stop
    reached it produced a real image, which is kept and charged as one.
- **Video (finding 6).** `ImageMotionVideoProvider.generateVideo(req, store, signal?)` passes the
  signal to the still and kills ffmpeg on abort. MEDIA.md now describes what actually happens.
- **Raw job cancel (finding 7).**
  - For image and audio jobs, the route requests cancellation on the record, cancels the job,
    and settles a still-queued record as `cancelled`.
  - Video and document jobs are one step of a larger whole. A raw cancel of one of them is
    refused (409) with the screen that can cancel the whole thing.

**Tests:**

- `image-sdcpp`: kill on cancel, and no start once cancelled.
- `video-motion`: kills ffmpeg, and the still receives the signal.
- `media-cancellation.test.ts`: an image already generating is settled `cancelled`. It fails
  against the previous `processImageGeneration`, where it hung until the test timeout.
- `job-cancel.test.ts`: 2 of 3 fail against the previous route.

## DL-15: Deadlines on every model call

**Found by:** audit finding 19.

**Problem:** the hosted chat adapters (Anthropic, OpenAI, Google) called `fetch` with no signal.
The RAG answer, conversation summary and memory extraction called the router with none. So a
stalled provider hung those requests forever, and the summary hung before the chat's headers were
sent.

**Decision:**

- Each hosted adapter owns an AbortController:
  - a deadline, `requestTimeoutMs` (default 300 s, as llm-local). The error message says
    "timeout", which the router classifies as retryable;
  - an abort when the consumer stops reading, so a cancelled chat closes the HTTP connection
    instead of leaving the provider billing tokens nobody reads.
- RAG, summary and extraction calls use a 300 s deadline. RAG also aborts when its client
  disconnects, and answers 503 at the deadline.

**Tests:**

- Each adapter: the deadline, and abort on `return()`. Both fail against the previous adapters.
- `rag-deadline.test.ts`: fails against the previous route, where it hung past the test timeout.

## DL-16: Smaller corrections

- **Usage (finding 22).** The organization block's cost was summed over one project; it is now
  the organization's. The project's own cost is reported beside it. Embedding and speech usage
  and limits, which were enforced but never reported, are in the response and on the Usage page.
  Tests: `usage.test.ts`, `usage/page.test.tsx`.
- **Workspace writes (finding 26).** The workspace write route accepts the 1 MiB file its schema
  allows. Fastify's default body limit answered 413 first. Test: `workspace.test.ts`.
- **DEPLOYMENT.md (finding 20).** The sandbox rows now state that the Cloud Run deployment runs
  process isolation, with `SANDBOX_ALLOW_PROCESS_IN_PRODUCTION=true`, and what that exposes.

## DL-17: One verify command; attacks and failures run for real

**Decision:**

- **`npm run verify`** runs every release gate and prints each as `PASS`, `FAIL` or
  `BLOCKED_EXTERNAL`. It exits non-zero on any FAIL, and a gate is never PASS without having run.
  - `BLOCKED_EXTERNAL` means this machine cannot provide something: no model runtime, no Docker
    daemon, or a registry it cannot reach.
  - If a model runtime *is* reachable but the API is not, the runtime gates **FAIL**. The stack
    is not running, and nothing external is to blame.
- **`attacks.mjs`, `failure-injection.mjs` and `extra-scenarios.mjs`** exercise the running
  system: its HTTP surface, its dependencies and its models. Unit and route tests already prove
  each defence in-process; these catch what only the assembled system can get wrong.
- **Environment reference.** `docs/ENVIRONMENT.md` is generated from the env templates, and a
  test fails when it is stale. The two `.env.example` copies had drifted while their header said
  a test kept them identical; now a test does.

**Mistakes these scripts caught in themselves, on first run:**

- **Oversized body.** Node's `fetch` reports "network error" when a server answers 413 and closes
  mid-upload. `curl` shows the 413 was sent. The check now reads the response over `node:http`.
- **Backslash paths.** A backslash is an ordinary filename character on POSIX. `..\..\x` is a
  literal filename there, not a traversal. The check now asserts it stays inside the workspace as
  one literal name, instead of expecting a refusal that POSIX semantics do not call for.
- **Rate limits.** A second run inside one minute met the upload limit, and a later acceptance run
  met the login window that the X-Forwarded-For spoofing check had deliberately spent. Both limits
  were working as designed. The upload check now waits out `retry-after`. The spoofing check is
  opt-in and documented as spending the window.

## DL-18: The fresh independent audit, and what it changed

An independent read-only audit of everything changed in this pass (`63b8b71..10abb12`) found no
P1 issues, 4 P2 and 8 P3. All twelve are fixed below.

### P2 findings

**1. A cancelled local video scene was recorded `failed`.**
- The motion provider *returns* a failure when its ffmpeg is killed. The orchestrator looked for
  the cancellation only in its `catch`.
- **Fix:** it now checks `watch.wasCancelled()` on a returned failure too.
- **Test:** `media-cancellation.test.ts`. It fails against the previous orchestrator.

**2. The job-cancel route answered `ok` for a generation that had already finished.**
- **Fix:** it now answers 409 "already finished", or `alreadyRequested` for a cancel requested
  twice.
- **Test:** `job-cancel.test.ts`.

**3. Deleting a project stopped queued media but not running media, while the UI said it stopped
both.**
- **Fix:** the route now requests cancellation on every in-flight image, audio and video project.
  The workers' watches read that request. Rows whose queued job was cancelled are settled. Each
  agent task is cancelled in its own `try`, so one failure no longer skips the rest.
- **Test:** `project-delete.test.ts` (extended).

**4. `npm run verify` could report a previous run's acceptance results as this run's.**
- **Fix:** the result file is removed before the run, and results that predate the run are
  rejected. A runtime gate now fails when any of its checks did not run, instead of passing on a
  subset.

### P3 findings

- **Router commit.** `onCommit` fired before the router's error-event failover check, so a partial
  charge could name a provider that was failed over. It now fires after that check, on both the
  failover and named-provider paths. Two router tests fail against the previous router.
- **Last-admin race.** The guard read the admin rows and wrote separately, so two admins demoting
  each other at once could leave none. Guard and write now share one transaction with the rows
  locked `FOR UPDATE`, for removal too. A concurrent test (two service calls at once) fails
  against the previous code.
- **Truncation marker.** A cut-off answer was marked only on screen. The stored message now
  carries the same marker, and a test checks the frontend uses the same words.
- **Extraction after a mid-stream error.** It wrote a 0-token `unknown` usage row and parsed half
  a JSON object. It now records an estimate under `llm:memory-extraction-partial:<requestId>` and
  learns nothing from the turn. The test fails against the previous code.
- **Stale text.** `TRUST_PROXY_HOPS=1` in the live risk register, the `COOKIE_SAMESITE` template
  comment and a video-page comment were corrected. Superseded historical records
  (`29_FEATURE_MATRIX.md`, `FINAL_PROJECT_AUDIT.md`) are left as written, as their headers state.

## DL-19: A WebM rendition beside every rendered MP4

**Context.** The browser run of the compose stack (images from `81cedf8`) passed 10 of 11 checks.
VIDEO-UI failed because the `<video>` element raised an error on the rendered MP4. In that
browser, `canPlayType` returned `""` for `avc1` and `mp4a`, and `"probably"` for VP9 WebM.
Playwright's Chromium is an open-source build without the H.264/AAC decoders, and no other
browser was installed. The MP4 is valid: `ffprobe` and the acceptance run decoded it. But a user
on such a browser (open-source Chromium, some Linux Firefox installs) could not watch their
video.

**Decision.** The render transcodes the finished MP4 into a WebM (VP9 + Opus, CRF 38, realtime
preset) and stores it as `video_projects.render_webm_asset_id` (migration 0006). The player lists
the MP4 first, with a codec string, and the WebM second. A browser plays the first source it can
decode, so browsers with H.264 are unchanged. The WebM is an addition, not a replacement. If
this ffmpeg cannot encode it, the MP4 still ships, the column stays null, and the outcome
returns the reason. A cancel during the transcode still cancels the render.

**Rejected.** Encoding the render itself as VP9 instead of H.264. Safari only recently gained
WebM support, and downloads would lose the embedded `mov_text` captions, which WebM cannot
carry.

**Tests.**
- `video-render.integration.test.ts` runs real ffmpeg. It checks the WebM asset is
  `video/webm`, decodes it end to end, and requires a `matroska,webm` container with a `vp9`
  stream.
- `videos/[id]/page.test.tsx` checks there is no `src` on the element (which would override the
  sources), the source order and types, and that the caption track is kept.
- Both fail against the previous code.


## DL-20: The compose stack gets the agent node budget its model needs

**Context.** In the first extra-scenarios run on compose, both coding tasks were stopped by the
planner's 10-minute node deadline. The audit trail of CODING-SECOND shows 9 turns of
qwen2.5:7b on 4 CPU cores, about 5 output tokens/s. The platform behaved correctly: the task
ended `FAILED` with the reason, the test file was untouched, and an independent run agreed. But
docs/ENVIRONMENT.md already recommends `AGENT_NODE_TIMEOUT_MS=1800000` for exactly this setup, and
`docker-compose.yml` did not pass the variable through, so the stack could not follow its own
documentation.

**Decision.** Compose passes `AGENT_NODE_TIMEOUT_MS`, defaulting to 30 minutes. Setting it empty
keeps the planner's per-node deadlines. The FAIL from the first run is kept as evidence
(`evidence/2026-09-28/extra-scenarios-run1-600s-node-budget.md`); it is not overwritten.

**Also fixed.** Three acceptance scripts read the wrong response fields:

- `extra-scenarios.mjs` and `failure-injection.mjs` read `/api/v1/providers` as `body.image`
  where the API answers `body.providers.image`. IMAGE-REPRODUCIBLE was therefore reported
  `BLOCKED_EXTERNAL` on a stack that had SDXL. Both scripts now read the right field, and a mock
  provider is a FAIL, not a block.
- `attacks.mjs` read the same response wrongly. It fell back to `/api/v1/models`, which was
  right by accident; it now reads `/api/v1/models` directly.

## DL-21: Three defects found by the coding-agent rerun

The rerun with the 30-minute node budget (DL-20) still failed CODING-SECOND, after 848 s, and
CODING-BAD-PATCH ended the same way. The audit log, Ollama's request log and the usage ledger
show three platform defects. The model's own mistakes were a separate matter.

**1. A correct diff was refused.** qwen2.5:7b sent a correct unified diff for `slugify.js` twice.
Its blank context line had no leading space, as many diff producers write it, and as `git apply`
and GNU patch both accept. The parser dropped the line, the hunk lost its blank context line, and
the model was told the lines were "not in this order".
- **Fix:** an empty line inside a hunk is read as an empty context line, but only when more body
  lines of the same hunk follow it. Trailing blank lines and a blank before the next file header
  still belong to nothing.
- **Test:** `patch.test.ts` uses the diff verbatim from the audit log, plus the two guard cases.

**2. A generation still streaming was killed at 300 s.** Ollama logged the call at exactly 5m0s.
The local adapter's `requestTimeoutMs` was a total deadline, but an agent turn may ask for 4096
tokens, and this CPU produces about 5 tokens/s.
- **Fix:** the deadline is now for silence: it re-arms on every chunk. A runtime that stops
  sending is still abandoned, and the error now says it stopped sending. A live generation is
  bounded by the output cap and the node deadline.
- **Also:** the adapter now aborts the request when its caller stops reading (a node deadline, a
  cancel). Before, Ollama kept generating on the CPU the next call needed.
- **Test:** `llm-local/src/index.test.ts` has three tests, each failing on the old adapter.

**3. A turn that died mid-stream was never charged.** Only `done` carried usage, so that
five-minute turn cost nothing. Chat already charges an estimate for this case (DL-10).
- **Fix:** once the router has committed to a provider, an unfinished turn is charged an
  estimate: `…:turn:<n>:partial` for reasoning nodes and `agent.node:<id>:attempt:<n>:partial`
  for `model_call` nodes. Nothing is charged when the provider failed before answering.
- **Test:** `autonomous.test.ts` and `engine.test.ts` each have two tests. The charging test in
  each fails on the old engine.

## DL-22: The warm-up waits out a cold model load

**Context.** After the container restarted, the rerun's first coding task failed before its
first tool call: "stopped sending for 300000ms". Ollama's log showed the cause:
1. The warm-up request started loading qwen2.5:7b from a cold disk.
2. At 5m0s the request was abandoned, and Ollama logged 499 and cancelled the load.
3. The next request started the load again from scratch, and was abandoned the same way.

The model never became ready. The previous total deadline (DL-21) had the same flaw. It was
recorded in TROUBLESHOOTING as "past Ollama's own load deadline" without the cause.

**Decision.**
- The warm-up uses its own deadline, `LLM_LOAD_TIMEOUT_MS`, default 20 minutes, through
  `LocalOpenAICompatibleProvider.withRequestTimeout()`.
- Ordinary calls keep the 300-second silence deadline. A request that arrives during the load
  may still fail, but the warm-up keeps the load alive, so the model becomes ready.

**Test.** `llm-local/src/index.test.ts`: a runtime silent for 250 ms fails at a 100 ms deadline
and succeeds through `withRequestTimeout(2000)`.

## DL-23: Honest answers during an outage, found by failure injection

The first failure-injection run on compose (`scripts/acceptance/failure-injection.mjs`, images
from `70b4229`) found three platform defects and two defects in the script.

**1. Liveness failed during a database outage.** With Postgres stopped, `/api/health` answered
500 to a caller that carried a session cookie. The auth hook looked the session up before any
route ran. An orchestrator restarts a process whose liveness fails, although this one recovers
by itself.
- **Fix:** the auth plugin takes `anonymousPaths` (only `/api/health`); for those, no credential
  is looked up. It applies only to a path that is also public, so it can never skip the
  deny-by-default check.

**2. A database outage looked like a bug.** Every authenticated read answered 500 "Something went
wrong".
- **Fix:** the error handler answers **503 `DATABASE_UNAVAILABLE`** with `Retry-After: 5` and no
  host in the message.
- **Scope:** only for an error raised by a query whose cause chain is a socket error or a Postgres
  connection exception (`08xxx`, `57P01`, `57P03`). An unreachable model runtime has the same
  socket codes and is not reported as a database outage.

**3. RAG answered 500 with the model runtime stopped.** The embedding provider rethrew the raw
`TypeError: fetch failed`, the one branch that did not wrap its error.
- **Fix:** it is now a `ProviderError` (502) whose message does not name the host; the host stays
  in `cause` for the log.

**Script defects.** MEDIA-CRASH and MCP-CRASH ran `sh -c 'pkill -9 -f sd-cli'`. The shell's own
command line contains the pattern, so `pkill` killed the shell, and nothing was injected. The
script now runs `pkill` through `docker exec` with no shell, and fails with a clear reason when
no process matched.

**Tests.** Each fails against the previous code:
- `src/plugins/outage-responses.test.ts`: liveness with a cookie; the 503; the classifier,
  including an unreachable model runtime not being called a database outage.
- `llm-local/src/index.test.ts`: the unreachable embedding runtime.

## DL-24: The fresh audit of DL-19 to DL-23

An independent audit reviewed the code changed by DL-19 to DL-23. It found no P1. Every finding
below was reproduced or checked against the code before it was fixed.

**P2: an empty numeric setting stopped the boot.** The compose comment on `AGENT_NODE_TIMEOUT_MS`
(DL-20) says "set it empty". `${X-default}` passes the empty value through, and
`z.coerce.number()` reads `""` as 0, which fails `min(1000)`. Reproduced: `AGENT_NODE_TIMEOUT_MS=`
gives "Invalid environment configuration". The same was true of all 23 coerced numeric settings
except the few wrapped one by one.
- **Fix:** `loadConfig` drops blank values before parsing, so blank means unset for every field,
  including future ones.
- **Test:** `config.test.ts` sets four of them blank.

**P2: a turn that answers only with a tool call could not be charged when cut off.** The local
provider buffers tool-call fragments until the stream ends. Nothing was yielded before then, so
the router never committed, and DL-21's partial charge never applied to the typical slow turn: a
long diff.
- **Fix:** the provider yields one empty `token` on the first tool-call fragment, and only when
  no text came first. The router commits on it, and an interrupted turn is charged at least its
  prompt. The arguments still buffered at that moment cannot be counted, so the estimate
  undercounts that turn's output.
- **Test:** `llm-local/src/index.test.ts` covers the empty token and its absence when text comes
  first.

**P3: a cancel before the WebM step left three orphaned assets.** The MP4 and both caption files
were stored before the WebM encode, whose cancellation check then threw.
- **Fix:** every asset is stored after the last ffmpeg step.
- **Test:** `video-render.integration.test.ts` runs real ffmpeg through a wrapper that counts
  calls. It cancels exactly before the last call and asserts that nothing was stored. It fails
  against the previous code, which stored the MP4.

**P3: a pool connect timeout was not classified as an outage.** pg's "timeout exceeded when trying
to connect" carries no code, so it answered 500. It now answers 503.

**P3, accepted: the silence deadline also runs while the consumer is paused between reads.** Every
consumer (the agent loop, chat, extraction and the warm-up) reads the stream continuously, so
this needs a consumer that pauses for 300 s.

**Checked and clean** (by the auditor):
- `anonymousPaths` cannot bypass deny-by-default.
- The blank-context rule does not absorb headers or trailing lines.
- The partial and full charges cannot both apply to one turn.
- Migration 0006 matches the schema.
- A browser with H.264 does not skip the MP4 source.

## DL-25: `code.replace_text` says when only the indentation is wrong

**Context.** The full `npm run verify` on `816674a` gave 18 PASS and 1 FAIL
(`evidence/2026-09-28/verify-run3-816674a.json`). CODING-AGENT, which had passed in 4 of 4
earlier runs, stopped at its 12-turn limit on the one-character `sum.js` fix. The audit log shows
the model found the right fix (`a - b` → `a + b`) and then:
- quoted `return a - b;` with 3 or 4 spaces where the file has 2;
- had one diff refused by `code.apply_patch` with "the same text with different indentation";
- was told five times in a row by `code.replace_text` only that `oldText was not found`, which
  gave it nothing to correct.

Every tool call ran correctly, and DL-24's empty token plays no part. The gap is the unequal
diagnosis between the two tools.

**Decision.** When `oldText` is not found but matches exactly one place in the file once leading
whitespace is ignored, the error says so and quotes the file's own lines, with the line number.
It is a diagnosis only. Nothing is applied on a guess, because indentation can be meaningful
(Python, YAML).

**Test.** `agent-mistakes.test.ts` replays the call from the audit log. The file stays unchanged,
the error names the indentation and quotes `"  return a - b;"` at line 2. The plain answer is kept
when the text is not there at all. The first test fails against the previous code.

## DL-26: An oversized upload is answered, not reset

**Context.** The attack suite, run again on the final image, had one failure. MALFORMED-INPUT's
8 MiB POST saw "connection closed without a response", where two earlier runs had seen 413.

Reading the raw socket reproduced it against the Node process itself, inside the container and
against the locally built server. That rules out Docker's port proxy.

The cause: Fastify refuses a body as soon as Content-Length exceeds the limit, and the error
handler answered at once. With most of the upload still unread, closing the socket sends a TCP
RST, and the client's kernel discards the 413 it has not yet delivered.

Measured against the built server:

| Connection mode | Lost |
|---|---|
| Keep-alive, which is what browsers send | 12 of 20 |
| `Connection: close`, which Node closes right after the response | 18 of 20 |

So a user uploading a file that was too large often saw a network error instead of "too large".

**Decision.**
- For a 413, the error handler reads and discards the rest of the upload, and answers only after
  that (`drainUnreadBody`).
- It is bounded: past 64 MiB or 10 seconds the socket is destroyed.
- Answering straight away and draining afterwards fixed keep-alive but not `Connection: close`,
  because Node destroys that socket as soon as the response ends. That is why the answer waits.
- After the fix, against the built server: 20 of 20 keep-alive and 20 of 20 `Connection: close`
  uploads received their 413.

**Tests.** `src/plugins/oversized-body.test.ts` sends the uploads from a separate Node process
over a real socket. In one process, the client's writes and the server's reads share an event
loop, and the race never happens. The keep-alive case fails against the previous handler (10 of
15 resets). `attacks.mjs` now reads the raw socket too, so it reports what the server sent
rather than which side of the race the client landed on.

## DL-27: The local model adapter is no longer bound by `fetch`'s 300-second defaults

**Context.** This was the first cold start after a machine restart, the case DL-22 was meant to
fix but which had never been observed live. The API's warm-up failed after 303.9 s with "Could not
reach the local model runtime: fetch failed". Ollama logged the request as 500 at 5m3s and
cancelled the load. The warm-up's own deadline was 20 minutes, so something else had cut it.

That was Node's global `fetch` (undici): it waits at most 300 s for response headers
(`headersTimeout`) and 300 s between body chunks (`bodyTimeout`), whatever the caller sets.
Reproduced directly: a server withholding headers for 310 s made `fetch` fail after 301 s with
`UND_ERR_HEADERS_TIMEOUT`. So DL-22 never worked in a real runtime. Its unit test used a stubbed
`fetch`, which cannot hit undici's limits.

**Decision.** The adapter's default `fetch` is undici's own `fetch`, with an `Agent` whose headers
and body timeouts sit 5 s above the adapter's silence deadline (`requestTimeoutMs`). The adapter's
timer is therefore the deadline that governs, with its own message. `undici` 7 (the major Node 24
bundles) is now a dependency of `@ai-platform/llm-local`. The embedding call is unaffected: its
deadline is 90 s.

**Test.** `llm-local/src/index.test.ts` runs a real HTTP server that withholds headers for 1.5 s.
The test shrinks the process-wide dispatcher's headers timeout to 500 ms, reproducing in one
second what took 300 s on the cold start. The previous adapter fails there with the exact
cold-start error ("Could not reach the local model runtime … fetch failed"), and the fixed adapter
succeeds. A second test checks that the adapter's own deadline gives its own message.

**Runtime.** Re-verified by a cold start of the rebuilt stack (below, and in the final report).

## DL-28: Two high dependency advisories published since the last run

`npm audit --audit-level=high` failed on the unchanged tree:
- **`fast-uri`** 3.1.6 / 4.1.3 (through Fastify and ajv): authority injection and host confusion.
- **`brace-expansion`** (through the MCP filesystem server's `glob`, and eslint): CPU denial of
  service.

`npm audit fix`, with no `--force`, resolved both with patch and minor updates. The six moderate
advisories accepted in SECURITY.md are unchanged.
