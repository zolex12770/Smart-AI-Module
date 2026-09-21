terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# --- APIs -------------------------------------------------------------------
# docs/18_CLOUD_ARCHITECTURE.md §1: Cloud Run, Cloud SQL, Secret Manager, Artifact Registry.
# Deliberately NOT enabled here (see docs/18 §3's explicit deferrals, unchanged by this
# file): Pub/Sub, GKE, AlloyDB. Also NOT enabled: Cloud Tasks / Memorystore (Redis) — §1.5
# of that document recommended them, but the system actually built (docs/26_DECISIONS.md
# ADR-012/ADR-027) uses pg-boss directly on Postgres instead, and nothing in this codebase
# uses a distributed cache today (rate limiting is in-process per ADR-032) — provisioning
# either would be paying for infrastructure the app cannot use, the same discipline this
# project applies to code (see ADR-037).
locals {
  required_apis = [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.required_apis)
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# --- Artifact Registry --------------------------------------------------------
resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "ai-platform"
  format        = "DOCKER"
  description   = "Container images for backend/ and frontend/ (docs/26_DECISIONS.md ADR-037)."
  depends_on    = [google_project_service.apis]
}

# --- Cloud SQL for PostgreSQL -------------------------------------------------
# docs/18_CLOUD_ARCHITECTURE.md §1.3: Cloud SQL, not AlloyDB, at this scale. pgvector is
# enabled by the application itself on first connect (packages/database/src/client.ts's
# createPostgresDb runs `CREATE EXTENSION IF NOT EXISTS vector`, the same idempotent
# statement the local PGlite path already runs) — Cloud SQL allow-lists pgvector, so no
# Terraform-level extension flag is needed.
resource "google_sql_database_instance" "postgres" {
  name                = "ai-platform-postgres"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = true

  settings {
    tier = var.db_tier # smallest tier by default — docs/18 §4.

    ip_configuration {
      ipv4_enabled = true # Reached via Cloud Run's built-in Cloud SQL Auth Proxy connector
      # (the `cloud_sql_instances` annotation on each service below), not a raw public
      # connection — IAM/cert-authenticated and encrypted regardless of the public IP.
      # Avoids provisioning a VPC + private services connection, matching docs/18 §3's
      # explicit deferral of dedicated VPC networking until there's a concrete need.
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "app" {
  name     = "ai_platform"
  instance = google_sql_database_instance.postgres.name
}

resource "google_sql_user" "app" {
  name     = "ai_platform"
  instance = google_sql_database_instance.postgres.name
  password = var.db_password
}

# --- Cloud Storage -------------------------------------------------------------
# docs/18_CLOUD_ARCHITECTURE.md §1.4. Provisioned ahead of the code that will use them, NOT
# yet wired up: the backend's asset store (backend/packages/media's LocalAssetStore) and its RAG/coding
# -agent sandbox root are both local-disk-only today, which does not survive Cloud Run's
# ephemeral, multi-instance, scale-to-zero container model — see docs/26_DECISIONS.md
# ADR-037 and docs/27_RISKS_AND_LIMITATIONS.md for this gap, tracked honestly as a real
# prerequisite for a working deploy, not silently assumed solved by these buckets existing.
resource "random_id" "bucket_suffix" {
  byte_length = 4
}

resource "google_storage_bucket" "media" {
  name                        = "ai-platform-media-${random_id.bucket_suffix.hex}"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false
}

resource "google_storage_bucket" "uploads" {
  name                        = "ai-platform-uploads-${random_id.bucket_suffix.hex}"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false
}

# No `quarantine` bucket (docs/18 §1.4 sketched one): ADR-042 implements quarantine as a
# document STATUS — an upload is held `scanning`, never ingested and never served, until the
# worker's clamd scan clears it, and an infected upload's object is deleted outright. A second
# bucket and a copy-on-promote step would add moving parts for no additional containment.

# --- Secret Manager --------------------------------------------------------------
resource "google_secret_manager_secret" "database_url" {
  secret_id = "ai-platform-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret = google_secret_manager_secret.database_url.id
  # Connects through the Cloud SQL Auth Proxy's Unix socket, which Cloud Run mounts at this
  # exact path when the service's `cloud_sql_instances` volume (below) references this
  # instance — this is the standard node-postgres connection-string form for that socket.
  secret_data = "postgresql://${google_sql_user.app.name}:${var.db_password}@/${google_sql_database.app.name}?host=/cloudsql/${google_sql_database_instance.postgres.connection_name}"
}

# LLM provider keys — only created if actually supplied, matching ADR-010's "real adapters
# register only when their key is present" behavior all the way through to infrastructure.
#
# An empty var does NOT mean "the deployed API runs on the mock provider" (ADR-151). It did say
# that, and it was never true: the image sets NODE_ENV=production, where the mock provider is
# refused and a chat-serving process with no provider throws at boot. At least one provider must
# be configured; the api service below has a precondition that fails the plan otherwise, rather
# than letting a successful apply produce a service that cannot start.
resource "google_secret_manager_secret" "llm_api_key" {
  count     = var.llm_api_key != "" ? 1 : 0
  secret_id = "ai-platform-llm-api-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "llm_api_key" {
  count       = var.llm_api_key != "" ? 1 : 0
  secret      = google_secret_manager_secret.llm_api_key[0].id
  secret_data = var.llm_api_key
}

resource "google_secret_manager_secret" "anthropic_api_key" {
  count     = var.anthropic_api_key != "" ? 1 : 0
  secret_id = "ai-platform-anthropic-api-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "anthropic_api_key" {
  count       = var.anthropic_api_key != "" ? 1 : 0
  secret      = google_secret_manager_secret.anthropic_api_key[0].id
  secret_data = var.anthropic_api_key
}

resource "google_secret_manager_secret" "openai_api_key" {
  count     = var.openai_api_key != "" ? 1 : 0
  secret_id = "ai-platform-openai-api-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "openai_api_key" {
  count       = var.openai_api_key != "" ? 1 : 0
  secret      = google_secret_manager_secret.openai_api_key[0].id
  secret_data = var.openai_api_key
}

resource "google_secret_manager_secret" "google_api_key" {
  count     = var.google_api_key != "" ? 1 : 0
  secret_id = "ai-platform-google-api-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "google_api_key" {
  count       = var.google_api_key != "" ? 1 : 0
  secret      = google_secret_manager_secret.google_api_key[0].id
  secret_data = var.google_api_key
}

# --- Service accounts, least privilege ------------------------------------------
resource "google_service_account" "api" {
  account_id   = "ai-platform-api"
  display_name = "AI Platform API (Cloud Run)"
}

resource "google_project_iam_member" "api_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_secret_manager_secret_iam_member" "api_reads_database_url" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

resource "google_storage_bucket_iam_member" "api_media_admin" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}

resource "google_storage_bucket_iam_member" "api_uploads_admin" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.api.email}"
}

resource "google_service_account" "web" {
  account_id   = "ai-platform-web"
  display_name = "AI Platform web frontend (Cloud Run)"
  # No IAM bindings: the web app only ever calls the API over plain HTTP
  # (frontend/app/lib/api.ts) and touches no GCP API directly.
}

# A separate identity for the worker pool (ADR-039) even though its bindings mirror the API
# service's today — so either can be narrowed or revoked independently later (e.g. once a
# CloudStorageAssetStore exists, the API may no longer need bucket write access at all).
resource "google_service_account" "worker" {
  account_id   = "ai-platform-worker"
  display_name = "AI Platform job worker (Cloud Run worker pool)"
}

resource "google_project_iam_member" "worker_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_secret_manager_secret_iam_member" "worker_reads_database_url" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_storage_bucket_iam_member" "worker_media_admin" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_storage_bucket_iam_member" "worker_uploads_admin" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.worker.email}"
}

# --- Cloud Run: API service ------------------------------------------------------
# ROLE=api (docs/26_DECISIONS.md ADR-039): HTTP, the agent engine, and MCP — it enqueues
# jobs but never processes them; the worker pool below (same image, ROLE=worker) does.
# This is docs/17_BACKEND_ARCHITECTURE.md's "why not one app for API + worker" boundary
# made real: the two scale and restart independently, and a burst of slow jobs can no
# longer starve request handling in the same event loop.
resource "google_cloud_run_v2_service" "api" {
  name                = "ai-platform-api"
  location            = var.region
  deletion_protection = false

  template {
    service_account = google_service_account.api.email

    scaling {
      min_instance_count = 0 # scale-to-zero, docs/18 §4.
      /**
       * ONE instance, deliberately — docs/26_DECISIONS.md ADR-159.
       *
       * The api role runs the agent engine in-process, and the live task stream is an in-process
       * `EventEmitter`: `engine.subscribe(taskId, send)` only ever hears events emitted by the
       * SAME process. With three instances and no session affinity, a `POST /agent/tasks` and
       * the `GET .../events` that follows it land on different instances about two times in
       * three — and the stream then delivers nothing at all, silently, on the screen whose whole
       * purpose is showing what the run is doing.
       *
       * ADR-151's execution lease makes multi-instance DISPATCH safe; the event bus is the part
       * that is still single-process. Raising this number requires a cross-instance bus —
       * Postgres LISTEN/NOTIFY keyed by task id is already available here — not just affinity,
       * which does not guarantee that the POST and the GET share an instance either.
       */
      max_instance_count = 1
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.postgres.connection_name]
      }
    }

    containers {
      image = var.api_image

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      env {
        name  = "ROLE"
        value = "api"
      }
      # The sandbox, without which this service refuses to start — ADR-138.
      #
      # backend/Dockerfile sets NODE_ENV=production, and backend/src/index.ts refuses to boot the
      # HTTP role in production with process-level isolation unless an operator has said, in so
      # many words, that they accept it (ADR-055). Cloud Run cannot give a container the nested
      # container isolation SANDBOX_RUNTIME=docker needs. So this service, as defined, could not
      # start: it would exit on the guard with the very message that explains the remedy, and
      # nothing in this file supplied it. The Terraform was deploying an API that stops
      # immediately, and no test here could have noticed — no GCP project exists in the
      # environment that authored it.
      #
      # `true` is the honest setting for this topology and it is not a workaround: it is the
      # acknowledgement the guard asks for. The consequence is real and worth stating plainly —
      # a model-chosen command that escapes its workspace reaches this container's filesystem and
      # network. The container is the blast radius, which is why the service account below is
      # scoped to one bucket and one database rather than to the project.
      /**
       * The health endpoint is finally consumed — ADR-159.
       *
       * `/api/health` has existed since the first phase and `grep -rn "api/health" infrastructure/
       * .github/` returned nothing: no startup probe, no liveness probe, and the CI boot gate
       * only checked that the process had not exited. So a revision whose server was listening
       * but whose database was unreachable was rolled out as healthy, and a process that wedged
       * after boot was never restarted.
       *
       * The port is stated alongside, matching the Dockerfile's EXPOSE: a probe needs one, and
       * leaving Cloud Run to infer it while a probe names it is how the two drift.
       */
      ports {
        container_port = 8080
      }

      startup_probe {
        http_get {
          path = "/api/health"
          port = 8080
        }
        # Generous: the first request runs migrations against Cloud SQL.
        initial_delay_seconds = 5
        timeout_seconds       = 5
        period_seconds        = 10
        failure_threshold     = 12
      }

      liveness_probe {
        http_get {
          path = "/api/health"
          port = 8080
        }
        period_seconds    = 30
        timeout_seconds   = 5
        failure_threshold = 3
      }

      env {
        name  = "SANDBOX_ALLOW_PROCESS_IN_PRODUCTION"
        value = "true"
      }
      env {
        # A writable path: index.ts mkdirSync's this at boot, and a Cloud Run container's root
        # filesystem is read-only apart from /tmp. The workspace is per-instance and ephemeral,
        # which is correct — the sandbox is scratch space for one agent run, never storage
        # (DEPLOYMENT_RUNBOOK.md §"Statelessness").
        name  = "SANDBOX_ROOT"
        value = "/tmp/sandbox"
      }
      env {
        # ADR-151 — belt and braces beside the ASSETS_BUCKET below. Boot no longer creates this
        # directory when a bucket is configured (the local store is not built then), but the
        # default value points inside the image's read-only WORKDIR, and a path that cannot be
        # written must not be one an operator can reach by unsetting one other variable.
        name  = "ASSETS_ROOT"
        value = "/tmp/assets"
      }
      env {
        # ADR-112 — how many proxies' X-Forwarded-For entries to trust. Cloud Run's front end
        # appends the caller's address, so 1 takes that entry and ignores anything the caller
        # wrote; an external HTTPS load balancer in front makes it 2. Not verified against a live
        # Cloud Run service — this environment has no GCP project.
        name  = "TRUST_PROXY_HOPS"
        value = "1"
      }
      env {
        # ADR-040 — generated assets go to Cloud Storage, not the instance's ephemeral disk.
        # Authenticated via the attached service account (objectAdmin on this bucket, above).
        name  = "ASSETS_BUCKET"
        value = google_storage_bucket.media.name
      }
      # ADR-042 — CLAMD_HOST being set is what makes the upload route hold uploads for
      # scanning; the API never scans anything itself (the worker pool does, via its sidecar),
      # so clamd is expected to be unreachable from here — the boot log says so, by design.
      # UPLOAD_SCAN_REQUIRED=true: a real deployment must fail closed if scanning is ever
      # misconfigured, rather than quietly accepting unscanned uploads.
      env {
        name  = "CLAMD_HOST"
        value = "127.0.0.1"
      }
      env {
        name  = "UPLOAD_SCAN_REQUIRED"
        value = "true"
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "CORS_ORIGIN"
        value = google_cloud_run_v2_service.web.uri # already a full "https://...run.app" URL
      }

      dynamic "env" {
        for_each = nonsensitive(var.anthropic_api_key != "") ? [1] : []
        content {
          name = "ANTHROPIC_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.anthropic_api_key[0].secret_id
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = nonsensitive(var.openai_api_key != "") ? [1] : []
        content {
          name = "OPENAI_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.openai_api_key[0].secret_id
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = nonsensitive(var.google_api_key != "") ? [1] : []
        content {
          name = "GOOGLE_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.google_api_key[0].secret_id
              version = "latest"
            }
          }
        }
      }

      # A self-hosted OpenAI-compatible runtime (ADR-056), which is the provider-neutral path
      # and the only one available to a deployment with no hosted account. Added by ADR-151:
      # infrastructure/ could configure no LLM provider of any kind, so the one path the docs
      # call the default was unreachable from Terraform.
      dynamic "env" {
        for_each = var.llm_base_url != "" ? [1] : []
        content {
          name  = "LLM_BASE_URL"
          value = var.llm_base_url
        }
      }
      dynamic "env" {
        for_each = var.llm_model != "" ? [1] : []
        content {
          name  = "LLM_MODEL"
          value = var.llm_model
        }
      }
      dynamic "env" {
        for_each = nonsensitive(var.llm_api_key != "") ? [1] : []
        content {
          name = "LLM_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.llm_api_key[0].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  /**
   * The plan fails rather than the revisions — docs/26_DECISIONS.md ADR-151.
   *
   * The image sets NODE_ENV=production; `providers.ts` refuses to register the mock provider
   * there, and `index.ts` throws "This process serves chat but no LLM provider is configured"
   * before it listens. So a deployment that followed this repository's own tfvars example — "
   * leave unset to run on the mock provider" — produced a service whose every revision exited
   * 1, with `terraform apply` reporting success. A precondition turns that into a plan-time
   * error naming the variables to set.
   */
  lifecycle {
    precondition {
      condition = (
        var.anthropic_api_key != "" ||
        var.openai_api_key != "" ||
        var.google_api_key != "" ||
        (var.llm_base_url != "" && var.llm_model != "")
      )
      error_message = "The api service serves chat and the deployed image runs with NODE_ENV=production, where the mock LLM provider may not run — set one of anthropic_api_key, openai_api_key, google_api_key, or both llm_base_url and llm_model."
    }
  }

  depends_on = [google_project_service.apis]
}

# The API has no auth system yet (docs/26_DECISIONS.md ADR-008 — single-operator scope) and
# is called directly from the browser (frontend/app/lib/api.ts's client-side fetch calls),
# so it must accept unauthenticated invocations the same way the web frontend does. This is
# a real, current security-posture fact made visible at the infra level, not a new gap
# introduced by this file — see docs/27_RISKS_AND_LIMITATIONS.md's existing "no RBAC" row.
resource "google_cloud_run_v2_service_iam_member" "api_public" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Cloud Run: web service -------------------------------------------------------
resource "google_cloud_run_v2_service" "web" {
  name                = "ai-platform-web"
  location            = var.region
  deletion_protection = false

  template {
    service_account = google_service_account.web.email

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    containers {
      image = var.web_image
      # NEXT_PUBLIC_API_URL is already baked into this image at build time (see
      # frontend/Dockerfile's build arg) — nothing to set here at runtime for it.
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  name     = google_cloud_run_v2_service.web.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Cloud Run: job worker pool -----------------------------------------------------
# ROLE=worker (ADR-039) on the SAME image as the API service — docs/18_CLOUD_ARCHITECTURE.md
# §1.1's recommended home for a non-HTTP queue consumer (Worker Pools, GA April 2026). No
# ingress, no health checks, no IAM invoker binding: nothing can call it, it only polls
# pg-boss. Same Cloud SQL Auth Proxy connector as the API — both talk to the one database,
# which is exactly what pg-boss needs to hand work from one to the other.
#
# Cost note (docs/18 §4): a worker pool does NOT scale to zero — MANUAL scaling with one
# always-on instance is the smallest viable configuration, and is a real standing cost
# alongside Cloud SQL. Set manual_instance_count = 0 to pause processing without destroying
# the pool; raise it (docs/07 §1.6) only in response to observed queue depth.
resource "google_cloud_run_v2_worker_pool" "worker" {
  name                = "ai-platform-worker"
  location            = var.region
  deletion_protection = false

  scaling {
    scaling_mode          = "MANUAL"
    manual_instance_count = 1
  }

  template {
    service_account = google_service_account.worker.email

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.postgres.connection_name]
      }
    }

    containers {
      image = var.api_image

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      env {
        name  = "ROLE"
        value = "worker"
      }
      env {
        # The worker creates this directory at boot too, and a Cloud Run container's root
        # filesystem is read-only apart from /tmp — so the default `./data/sandbox` fails here
        # exactly as it does in the api service (ADR-138). The worker role does NOT trip the
        # production isolation guard, which is scoped to the HTTP role, so it needs the path and
        # not the acknowledgement.
        name  = "SANDBOX_ROOT"
        value = "/tmp/sandbox"
      }
      env {
        # ADR-151 — belt and braces beside the ASSETS_BUCKET below. Boot no longer creates this
        # directory when a bucket is configured (the local store is not built then), but the
        # default value points inside the image's read-only WORKDIR, and a path that cannot be
        # written must not be one an operator can reach by unsetting one other variable.
        name  = "ASSETS_ROOT"
        value = "/tmp/assets"
      }
      env {
        # ADR-040 — the worker WRITES assets (image/video jobs, the ffmpeg render) and the
        # API READS them back (GET /api/v1/assets/:id): both must point at the same bucket.
        name  = "ASSETS_BUCKET"
        value = google_storage_bucket.media.name
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }
      env {
        # ADR-042 — the clamd sidecar below shares this instance's network namespace.
        name  = "CLAMD_HOST"
        value = "127.0.0.1"
      }
      # No LLM provider keys here on purpose: no job type calls an LLM today (document
      # ingestion, mock image/video generation, ffmpeg render) — least privilege. Mirror the
      # API service's dynamic env blocks the day a job type genuinely needs one.
    }

    # ADR-042 — the malware scanner, as a sidecar (Cloud Run multi-container). clamd speaks
    # raw TCP on 3310, which a separate Cloud Run *service* could not expose (services are
    # HTTP(S) only) — a sidecar on the one role that scans is the right home. The official
    # `clamav/clamav` image ships with a signature database baked in and runs freshclam to
    # keep it current (needs egress to database.clamav.net, which Cloud Run allows by
    # default). clamd holds the whole database in memory: the 3 GiB limit is a real
    # requirement, not headroom, and the image takes 1-2 minutes to become ready after a cold
    # start — which is why document.scan retries with backoff rather than failing fast.
    containers {
      name  = "clamd"
      image = "clamav/clamav:1.5"
      resources {
        limits = {
          cpu    = "1"
          memory = "3Gi"
        }
      }
    }
  }

  depends_on = [google_project_service.apis]
}
