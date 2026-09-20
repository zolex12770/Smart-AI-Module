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
  description = "Full Artifact Registry image reference for the API service, e.g. \"us-central1-docker.pkg.dev/PROJECT/ai-platform/api:TAG\" — built from backend/Dockerfile and pushed before this is applied."
}

variable "web_image" {
  type        = string
  description = "Full Artifact Registry image reference for the web service, built from frontend/Dockerfile — must be built with the API service's URL baked in via the NEXT_PUBLIC_API_URL build arg (see the deployment runbook)."
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
  type      = string
  sensitive = true
  default   = ""
  # NOT optional in the sense the old description claimed — docs/26_DECISIONS.md ADR-151.
  #
  # It said "leave unset to run on the mock LLM provider, exactly like local dev". The image
  # sets NODE_ENV=production, `providers.ts` refuses to register the mock provider there, and
  # `index.ts` then throws "This process serves chat but no LLM provider is configured, and the
  # mock provider may not run in production" — so following this file's own example produced a
  # service whose every revision exited 1 before it listened, while `terraform apply` reported
  # success. This is the same shape as ADR-138, which fixed the sandbox guard and left the
  # provider guard three lines above it unsupplied.
  #
  # At least one of the three keys, or llm_base_url + llm_model, must be set. The precondition
  # on the api service in main.tf enforces that at plan time rather than at the third failed
  # revision.
  description = "One of the LLM credentials. Stored in Secret Manager and mounted into the API service if non-empty. At least one provider — a hosted key here, or llm_base_url + llm_model — is REQUIRED: the deployed image runs with NODE_ENV=production, where the mock provider may not run and a chat-serving process with no provider refuses to start."
}

# A self-hosted or OpenAI-compatible runtime, which is the provider-neutral path ADR-056 exists
# for and the one a deployment with no hosted account needs. Not secret: a base URL is not a
# credential, and llm_api_key covers the case where the endpoint wants one.
variable "llm_base_url" {
  type        = string
  default     = ""
  description = "Optional. An OpenAI-compatible /v1 base URL (vLLM, Ollama, LM Studio, a gateway). Set together with llm_model."
}

variable "llm_model" {
  type        = string
  default     = ""
  description = "Optional. The model name that endpoint serves. Set together with llm_base_url."
}

variable "llm_api_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Optional. Bearer token for llm_base_url, when that endpoint requires one."
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
