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
  description   = "Container images for apps/api and apps/web (docs/26_DECISIONS.md ADR-037)."
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
# yet wired up: apps/api's asset store (packages/media's LocalAssetStore) and its RAG/coding
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

resource "google_storage_bucket" "quarantine" {
  name                        = "ai-platform-quarantine-${random_id.bucket_suffix.hex}"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false
  lifecycle_rule {
    condition { age = 7 }
    action { type = "Delete" }
  }
}

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

# Optional LLM provider keys — only created if actually supplied, matching ADR-010's
# "real adapters register only when their key is present" behavior all the way through to
# infrastructure: an empty var means the deployed API runs on the mock provider, exactly
# like local dev with no .env entries.
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
  # (apps/web/app/lib/api.ts) and touches no GCP API directly.
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
  name     = "ai-platform-api"
  location = var.region
  deletion_protection = false

  template {
    service_account = google_service_account.api.email

    scaling {
      min_instance_count = 0 # scale-to-zero, docs/18 §4.
      max_instance_count = 3
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
    }
  }

  depends_on = [google_project_service.apis]
}

# The API has no auth system yet (docs/26_DECISIONS.md ADR-008 — single-operator scope) and
# is called directly from the browser (apps/web/app/lib/api.ts's client-side fetch calls),
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
  name     = "ai-platform-web"
  location = var.region
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
      # apps/web/Dockerfile's build arg) — nothing to set here at runtime for it.
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
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }
      # No LLM provider keys here on purpose: no job type calls an LLM today (document
      # ingestion, mock image/video generation, ffmpeg render) — least privilege. Mirror the
      # API service's dynamic env blocks the day a job type genuinely needs one.
    }
  }

  depends_on = [google_project_service.apis]
}
