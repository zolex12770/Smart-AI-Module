# Deployment

Target: Google Cloud Run (API service + worker pool + web service) with Cloud SQL and Cloud
Storage. The Terraform in `infrastructure/terraform/` and the runbook in
`infrastructure/DEPLOYMENT_RUNBOOK.md` remain the operational reference; this file records the
**runtime contract** and what is and is not verified.

## Verification status — read this first

| | Status |
|---|---|
| Production boot, all five configurations | **Verified** — `scripts/verify-boot.sh`, 7/7 against the real built entrypoint |
| `docker build` | **Never executed here** (no Docker installed). CI now performs it. |
| `terraform apply` | **Never executed** (no GCP project). `init`/`validate`/`plan` were run for real. |
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

## First run

Set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` to create the first administrator on an
**empty** database. Both are ignored once any user exists. Signup is otherwise open — put it
behind your own ingress policy if that is not what you want.

## Order of operations

1. `terraform apply -target=google_project_service.apis -target=google_artifact_registry_repository.images`
   — breaks the image/registry circular dependency.
2. Build and push the API image. Build the web image with `NEXT_PUBLIC_API_URL` baked in (it is a
   build-time constant), which means the API's URL must exist first.
3. Full `terraform apply`.
4. Run migrations against Cloud SQL through the Auth Proxy:
   `npm run db:migrate -w @ai-platform/database`.
5. Verify per `infrastructure/DEPLOYMENT_RUNBOOK.md` §5.

## Post-deploy checks

- `POST /api/v1/auth/signup` → 201 with a session cookie; every other endpoint → 401 without one.
- A second account must receive **404** for the first account's project id.
- The worker pool's logs must show `job workers registered` and **no** HTTP listener.
- The API's logs must show `providers:[...]` naming the runtime you configured.
- `GET /api/v1/usage` must reflect a chat's real token counts.

## Known operational gaps

- **Rate limiting is per-instance and in-memory.** With `max_instance_count > 1` the effective
  limit is multiplied by the instance count. Use a shared store before scaling out.
- **`SANDBOX_ROOT` is per-instance scratch.** A coding-agent run's files last as long as its
  instance.
- **Terraform has no backend block** — state defaults to a local file that would contain the
  database password. Configure a GCS backend before any shared use.
- **Image and video generation are unavailable in production by design** (no real provider);
  those routes return a capability error rather than fake output.
