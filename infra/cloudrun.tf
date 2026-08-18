# The two services (REQ-025, REQ-026).
#
# Both take ingress INTERNAL_LOAD_BALANCER, so a direct *.run.app request is
# refused by the platform before any application code runs (REQ-007 AC-9). That
# is what makes the load balancer the only way in, and therefore what makes IAP
# unavoidable rather than merely present.
#
# Neither has min_instance_count set above zero. Scaling to zero is a stated
# requirement (REQ-009 AC-3) and also the honest shape of the workload: an
# onboarding console is idle almost all of the time.

resource "google_cloud_run_v2_service" "api" {
  project  = var.project_id
  name     = "lifecycle-api"
  location = var.region

  ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  # Cloud Run refuses to create a service whose image cannot be pulled, so this
  # is also where a bad digest fails.
  deletion_protection = false

  template {
    service_account = google_service_account.api.email

    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }

    max_instance_request_concurrency = var.api_max_concurrency
    timeout                          = "${var.api_request_timeout_seconds}s"

    containers {
      image = var.api_image

      # AC-4: every one of these comes from a Terraform output. The IAP audience
      # in particular: the verifier checks the exact backend-service audience
      # string, so a hand-copied value that drifts from the perimeter means
      # every assertion is rejected and nobody can sign in.
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "IAP_AUDIENCE"
        value = local.iap_audience
      }
      env {
        name  = "TASKS_QUEUE"
        value = google_cloud_tasks_queue.lifecycle_steps.name
      }
      env {
        name  = "TASKS_LOCATION"
        value = var.region
      }
      env {
        name  = "WORKER_BASE_URL"
        value = google_cloud_run_v2_service.worker.uri
      }
      env {
        name  = "QUEUE_INVOKER_SA"
        value = google_service_account.queue_invoker.email
      }
      env {
        name  = "CREDENTIAL_KEY_SECRET"
        value = google_secret_manager_secret.credential_key.id
      }
      env {
        name  = "BOOTSTRAP_ADMINS"
        value = join(",", var.bootstrap_admins)
      }
      env {
        name  = "AUTH_MODE"
        value = "iap"
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_cloud_run_v2_service" "worker" {
  project  = var.project_id
  name     = "lifecycle-worker"
  location = var.region

  # Same ingress restriction, but for a different reason: the worker is not
  # attached to any load balancer at all (REQ-026 AC-1), so this closes the only
  # remaining path to it. It is deliberately NOT behind IAP — IAP is a control
  # on human access and the worker has no human callers (REQ-007).
  ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  deletion_protection = false

  template {
    service_account = google_service_account.worker.email

    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }

    max_instance_request_concurrency = var.worker_max_concurrency

    # AC-5: one step plus its retry window. A timeout shorter than the window
    # turns a step that would have recovered into a task failure.
    timeout = "${var.worker_request_timeout_seconds}s"

    containers {
      image = var.worker_image

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "TASKS_QUEUE"
        value = google_cloud_tasks_queue.lifecycle_steps.name
      }
      env {
        name  = "TASKS_LOCATION"
        value = var.region
      }
      env {
        name  = "WORKER_BASE_URL"
        value = "https://${var.domain}"
      }
      env {
        name  = "QUEUE_INVOKER_SA"
        value = google_service_account.queue_invoker.email
      }
      env {
        name  = "API_SERVICE_SA"
        value = google_service_account.api.email
      }
      env {
        name  = "WORKSPACE_CUSTOMER_ID"
        value = var.workspace_customer_id
      }
      env {
        name  = "CONSOLE_BASE_URL"
        value = "https://${var.domain}"
      }
      env {
        name  = "SMTP_SENDER"
        value = var.smtp_sender
      }
      env {
        name  = "SMTP_RETURN_PATH"
        value = var.smtp_return_path
      }
      # Secret NAMES, resolved at runtime (REQ-014 AC-2). Never the values:
      # inlining a secret into an environment variable at build time puts it in
      # the service's revision spec, where anyone with run.viewer can read it.
      env {
        name  = "SMTP_CREDENTIAL_SECRET"
        value = google_secret_manager_secret.smtp.id
      }
      env {
        name  = "CREDENTIAL_KEY_SECRET"
        value = google_secret_manager_secret.credential_key.id
      }
      # REQ-018: the log the mirror writes into, and the view reconciliation
      # reads back through.
      env {
        name  = "AUDIT_LOG_NAME"
        value = local.audit_log_name
      }
      env {
        name  = "AUDIT_LOG_VIEW"
        value = local.audit_log_view
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
  }

  depends_on = [google_project_service.required]
}

# ----------------------------------------------------------------- Invokers
#
# REQ-026 AC-2, and its whole point: EXACTLY two principals on the worker. The
# grants are a map so the set is one literal in one place — a third caller
# cannot be added by appending a resource somewhere else in the file and hoping
# nobody notices the count.

locals {
  worker_invokers = {
    queue_invoker = google_service_account.queue_invoker.email
    api_service   = google_service_account.api.email
  }
}

resource "google_cloud_run_v2_service_iam_member" "worker_invokers" {
  for_each = local.worker_invokers

  project  = var.project_id
  location = google_cloud_run_v2_service.worker.location
  name     = google_cloud_run_v2_service.worker.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${each.value}"
}

# REQ-024 AC-6: one principal on the API service, and it is the load balancer's
# own identity. Every operator request therefore arrives through the perimeter
# that IAP is attached to; nothing can call the service around it.
resource "google_cloud_run_v2_service_iam_member" "api_invoker" {
  project  = var.project_id
  location = google_cloud_run_v2_service.api.location
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${var.project_number}@gcp-sa-iap.iam.gserviceaccount.com"
}
