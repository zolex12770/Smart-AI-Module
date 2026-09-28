output "api_url" {
  value       = google_cloud_run_v2_service.api.uri
  description = "The API service's URL. Internal-only ingress: build the web image with API_PROXY_TARGET set to this, and call the API through web_url/api/v1."
}

output "web_url" {
  value       = google_cloud_run_v2_service.web.uri
  description = "Public URL of the deployed web frontend."
}

output "database_connection_name" {
  value       = google_sql_database_instance.postgres.connection_name
  description = "Cloud SQL instance connection name (PROJECT:REGION:INSTANCE), needed for the Cloud SQL Auth Proxy if connecting from outside Cloud Run (e.g. to run migrations manually)."
}

output "artifact_registry_repository" {
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
  description = "Push built images here before applying — see the deployment runbook."
}
