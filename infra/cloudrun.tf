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

variable "worker_url" {
  description = <<-EOT
    The worker service's own URL. Declared here rather than in variables.tf
    because it exists only to work around a Terraform limitation in this file,
    and it is unreadable apart from the resource it feeds.

    The worker needs its own URL for two things: the audience it verifies
    incoming OIDC tokens against (REQ-007 AC-10), and the target it enqueues
    follow-on steps at (REQ-016). It cannot be wired from
    google_cloud_run_v2_service.worker.uri, because that is a self reference
    inside the worker's own resource and Terraform rejects it as a cycle. The
    URL embeds a generated hash, so it cannot be built from project and region
    either.

    So it is supplied. Leave it empty on the FIRST apply, then read it back and
    set it before applying again:

      terraform output -raw worker_service_url

    Empty renders an obviously invalid host rather than a plausible wrong one.
    An earlier version defaulted to the console domain, which looked correct,
    verified every token against the wrong audience, and enqueued every step at
    the load balancer instead of the worker. A deployment that is not finished
    should say so.
  EOT
  type        = string
  default     = ""
}

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

    # Egress through the VPC (infra/network.tf). ALL_TRAFFIC rather than
    # PRIVATE_RANGES_ONLY because the destination that matters is the worker's
    # own run.app URL, which is a public address: routing only RFC1918 ranges
    # would leave that call going out over the internet, where the worker's
    # ingress restriction refuses it with a 404 and nothing reaches the worker
    # to log why.
    #
    # This is what lets the API reach the worker's lookup routes at all
    # (REQ-029) without relaxing REQ-026 AC-1.
    vpc_access {
      network_interfaces {
        network    = google_compute_network.lifecycle.id
        subnetwork = google_compute_subnetwork.lifecycle.id
      }
      egress = "ALL_TRAFFIC"
    }

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

  # The NAT is in this list because of an ordering failure that happened, not
  # one that might. Without it, Terraform updates this service as soon as the
  # subnet exists, a new instance comes up with ALL_TRAFFIC egress and no
  # internet route yet, the IAP JWK fetch to www.gstatic.com fails, and every
  # sign-in gets 503 until the NAT finishes creating behind it.
  depends_on = [google_project_service.required, google_compute_router_nat.lifecycle]
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
        name = "WORKER_BASE_URL"
        # The worker's OWN url, not the console's. It is both the audience this
        # service verifies incoming tokens against and the target it enqueues
        # follow-on steps at, so a wrong value 401s every call and posts every
        # step to the load balancer. Supplied as a variable because referencing
        # google_cloud_run_v2_service.worker.uri here is a self reference.
        value = var.worker_url != "" ? var.worker_url : "https://worker-url-not-set.invalid"
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
