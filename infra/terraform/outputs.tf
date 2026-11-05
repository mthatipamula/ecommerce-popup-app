output "api_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "widget_bucket" {
  value = google_storage_bucket.widget.name
}

output "popup_script_url" {
  value = "https://storage.googleapis.com/${google_storage_bucket.widget.name}/popup.js"
}

output "image" {
  value = local.image
}

output "admin_token_secret" {
  value       = "popup-admin-token"
  description = "gcloud secrets versions access latest --secret popup-admin-token"
}
