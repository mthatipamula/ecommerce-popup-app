# GCP footprint for the popup platform.
#
#   shopper ──► Cloud Run "popup-api" (autoscaled, ROLE=api) ──► Memorystore Redis (code pools, dedupe, counters)
#                     │                                      └─► Pub/Sub "popup-events" (write-behind queue)
#                     │                                                   │
#   Shopify webhooks ─┘                                                   ▼
#                                                Cloud Run "popup-worker" (ROLE=worker) ──► Cloud SQL Postgres
#                                                      └─► Vertex AI (Claude) for the agents
#   popup.js ──► GCS bucket (public, cacheable; put Cloud CDN in front for production)

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  services = [
    "run.googleapis.com", "sqladmin.googleapis.com", "redis.googleapis.com", "pubsub.googleapis.com",
    "artifactregistry.googleapis.com", "secretmanager.googleapis.com", "aiplatform.googleapis.com",
    "servicenetworking.googleapis.com", "compute.googleapis.com", "cloudbuild.googleapis.com",
  ]
  image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.app.repository_id}/popup:${var.image_tag}"
}

resource "google_project_service" "apis" {
  for_each           = toset(local.services)
  service            = each.value
  disable_on_destroy = false
}

# ------------------------------------------------------------------ network (private IPs for Redis and Cloud SQL)

resource "google_compute_network" "vpc" {
  name                    = "popup-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "run" {
  name          = "popup-run"
  network       = google_compute_network.vpc.id
  region        = var.region
  ip_cidr_range = "10.10.0.0/24"
}

resource "google_compute_global_address" "private_services" {
  name          = "popup-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "private" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}

# ------------------------------------------------------------------ data stores

resource "google_redis_instance" "cache" {
  name               = "popup-redis"
  tier               = "STANDARD_HA" # replica + automatic failover
  memory_size_gb     = var.redis_memory_gb
  region             = var.region
  redis_version      = "REDIS_7_2"
  authorized_network = google_compute_network.vpc.id
  connect_mode       = "PRIVATE_SERVICE_ACCESS"
  depends_on         = [google_service_networking_connection.private]
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "pg" {
  name             = "popup-pg"
  database_version = "POSTGRES_16"
  region           = var.region
  settings {
    tier              = var.db_tier
    availability_type = var.db_high_availability ? "REGIONAL" : "ZONAL"
    edition           = "ENTERPRISE"
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
    database_flags {
      name  = "max_connections"
      value = "400"
    }
    insights_config { query_insights_enabled = true }
  }
  deletion_protection = var.deletion_protection
  depends_on          = [google_service_networking_connection.private]
}

resource "google_sql_database" "app" {
  name     = "popup"
  instance = google_sql_database_instance.pg.name
}

resource "google_sql_user" "app" {
  name     = "popup"
  instance = google_sql_database_instance.pg.name
  password = random_password.db.result
}

# ------------------------------------------------------------------ queue

resource "google_pubsub_topic" "events" {
  name       = "popup-events"
  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic" "events_dlq" {
  name = "popup-events-dlq"
}

resource "google_pubsub_subscription" "writer" {
  name                       = "popup-events-writer"
  topic                      = google_pubsub_topic.events.id
  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.events_dlq.id
    max_delivery_attempts = 10
  }
  retry_policy {
    minimum_backoff = "5s"
    maximum_backoff = "300s"
  }
}

# ------------------------------------------------------------------ secrets

resource "random_id" "token_key" {
  byte_length = 32
}

resource "random_password" "admin" {
  length  = 32
  special = false
}

locals {
  secrets = {
    "popup-database-url"   = "postgres://popup:${random_password.db.result}@${google_sql_database_instance.pg.private_ip_address}:5432/popup"
    "popup-token-enc-key"  = random_id.token_key.hex
    "popup-admin-token"    = random_password.admin.result
    "popup-shopify-secret" = var.shopify_api_secret
  }
}

resource "google_secret_manager_secret" "s" {
  for_each  = local.secrets
  secret_id = each.key
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "s" {
  for_each    = local.secrets
  secret      = google_secret_manager_secret.s[each.key].id
  secret_data = each.value
}

# ------------------------------------------------------------------ identities (least privilege per service)

resource "google_service_account" "api" {
  account_id   = "popup-api"
  display_name = "Popup API (Cloud Run)"
}

resource "google_service_account" "worker" {
  account_id   = "popup-worker"
  display_name = "Popup worker (Cloud Run)"
}

resource "google_pubsub_topic_iam_member" "api_publish" {
  topic  = google_pubsub_topic.events.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.api.email}"
}

resource "google_pubsub_subscription_iam_member" "worker_subscribe" {
  subscription = google_pubsub_subscription.writer.id
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.worker.email}"
}

# Both run agents: the worker on a schedule (abuse review), the API when the merchant asks from the dashboard.
resource "google_project_iam_member" "vertex" {
  for_each = { api = google_service_account.api.email, worker = google_service_account.worker.email }
  project  = var.project_id
  role     = "roles/aiplatform.user"
  member   = "serviceAccount:${each.value}"
}

resource "google_secret_manager_secret_iam_member" "access" {
  for_each = {
    for pair in setproduct(keys(local.secrets), ["api", "worker"]) : "${pair[0]}-${pair[1]}" => pair
  }
  secret_id = google_secret_manager_secret.s[each.value[0]].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value[1] == "api" ? google_service_account.api.email : google_service_account.worker.email}"
}

# ------------------------------------------------------------------ container registry and popup bundle bucket

resource "google_artifact_registry_repository" "app" {
  location      = var.region
  repository_id = "popup"
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

resource "google_storage_bucket" "widget" {
  name                        = "${var.project_id}-popup-widget"
  location                    = var.region
  uniform_bucket_level_access = true
  versioning { enabled = true }
  cors {
    origin          = ["*"]
    method          = ["GET"]
    max_age_seconds = 3600
  }
}

resource "google_storage_bucket_iam_member" "widget_public" {
  bucket = google_storage_bucket.widget.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# ------------------------------------------------------------------ Cloud Run services

locals {
  common_env = {
    NODE_ENV           = "production"
    LOG_LEVEL          = "warn"
    REDIS_URL          = "redis://${google_redis_instance.cache.host}:${google_redis_instance.cache.port}"
    QUEUE              = "pubsub"
    GCP_PROJECT        = var.project_id
    SHOPIFY_MODE       = var.shopify_mode
    SHOPIFY_API_KEY    = var.shopify_api_key
    LLM_PROVIDER       = var.llm_provider
    VERTEX_REGION      = var.vertex_region
    APP_URL            = var.app_url
    POOL_TARGET        = tostring(var.pool_target)
    POOL_LOW_WATERMARK = tostring(floor(var.pool_target * 0.6))
  }
  secret_env = {
    DATABASE_URL       = "popup-database-url"
    TOKEN_ENC_KEY      = "popup-token-enc-key"
    ADMIN_TOKEN        = "popup-admin-token"
    SHOPIFY_API_SECRET = "popup-shopify-secret"
  }
}

resource "google_cloud_run_v2_service" "api" {
  name     = "popup-api"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  # The provider defaults this to true, which blocks replacing a failed service and `terraform destroy`.
  deletion_protection = var.deletion_protection
  template {
    service_account                  = google_service_account.api.email
    max_instance_request_concurrency = 250
    scaling {
      min_instance_count = var.api_min_instances
      max_instance_count = var.api_max_instances
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.vpc.id
        subnetwork = google_compute_subnetwork.run.id
      }
    }
    containers {
      image = local.image
      resources {
        limits            = { cpu = "2", memory = "1Gi" }
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = merge(local.common_env, { ROLE = "api", DB_POOL_MAX = "5" })
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get { path = "/readyz" }
        period_seconds    = 2
        failure_threshold = 30
      }
      liveness_probe {
        http_get { path = "/healthz" }
      }
    }
  }
  depends_on = [google_secret_manager_secret_version.s, google_secret_manager_secret_iam_member.access]
}

resource "google_cloud_run_v2_service" "worker" {
  name                = "popup-worker"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = var.deletion_protection
  template {
    service_account = google_service_account.worker.email
    scaling {
      min_instance_count = 1 # always on: it holds the Pub/Sub streaming pull and the schedulers
      max_instance_count = var.worker_max_instances
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.vpc.id
        subnetwork = google_compute_subnetwork.run.id
      }
    }
    containers {
      image = local.image
      resources {
        limits   = { cpu = var.worker_cpu, memory = "1Gi" }
        cpu_idle = false # CPU always allocated: background work runs outside requests
      }
      dynamic "env" {
        for_each = merge(local.common_env, { ROLE = "worker", DB_POOL_MAX = "10" })
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get { path = "/readyz" }
        period_seconds    = 2
        failure_threshold = 30
      }
    }
  }
  depends_on = [google_secret_manager_secret_version.s, google_secret_manager_secret_iam_member.access]
}

# The storefront and Shopify call the API directly.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
