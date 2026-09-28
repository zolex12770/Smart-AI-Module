# Deployment

Target: Google Cloud Run (API service + worker pool + web service) with Cloud SQL and Cloud
Storage. The Terraform in `infrastructure/terraform/` and the runbook in
`infrastructure/DEPLOYMENT_RUNBOOK.md` remain the operational reference; this file records the
**runtime contract** and what is and is not verified. Every route, the permission it requires and
its rate limit are in `docs/API.md`, generated from the route registrations (`npm run docs:api`)
and checked against real requests by `backend/src/routes/api-contract.test.ts`.

Nothing here has been deployed to a cloud.

## Verification status — read this first

| | Status | Evidence |
|---|---|---|
| Production boot, every role and configuration | **PASS** | `scripts/verify-boot.sh` against the built entrypoint; CI boots the API image with `ROLE=worker` and no LLM key |
| Each application alone, from a fresh clone | **PASS** | 2026-09-27, fresh clone of the pushed branch: `cd backend && npm install && npm run dev` answered `GET /api/health` (Ollama auto-detected); `cd frontend && npm install && npm run dev` served `/chat` with 200 |
| `docker build` (both images) | **PASS** | CI `infrastructure` job builds `backend/Dockerfile` and `frontend/Dockerfile` (Debian `node:24-bookworm-slim`); locally built behind a TLS-intercepting proxy with the `build_ca` secret |
| Docker Compose stack | **PASS** | 2026-09-27: postgres/pgvector, ollama, api, worker and web up and healthy; full-system acceptance against it 23/24, then the one failure (worker metrics unreachable) fixed and re-run PASS; a real browser chatted through the web container ([evidence](evidence/)) |
| API image against a real Postgres | **PASS** | CI boots it (worker role) against `pgvector/pgvector:pg16` and checks the migrations created the schema. This path was broken until 2026-09-27 (pg-boss rejected an undefined backend) |
| Real-container agent sandbox | **PASS** | `npm run test:docker -w @ai-platform/security`, 4/4, locally and in CI |
| `terraform fmt` / `init` / `validate` | **PASS** | CI and locally (providers from a filesystem mirror where the registry is unreachable) |
| `terraform plan` / `apply` | **BLOCKED_EXTERNAL** | needs a GCP project and credentials |
| Cloud Run, Cloud SQL, Cloud Storage, clamd sidecar | **BLOCKED_EXTERNAL** | never exercised against the real services; GCS verified against `fake-gcs-server`, clamd against a real clamd with EICAR |
| `TRUST_PROXY_HOPS=2` behind Cloud Run (web proxy → internal API) | **BLOCKED_EXTERNAL** | needs a live service to check the hop count against. Measured locally: Next's proxy forwards `X-Forwarded-For` unchanged and adds no entry |
| CI pipeline | **PASS** | GitHub Actions, all five jobs green (run 36316998578) |

## Roles

One image, three roles. This is what makes the deployment work, and what previously broke it.

| `ROLE` | Serves HTTP | Runs job workers | Needs an LLM provider |
|---|---|---|---|
| `all` (local dev) | yes | yes | no — without one it boots, and chat, RAG answers and the agent report that no model is configured |
| `api` (Cloud Run service) | yes | only `video.plan` — the storyboard is a model call, and the API is where the model is | **yes** |
| `worker` (Cloud Run worker pool) | no | yes: ingestion, scanning, image, speech, video scenes and render | **no** |

A process refuses to start for lack of a chat provider **only if it serves chat**, and only in
production. The worker pool deliberately receives no LLM key and previously crash-looped on every
boot because of it. Mock providers exist only when `ALLOW_MOCK_PROVIDERS=true`, which production
refuses.

## Running each application

The frontend and backend are separate applications (ADR-092) in one npm-workspaces repository, so
install once at the root — `npm install` inside `backend/` or `frontend/` installs for the whole
root anyway. Each command below starts from the repository root.

```
npm ci                        # once

cd backend && npm run dev     # the API alone — predev builds the workspace packages it imports
cd frontend && npm run dev    # the web app alone — or `npm run build`, whose prebuild builds shared
npm run dev                   # both
```

Before ADR-112 only root scripts (`dev`, `build`) built the workspace packages, and every package
exports only its gitignored `dist/`, so `cd backend && npm run dev` failed on a fresh clone. The API
listens on `PORT` (8787 by default) and accepts the web app's origin from `CORS_ORIGIN`
(`http://localhost:3000` by default). The web app calls `NEXT_PUBLIC_API_URL`
(`http://localhost:8787` when unset), which is fixed at build time.

**Same-origin proxy mode** (what the Terraform deployment uses): build the web app with
`API_PROXY_TARGET=<api-url>` and an empty `NEXT_PUBLIC_API_URL`. The browser then calls only the
web app, which forwards `/api/*` to the API. Cookies are first-party (`COOKIE_SAMESITE=lax`), and
no CORS preflight happens. Two settings make streaming work through it, both measured: the API's
SSE responses carry `Cache-Control: no-transform` (otherwise Next gzips and buffers the whole
stream), and `experimental.proxyTimeout` is one hour (otherwise Next cuts a proxied request after
30 s with no bytes, before a slow CPU model's first token).

Each image builds from the repository root: `docker build -f backend/Dockerfile .` and
`docker build -f frontend/Dockerfile --build-arg NEXT_PUBLIC_API_URL=<api-url> .` (direct mode) or
`docker build -f frontend/Dockerfile --build-arg API_PROXY_TARGET=<api-url> --build-arg NEXT_PUBLIC_API_URL= .` (proxy mode). Building
behind a TLS-intercepting proxy, or where huggingface.co is blocked, is covered in
[docker/README.md](../docker/README.md).

## Local stack with Docker Compose

`docker-compose.yml` runs the production images on one machine: `postgres` (pgvector/pg16),
`ollama` (16K context), `api` (`ROLE=api`), `worker` (`ROLE=worker`, started once the API is
healthy so the two never migrate at once) and `web`. [docker/README.md](../docker/README.md)
lists the services and ports and covers building behind a proxy.

```bash
docker compose up -d --build
docker compose --profile setup run --rm ollama-pull      # once: qwen2.5:7b + nomic-embed-text
# optional, real image and image-motion video generation from a local stable-diffusion.cpp:
SD_CLI_DIR=/opt/sd SD_MODEL_DIR=/opt/models IMAGE_SD_MODEL_FILE=sd_turbo.safetensors \
  docker compose -f docker-compose.yml -f docker-compose.sdcpp.yml up -d
```

The worker serves its own Prometheus metrics on `127.0.0.1:9464/metrics` (`METRICS_PORT`): its
counters, which cover generations and most jobs, live in its process, which has no other
listener. The API's are at `/api/v1/admin/metrics` (system administrator).

What the file relaxes for a single machine, stated in its header: `COOKIE_SECURE=false` (plain
http on localhost), the process sandbox for agent commands inside the API container (no Docker
socket is mounted — see [SECURITY.md](SECURITY.md)), and a local-only Postgres password unless
`POSTGRES_PASSWORD` is set. Set `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` for a first
administrator. Without the sd.cpp overlay (or `IMAGE_BASE_URL`/`IMAGE_MODEL`), image and video
generation answer `CAPABILITY_UNAVAILABLE`.

## The AI runtime: pick one

**Self-hosted — no third-party account required:**

```
LLM_BASE_URL=http://ollama:11434/v1
LLM_MODEL=qwen2.5:7b          # what every real-model run here used; larger is better if it fits
LLM_CONTEXT_WINDOW=16384      # must match the runtime's; Ollama: OLLAMA_CONTEXT_LENGTH=16384
EMBEDDING_BASE_URL=http://ollama:11434/v1
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768
```

Any OpenAI-compatible server works: Ollama, vLLM, llama.cpp's server, LM Studio, or a gateway.

**Hosted:** set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GOOGLE_API_KEY`. If both are present the
self-hosted runtime is the default and the hosted key is the fallback.

Without either, an `api`-role process in production **refuses to start**, with a message naming
both options. That is intentional: a production API that silently answers from a mock is worse
than one that will not start.

## Security-relevant settings

| Variable | Production value | Why |
|---|---|---|
| `SANDBOX_RUNTIME` | `docker` | The agent runs commands a model chose. Process isolation shares the host's network and filesystem. |
| `SANDBOX_ALLOW_PROCESS_IN_PRODUCTION` | `false` | Refuse to start rather than silently downgrade isolation. |
| `UPLOAD_SCAN_REQUIRED` | `true` | Refuse uploads (503) rather than accept them unscanned. |
| `CLAMD_HOST` | `127.0.0.1` | The `clamav/clamav` sidecar on the worker pool. |
| `COOKIE_SECURE` | implied by `NODE_ENV=production` | Session cookies over TLS only. |
| `CORS_ORIGIN` | the web service's URL | Wired automatically by Terraform. |
| `COOKIE_SAMESITE` | `lax` in proxy mode (Terraform sets it); derived `none` when the web app calls the API cross-site | `none` makes the session a third-party cookie, which Safari blocks and Chrome is phasing out. |
| `METRICS_PORT` / `METRICS_TOKEN` | set on the worker pool if it is scraped; always with a token outside a private network | A metrics-only listener (`GET /metrics`). Labels carry no tenant data, but counts are still operational information. |
| `TRUST_PROXY_HOPS` | `2` behind the web service's proxy on Cloud Run (Terraform sets it, with the API's ingress internal-only so nobody can skip the proxy); `1` for an API called directly behind Cloud Run's front end; `0`, the default, with nothing in front | `request.ip` — every per-IP rate limit and audit row — trusts only the `X-Forwarded-For` entries that many proxies appended (ADR-112). A number higher than the real hop count lets a caller choose its own address. The Cloud Run value is unverified against a live service. |

## First run

Set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` to create the first administrator on an
**empty** database. Both are ignored once any user exists. Signup is otherwise open — put it
behind your own ingress policy if that is not what you want.

## Order of operations

1. `terraform apply -target=google_project_service.apis -target=google_artifact_registry_repository.images`
   — breaks the image/registry circular dependency.
2. Build and push the API image (`backend/Dockerfile`). Build the web image (`frontend/Dockerfile`)
   with `API_PROXY_TARGET` set to the API's URL and `NEXT_PUBLIC_API_URL` empty (both build-time
   constants), which means the API's URL must exist first. The full commands are in the runbook's §2.
3. Full `terraform apply`.
4. Run migrations against Cloud SQL through the Auth Proxy:
   `npm run db:migrate -w @ai-platform/database`.
5. Verify per `infrastructure/DEPLOYMENT_RUNBOOK.md` §5.

## Post-deploy checks

- `POST /api/v1/auth/signup` → 201 with a session cookie; every endpoint `docs/API.md` does not mark public → 401 without one.
- A second account must receive **404** for the first account's project id; an API key bound to
  one project must receive **403** for any other project id (`docs/API.md`).
- Login requests from one client, each sending a different `X-Forwarded-For`, must reach **429**
  after 2 × `AUTH_RATE_LIMIT_MAX` (10 at the default) within 10 minutes. If they never do,
  `TRUST_PROXY_HOPS` is higher than the real number of proxies.
- The worker pool's logs must show `job workers registered` and **no** HTTP listener.
- The API's logs must show `providers:[...]` naming the runtime you configured.
- `GET /api/v1/usage` must reflect a chat's real token counts.

## Known operational gaps

- **Per-IP limits are only as correct as `TRUST_PROXY_HOPS`.** Counters live in Postgres and are
  shared by every instance (ADR-071), and the limiter fails open if Postgres is unreachable. Set
  higher than the real hop count, a caller chooses its address; at 0 behind a proxy, `request.ip`
  is the proxy's address, so every caller behind it shares that address's limits.
- **`SANDBOX_ROOT` is per-instance scratch.** A coding-agent run's files last as long as its
  instance.
- **Terraform has no backend block** — state defaults to a local file that would contain the
  database password. Configure a GCS backend before any shared use.
- **Image and video generation are unavailable unless configured, and this Terraform configures
  neither.** Without the `IMAGE_*` settings (ADR-065), or `VIDEO_PROVIDER` with `VIDEO_API_TOKEN`
  and `VIDEO_MODEL_VERSION` (ADR-085), those routes return `CAPABILITY_UNAVAILABLE` (501) rather
  than fake output. Those two hosted adapters are fixture-tested and have served no real
  request; the local stable-diffusion.cpp provider has (see [MEDIA.md](MEDIA.md)), and a Cloud
  Run deployment would need it baked into the image or a GPU image service behind `IMAGE_BASE_URL`.
