# Deployment Runbook (Google Cloud Run)

Target architecture: [docs/18_CLOUD_ARCHITECTURE.md](../docs/18_CLOUD_ARCHITECTURE.md). Decision
record: [docs/26_DECISIONS.md](../docs/26_DECISIONS.md) ADR-011, ADR-037.

**This runbook has never actually been executed.** Every command below was reviewed and, where
possible, verified in isolation (`docker build`'s inputs reviewed line by line — no Docker install
exists in the environment that authored this file; the Terraform in `terraform/` was `init`ed and
`validate`d for real, and a real `terraform plan` was run against a fake project id, reaching a
real "no GCP credentials" error rather than a config error — see ADR-037). Running it for real
requires a GCP project with billing enabled and explicit authorization for the specific spend, per
ADR-011 — do not run any step past "Prerequisites" without that authorization.

## Prerequisites

1. A GCP project with billing enabled. **Do not create one or enable billing as part of running
   this runbook** — that decision belongs to whoever is authorizing the spend, not this file.
2. `gcloud` CLI, authenticated (`gcloud auth login`) with `gcloud auth application-default login`
   also run (Terraform's Google provider uses application-default credentials).
3. `docker` (or another OCI-compatible builder).
4. `terraform` >= 1.5.
5. A **budget alert** set in Cloud Billing, per docs/18 §4 — before creating anything else.

## 1. Bootstrap: create the Artifact Registry repository first

`terraform/main.tf` creates the Artifact Registry repository that the Cloud Run services'
container images live in — but those same services need already-pushed images as input. Break
the circular dependency with a targeted first apply:

```sh
cd infrastructure/terraform
terraform init
terraform apply \
  -target=google_project_service.apis \
  -target=google_artifact_registry_repository.images \
  -var="project_id=<PROJECT_ID>" \
  -var="api_image=placeholder" -var="web_image=placeholder" -var="db_password=placeholder"
```

(The three placeholder vars are required by the variable schema but unused by the two targeted
resources — real values are needed starting at step 3.)

## 2. Build and push images

```sh
gcloud auth configure-docker <REGION>-docker.pkg.dev

# From the repo root (build context matters — see the Dockerfiles' own comments):
docker build -f apps/api/Dockerfile -t <REGION>-docker.pkg.dev/<PROJECT_ID>/ai-platform/api:latest .
docker push <REGION>-docker.pkg.dev/<PROJECT_ID>/ai-platform/api:latest

# The web image needs the API's eventual URL baked in at build time (NEXT_PUBLIC_API_URL is a
# Next.js build-time constant, not something read at container start — apps/web/Dockerfile).
# If this is the very first deploy, the API's URL isn't known yet: apply just the API service
# first (step 4 below, without -target=...web), read its URL from the output, then come back
# and build the web image with that URL before applying the web service.
docker build -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://<api-service-url> \
  -t <REGION>-docker.pkg.dev/<PROJECT_ID>/ai-platform/web:latest .
docker push <REGION>-docker.pkg.dev/<PROJECT_ID>/ai-platform/web:latest
```

## 3. Full apply

```sh
terraform apply \
  -var="project_id=<PROJECT_ID>" \
  -var="api_image=<REGION>-docker.pkg.dev/<PROJECT_ID>/ai-platform/api:latest" \
  -var="web_image=<REGION>-docker.pkg.dev/<PROJECT_ID>/ai-platform/web:latest" \
  -var="db_password=<A_REAL_PASSWORD>"
  # add -var="anthropic_api_key=..." etc. only if a real LLM key is actually being deployed
```

Review the plan output before confirming — this creates real, billable resources. Two of them are
NOT scale-to-zero and are the ones to double-check against the approved budget (docs/18 §4): the
Cloud SQL instance, and the job worker pool (docs/26_DECISIONS.md ADR-039 — `MANUAL` scaling with
one always-on instance, the smallest configuration a worker pool supports; set
`manual_instance_count = 0` in `terraform/main.tf` to pause processing without destroying it).
The API and web services scale to zero.

## 4. Run database migrations

The Cloud SQL instance starts with no schema. Connect via the Cloud SQL Auth Proxy from wherever
this is being run from (not from inside a container, unless a one-off `gcloud run jobs execute`
job is set up for this — not built here, an easy real follow-up):

```sh
cloud-sql-proxy <connection_name-from-terraform-output> &
DATABASE_URL="postgresql://ai_platform:<password>@127.0.0.1:5432/ai_platform" \
  npm run db:migrate -w @ai-platform/database
```

This runs `packages/database/src/migrate-cli.ts`, which already branches on `DATABASE_URL`
(docs/26_DECISIONS.md ADR-037) — the exact same migration files the local PGlite path applies,
against a real standalone Postgres for the first time.

## 5. Verify

- `curl https://<api-service-url>/api/v1/files` → `{"documents":[]}` on a fresh instance.
- Open `https://<web-service-url>` → the chat screen should load and be able to reach the API
  (check the browser network tab for CORS errors — `CORS_ORIGIN` is wired to the web service's
  own URL automatically by `terraform/main.tf`).
- `gcloud logging read` or the Cloud Run service's Logs tab should show the same structured JSON
  log lines (`packages/observability`) seen in local dev.
- **The api/worker split (ADR-039) — the one thing no local environment could verify, since it
  needs two processes sharing one real Postgres.** The `ai-platform-api` service's logs should
  show `"role":"api"` and `api role: job workers NOT registered in this process`; the
  `ai-platform-worker` pool's logs should show `"name":"worker"`, `"role":"worker"`, and
  `job workers registered`. Then `POST /api/v1/images` against the API and poll
  `GET /api/v1/images/:id`: it should go `pending` → `succeeded`, and the `provider call
  completed` / `job completed` lines for that id must appear in the *worker pool's* logs, not
  the API service's. If the job stays `pending` forever, the worker pool cannot reach the
  database (check its Cloud SQL volume mount and `DATABASE_URL` secret binding); if the API's
  own logs show the job completing, `ROLE` is not set to `api` on the service.
- **Generated assets in Cloud Storage (ADR-040) — the first time real GCS is in the loop.**
  Both units' boot logs should show `"assetStore":"gcs"` with the media bucket's name. After
  the image above reaches `succeeded`, `GET /api/v1/assets/<resultAssetId>` must return
  `200 image/svg+xml`, and `gsutil ls gs://<media-bucket>/image/` must list
  `<resultAssetId>.svg`. A `403` in the worker pool's logs on upload means the worker service
  account lacks `roles/storage.objectAdmin` on the bucket; a `403`/`404` on the API's read-back
  means the API service account does (they are separate identities, ADR-039). Nothing should
  appear under the instance's local `ASSETS_ROOT`.
- **Document upload end to end (ADR-041).** `curl -F "file=@some.pdf;type=application/pdf"
  https://<api-service-url>/api/v1/files/upload` → `202` with `"sourcePath":null` and an
  `assetId`; `gsutil ls gs://<media-bucket>/document/` lists `<assetId>.pdf`; polling
  `GET /api/v1/files/<id>` reaches `ready` (the worker pool's logs show the `document.ingest`
  job); then an `answer_from_documents` task can retrieve its content. A `400` naming the
  allow-list or a sniff reason is the route working as designed, not a deploy problem.

## Known gaps this runbook does not close

- **The coding agent's workspace is per-instance scratch** (docs/27_RISKS_AND_LIMITATIONS.md,
  ADR-037 narrowed by ADR-040/041): RAG ingestion now has a real upload ingress
  (`POST /api/v1/files/upload`, ADR-041) that stores into the media bucket, so the path-based
  `POST /api/v1/files` is dev-only on a deployment — nothing can place a file under
  `SANDBOX_ROOT` on a stateless instance. A coding-agent run's files last as long as its
  instance, which is fine for one run; nothing about a run is durable across instances.
- **No malware scanning of uploads** (docs/13 §12, ADR-041): uploads pass an allow-list, a
  declared-type check, and a real content sniff, then go straight to ingestion. The
  `quarantine` bucket exists but nothing promotes through it. Acceptable for a single
  operator; not for uploads from untrusted users.
- **The Cloud Storage asset store has only ever been exercised against an emulator**
  (ADR-040) — step 5's asset check is the first time real GCS, Application Default
  Credentials, and the Terraform IAM bindings will all be in the loop together.
- **The api and worker roles have never run concurrently** (docs/26_DECISIONS.md ADR-039):
  the split itself is built and each role was verified live on its own, but the environment that
  authored this could only run one process at a time (PGlite). Step 5's worker-pool check is the
  first time the two will share a database simultaneously — treat a failure there as a real
  finding, not a runbook typo.
- **No CI/CD wiring**: this runbook is manual, start to finish. `.github/workflows/ci.yml`
  (docs/26_DECISIONS.md ADR-035) covers test/build/audit, not build-image-and-deploy — connecting
  the two (e.g. a deploy job gated on a git tag, using `google-github-actions/deploy-cloudrun`)
  is real, separate, currently-unbuilt work.
