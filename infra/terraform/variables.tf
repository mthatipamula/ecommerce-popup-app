variable "project_id" {
  type        = string
  description = "GCP project to deploy into"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "Tag of the popup image in Artifact Registry (Cloud Build pushes the commit SHA)"
}

variable "app_url" {
  type        = string
  description = "Public URL of the API (Cloud Run URL or your domain), used for OAuth redirects and apply links"
  default     = "https://popup-api.example.com"
}

variable "shopify_mode" {
  type        = string
  default     = "mock"
  description = "mock = simulated store (demo); real = Shopify Admin API"
  validation {
    condition     = contains(["mock", "real"], var.shopify_mode)
    error_message = "shopify_mode must be mock or real"
  }
}

variable "shopify_api_key" {
  type    = string
  default = "demo-client-id"
}

variable "shopify_api_secret" {
  type      = string
  sensitive = true
  default   = "demo-shopify-secret"
}

variable "vertex_region" {
  type        = string
  default     = "global"
  description = "Vertex AI location for Claude ('global' routes to available capacity)"
}

# Sizing for ~10k requests/s: one 2-vCPU instance serves a few thousand sign-ups/s (the hot path is one Redis
# round trip), so 6-10 instances carry 10k/s; max leaves headroom for spikes like Black Friday drops.
variable "api_min_instances" {
  type    = number
  default = 2
}

variable "api_max_instances" {
  type    = number
  default = 60
}

variable "worker_max_instances" {
  type    = number
  default = 4
}

variable "pool_target" {
  type        = number
  default     = 100000
  description = "Codes kept ready per live campaign; size for peak sign-ups/s x refill lag"
}

variable "redis_memory_gb" {
  type    = number
  default = 5
}

variable "db_tier" {
  type    = string
  default = "db-custom-2-7680"
}

variable "db_high_availability" {
  type    = bool
  default = true
}

variable "deletion_protection" {
  type    = bool
  default = true
}
