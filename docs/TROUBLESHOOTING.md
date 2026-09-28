# Troubleshooting

Each entry is a problem that was actually hit while building or verifying this platform: what
you see, why it happens, and what fixes it.

## Starting up

**PGlite `RuntimeError: Aborted()` at boot.**
The embedded database was corrupted by a forced kill. Delete `backend/data/pgdata`; it is
re-created and migrated on the next boot. With Postgres (`DATABASE_URL`) this does not happen.

**The API exits at boot in production with a message about the sandbox.**
`NODE_ENV=production` refuses process-level isolation unless you acknowledge it. Either run
`SANDBOX_RUNTIME=docker` on a host that can run containers, or set
`SANDBOX_ALLOW_PROCESS_IN_PRODUCTION=true` knowing what it exposes
([DEPLOYMENT.md](DEPLOYMENT.md#security-relevant-settings)).

**The API exits at boot in production saying no model is configured.**
Production never auto-detects Ollama. Set `LLM_BASE_URL` + `LLM_MODEL`, or a hosted key.

**`backend must be one of postgres, …` from pg-boss.**
This came from an older build that passed `backend: undefined` with `DATABASE_URL`. It is fixed;
rebuild the image.

## Chat and models

**Chat says no model is configured.**
Start Ollama (`ollama serve`, then `ollama pull qwen2.5:7b && ollama pull nomic-embed-text`), or
set `LLM_BASE_URL` and `LLM_MODEL`.

**The first chat after a restart fails with "Load failed … timed out" or waits for minutes.**
Ollama loads the 4.7 GB model from disk on first use. Measured from a cold disk, that took more
than five minutes, past Ollama's own load deadline. `LLM_WARMUP` (on by default) makes the API
load it at boot: look for `chat model warmed up` in the log before testing. Keep Ollama's
`OLLAMA_KEEP_ALIVE` long enough that the model is not evicted between uses.

**The agent ignores the task on long runs, or loses the thread.**
The model's context window is too small. Run Ollama with `OLLAMA_CONTEXT_LENGTH=16384` (its
default of 4096 is too small), and raise `LLM_CONTEXT_WINDOW` if you set it.

**An answer ends mid-sentence with "cut off at the output limit".**
The turn reached `CHAT_MAX_OUTPUT_TOKENS` (default 4096). Ask for a shorter answer, or raise the
limit. A request asking for more than the limit is refused with 400.

**Chat answers 429 `QUOTA_EXCEEDED` although little was used today.**
The pre-flight check counts the prompt *and* the output the turn may produce. With a small
`DAILY_TOKEN_LIMIT`, a 4096-token output reservation alone can exceed it. Lower
`CHAT_MAX_OUTPUT_TOKENS` or raise the limit.

## Streaming

**Chat or agent output arrives all at once at the end, behind a proxy.**
Something in between is compressing or buffering the response. The API sends
`Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` on every stream. A proxy that
ignores both (some CDNs) must be told not to buffer `text/event-stream`.

**Through the web app's same-origin proxy, a slow first token ends in an empty reply after 30 s.**
This is Next's default proxy timeout. `frontend/next.config.mjs` sets
`experimental.proxyTimeout` to one hour. If you changed the config, keep that setting outside any
condition: `next start` re-reads the file at runtime.

## Signing in

**Sign-in works locally but not in the deployed app on Safari (or Chrome with third-party cookies
blocked).**
The web app and the API are on different sites, so the session cookie is third-party. Deploy in
same-origin mode: build the web image with `NEXT_PUBLIC_API_PROXY_TARGET=<api url>` and an empty
`NEXT_PUBLIC_API_URL`, and set `COOKIE_SAMESITE=lax` on the API. The Terraform deployment already
does this ([PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md)).

**Every POST answers 403 "CSRF token missing or invalid" in a cross-site deployment.**
The browser cannot read another host's CSRF cookie. The API returns the token from signup, login
and `/auth/me`, and the web app sends it back. If you see this, the web app predates that change:
rebuild it.

**"Sign-out did not complete, so you are still signed in".**
The server refused the logout (usually a CSRF failure, see above) or could not be reached. The
session is still valid, so the app says so instead of pretending. Try again once the API is
reachable.

**Sign-up answers 429.**
The per-IP sign-up limit (`AUTH_RATE_LIMIT_MAX`, default 5 per 10 minutes; login allows twice
that) is working. Wait, or raise it for scripted testing. Behind proxies, check
`TRUST_PROXY_HOPS`: set too low, every user shares the proxy's address and its limit.

## Media

**Video reports unavailable, or renders are `skipped_no_ffmpeg`, although ffmpeg is installed.**
The boot-time probe could not run ffmpeg. The API logs `ffmpeg could not be executed` with the
path it tried. Set `FFMPEG_PATH` explicitly. The probe allows 30 s and makes 2 attempts, so only a
genuinely missing or broken binary disables video.

**Image generation takes minutes.**
That is expected for SDXL on CPU: 292 s was measured on 4 cores. Use SD-Turbo for 1-step
generation, or a GPU build of stable-diffusion.cpp. Only one generation runs at a time.

**Cancel on an image or a video scene.**
Cancel kills the running sd-cli or ffmpeg process within about 3 s (the worker's poll interval),
and the item is settled `cancelled`. A job cancelled from Platform → Jobs is refused (409) for a
video or document step, with the screen that can cancel the whole thing.

**Speech fails with a shared-library error.**
Piper's release archive needs its own directory on `LD_LIBRARY_PATH`. The backend sets that from
`PIPER_PATH`, so point `PIPER_PATH` at the `piper` binary inside the extracted directory, not at a
copy of it.

## Docker

**`docker build` fails with certificate errors behind a corporate proxy.**
Pass the proxy's CA with the `build_ca` secret. [docker/README.md](../docker/README.md) has the
command.

**`deb.debian.org` is blocked.**
The images are Debian-based. Build where it is reachable, or use a mirror.

**The worker's metrics are not scraped.**
The worker has no HTTP listener of its own. Set `METRICS_PORT` (compose uses 9464) and scrape
that. Set `METRICS_TOKEN` off a private network.

## Tests and verification

**`npm run verify` reports BLOCKED_EXTERNAL for REAL RUNTIME, MEDIA, AGENT, RAG, MEMORY and MCP.**
No model runtime and no API were reachable. Start Ollama and the stack, then set
`ACCEPT_API_URL` (and `ACCEPT_ADMIN_EMAIL` / `ACCEPT_ADMIN_PASSWORD` for METRICS and MCP). If a
model runtime *is* reachable but the API is not, those gates FAIL instead: the stack is not
running.

**`terraform init` fails with "Forbidden" from registry.terraform.io.**
The registry is unreachable from this network. Download the providers from releases.hashicorp.com
into a filesystem mirror and point `TF_CLI_CONFIG_FILE` at a file containing
`provider_installation { filesystem_mirror { path = "<dir>" } }`.

**A backend test does not see a change you made in a package.**
The backend imports the workspace packages from their built `dist/`. Run `npx tsc -b <package>`,
or `npm run build:packages`, before re-running the backend tests.
