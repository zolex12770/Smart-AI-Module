# Production deployment

**Status: not deployed.** Nothing in this document has been run against a cloud account. Every
step up to `terraform validate` has been verified; everything after it needs credentials this
environment does not have. The missing items, and the exact commands that would close them, are
in [PRODUCTION_DEPLOYMENT_BLOCKER.md](PRODUCTION_DEPLOYMENT_BLOCKER.md).

The target is Google Cloud Run. The full runbook, with the checks after each step, is
[infrastructure/DEPLOYMENT_RUNBOOK.md](../infrastructure/DEPLOYMENT_RUNBOOK.md). This page is
the shape of it and the settings that matter.

## Topology

```
browser ──HTTPS──▶ ai-platform-web (Cloud Run, public, scales to zero)
                     │  Next.js; proxies /api/* (NEXT_PUBLIC_API_PROXY_TARGET), one hour proxy timeout
                     │  Direct VPC egress, all traffic
                     ▼
                   ai-platform-api (Cloud Run, INTERNAL ingress, 1 warm instance, CPU always on,
                     │               3600 s request timeout; ROLE=api)
                     ├──▶ Cloud SQL for PostgreSQL + pgvector (Auth Proxy socket)
                     ├──▶ Cloud Storage bucket (generated media, uploads)
                     └──▶ model runtime: LLM_BASE_URL (a GPU host running Ollama or vLLM),
                          or a hosted key
                   ai-platform-worker (Cloud Run worker pool, ROLE=worker, clamd sidecar)
                     └──▶ same database and bucket; runs the job queues (pg-boss)
```

Why it is shaped this way (the decisions are DL-1 and DL-2 in
[DECISION_LOG.md](DECISION_LOG.md)):

- **Same origin.** The browser only ever talks to the web service, so the session cookie is
  first-party (`COOKIE_SAMESITE=lax`) and no CORS preflight happens. On two `*.run.app` hosts the
  cookie would be third-party, and Safari and Chrome's third-party-cookie blocking would stop
  sign-in.
- **Internal API.** The API can only be reached through the proxy. That is what makes
  `TRUST_PROXY_HOPS=2` safe: a caller cannot write the `X-Forwarded-For` entry the rate limits
  trust.
- **Warm, CPU-always API.** The agent engine runs in-process. It must not be throttled between
  requests or reclaimed mid-run.

## Steps

| # | Step | Command | Verified here |
|---|---|---|---|
| 0 | Budget alert, project, `gcloud auth application-default login` | Cloud console / `gcloud` | no, needs an account |
| 1 | Enable APIs, create Artifact Registry | `terraform apply -target=google_project_service.apis -target=google_artifact_registry_repository.images …` | `validate` only |
| 2a | Build and push the API image | `docker build -f backend/Dockerfile -t <REGION>-docker.pkg.dev/<PROJECT>/ai-platform/api:<tag> . && docker push …` | build: yes (CI and locally); push: no |
| 2b | Apply the API service, read its URL | `terraform apply -target=google_cloud_run_v2_service.api …`, then `terraform output api_url` | no |
| 2c | Build and push the web image in proxy mode | `docker build -f frontend/Dockerfile --build-arg NEXT_PUBLIC_API_PROXY_TARGET=<api_url> --build-arg NEXT_PUBLIC_API_URL= -t …/web:<tag> .` | build in proxy mode: yes (locally, `next build` with the same arguments) |
| 3 | Full apply | `terraform apply -var project_id=… -var api_image=… -var web_image=… -var db_password=… [-var llm_base_url=… -var llm_model=…]` | `fmt` and `validate`: yes; `plan`/`apply`: no |
| 4 | Migrations | `cloud-sql-proxy <connection> & DATABASE_URL=… npm run db:migrate -w @ai-platform/database` | against Postgres 16 + pgvector in Docker: yes; Cloud SQL: no |
| 5 | Verify | the runbook's §5, and `ACCEPT_API_URL=https://<web-url> node scripts/acceptance/full-system.mjs` | against the compose stack: yes; against a deployment: no |

## Settings that differ from local

| Variable | Production value | Where it is set |
|---|---|---|
| `NODE_ENV` | `production` | the API image |
| `ROLE` | `api` on the service, `worker` on the pool | Terraform |
| `DATABASE_URL` | Cloud SQL, through the Auth Proxy socket | Secret Manager |
| `ASSETS_BUCKET` | the media bucket | Terraform |
| `TRUST_PROXY_HOPS` | `2` | Terraform |
| `COOKIE_SAMESITE` | `lax` | Terraform |
| `CORS_ORIGIN` | the web service's URL | Terraform |
| `CLAMD_HOST`, `UPLOAD_SCAN_REQUIRED` | `127.0.0.1`, `true` | Terraform |
| `SANDBOX_ALLOW_PROCESS_IN_PRODUCTION` | `true`, with the exposure stated in [DEPLOYMENT.md](DEPLOYMENT.md#security-relevant-settings) | Terraform |
| `LLM_BASE_URL` / `LLM_MODEL`, or a provider key | the model runtime. Production never auto-detects one | Terraform variables → Secret Manager |
| `NEXT_PUBLIC_API_PROXY_TARGET` (web, build time) | the API service URL | `docker build --build-arg` |
| `NEXT_PUBLIC_API_URL` (web, build time) | empty | `docker build --build-arg` |

The rest of the variables are in [ENVIRONMENT.md](ENVIRONMENT.md). The production security
settings and the runtime contract are in [DEPLOYMENT.md](DEPLOYMENT.md).

## Model and media runtimes in production

Cloud Run has no GPU in this Terraform. So:

- **Chat, RAG, memory and the agent** need `llm_base_url` + `llm_model` (Terraform variables)
  pointing at a model server you run, or a hosted provider key. Without either, the API refuses
  to start in production (a Terraform precondition catches it at plan time).
  - The API service has no VPC egress in this Terraform: it reaches the internet directly. So a
    self-hosted model server must be reachable over HTTPS, with `llm_api_key` if it is exposed.
  - To keep the model server private, give the API service the same `vpc_access` block as the
    web service (egress `PRIVATE_RANGES_ONLY`) and use its internal address.
- **Images** need `IMAGE_BASE_URL` + `IMAGE_MODEL` (an OpenAI-compatible image server), or an
  image built with stable-diffusion.cpp and a model. CPU generation on Cloud Run is too slow to
  be practical: 292 s was measured for SDXL on 4 cores.
- **Speech** works as shipped: Piper is in the image.
- **Video** follows images: image-motion needs a real image provider, and ffmpeg is in the image.
