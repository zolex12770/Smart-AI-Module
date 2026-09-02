variable "project_id" {
  type        = string
  description = "The GCP project to deploy into. Must already exist with billing enabled (docs/26_DECISIONS.md ADR-011 — this project does not create the project or enable billing itself)."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Region for every regional resource (Cloud Run, Cloud SQL, Artifact Registry). docs/18_CLOUD_ARCHITECTURE.md §2 has no multi-region requirement at this stage."
}

variable "api_image" {
  type        = string
  description = "Full Artifact Registry image reference for the API service, e.g. \"us-central1-docker.pkg.dev/PROJECT/ai-platform/api:TAG\" — built from apps/api/Dockerfile and pushed before this is applied."
}

variable "web_image" {
  type        = string
  description = "Full Artifact Registry image reference for the web service, built from apps/web/Dockerfile — must be built with the API service's URL baked in via the NEXT_PUBLIC_API_URL build arg (see the deployment runbook)."
}

variable "db_tier" {
  type        = string
  default     = "db-f1-micro"
  description = "Cloud SQL instance tier. Defaults to the smallest available tier per docs/18_CLOUD_ARCHITECTURE.md §4's \"start every service at its smallest tier\" discipline — raise only in response to observed load."
}

variable "db_password" {
  type        = string
  sensitive   = true
  description = "Password for the application's Postgres user. Pass via TF_VAR_db_password or a -var-file that is never committed — never hardcode this in a .tf file."
}

variable "anthropic_api_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional. Stored in Secret Manager and mounted into the API service if non-empty. Leave unset to run on the mock LLM provider, exactly like local dev (docs/26_DECISIONS.md ADR-006/010)."
}

variable "openai_api_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional, same handling as anthropic_api_key."
}

variable "google_api_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional, same handling as anthropic_api_key (Gemini Developer API key, not a Vertex AI service account — docs/18_CLOUD_ARCHITECTURE.md §1.9 covers the Vertex path as a future, separate adapter)."
}
