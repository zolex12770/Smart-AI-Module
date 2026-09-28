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

- Add an optional same-origin mode. Build the web app with `API_PROXY_TARGET=<api origin>` and an
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
     `API_PROXY_TARGET` still proxied (the rewrites are fixed at build time) but fell back to
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
