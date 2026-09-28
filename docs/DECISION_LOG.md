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
