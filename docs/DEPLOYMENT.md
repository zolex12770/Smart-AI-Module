# Deployment

Target: Google Cloud Run (API service + worker pool + web service) with Cloud SQL and Cloud
Storage. The Terraform in `infrastructure/terraform/` and the runbook in
`infrastructure/DEPLOYMENT_RUNBOOK.md` remain the operational reference; this file records the
**runtime contract** and what is and is not verified. Every route, the permission it requires and
its rate limit are in `docs/API.md`, generated from the route registrations (`npm run docs:api`)
and checked against real requests by `backend/src/routes/api-contract.test.ts`.

Nothing here has been deployed.

## Verification status — read this first

| | Status |
|---|---|
| Production boot, all five configurations | **Verified locally** — `scripts/verify-boot.sh`, 7/7 against the real built entrypoint, on `fd5f5a5` |
| Each application alone, from a fresh clone | **Verified locally** on `fd5f5a5` — `cd backend && npm run dev` answered `GET /api/health`; `cd frontend && npm run build` exited 0 |
| `docker build` | **Never executed here** (no Docker installed). The CI workflow has a step for it, and CI has never run. |
| `terraform apply` | **Never executed** (no GCP project). `init`/`validate`/`plan` were run for real; `fmt -check` and `validate` pass on `fd5f5a5`, after `TRUST_PROXY_HOPS` was added. |
| `TRUST_PROXY_HOPS=1` behind Cloud Run | **Unverified** — there is no live service to check the hop count against. |
| CI pipeline | **Never executed** (the repository has no remote). |
| Real Cloud SQL / Cloud Storage / clamd sidecar | **Never exercised** against real services. |

## Roles

One image, three roles. This is what makes the deployment work, and what previously broke it.

| `ROLE` | Serves HTTP | Runs job workers | Needs an LLM provider |
|---|---|---|---|
| `all` (local dev) | yes | yes | no — the mock serves development only |
| `api` (Cloud Run service) | yes | no | **yes** |
| `worker` (Cloud Run worker pool) | no | yes | **no** |

A process refuses to start for lack of a chat provider **only if it serves chat**. The worker pool
deliberately receives no LLM key and previously crash-looped on every boot because of it.

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

Each image builds from the repository root: `docker build -f backend/Dockerfile .` and
`docker build -f frontend/Dockerfile --build-arg NEXT_PUBLIC_API_URL=<api-url> .` — neither has
been run here.

## The AI runtime: pick one

**Self-hosted — no third-party account required:**

```
LLM_BASE_URL=http://ollama:11434/v1
LLM_MODEL=qwen2.5:14b
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
| `TRUST_PROXY_HOPS` | `1` directly behind Cloud Run's front end (Terraform sets it); `2` behind an external HTTPS load balancer; `0`, the default, with nothing in front | `request.ip` — every per-IP rate limit and audit row — trusts only the `X-Forwarded-For` entries that many proxies appended (ADR-112). A number higher than the real hop count lets a caller choose its own address. The Cloud Run value is unverified against a live service. |

## First run

Set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` to create the first administrator on an
**empty** database. Both are ignored once any user exists. Signup is otherwise open — put it
behind your own ingress policy if that is not what you want.

## Order of operations

1. `terraform apply -target=google_project_service.apis -target=google_artifact_registry_repository.images`
   — breaks the image/registry circular dependency.
2. Build and push the API image (`backend/Dockerfile`). Build the web image (`frontend/Dockerfile`)
   with `NEXT_PUBLIC_API_URL` baked in (it is a build-time constant), which means the API's URL must
   exist first. The full commands are in the runbook's §2.
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
  than fake output. Both adapters are fixture-tested; neither has served a real request.
