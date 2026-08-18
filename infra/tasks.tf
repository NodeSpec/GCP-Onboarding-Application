# The step queue (REQ-021).
#
# Every retry parameter is declared (AC-1). The provider's defaults are not
# wrong so much as invisible: a step that stops retrying after five attempts
# because nobody chose a number is a behaviour no reviewer of this repository
# could have known about.
#
# The rate limits are the load-bearing ones (AC-2). This queue drives the
# Directory API, and the Directory API has a quota. A queue dispatching faster
# than that quota does not go faster — it generates 429s, which become retries,
# which dispatch again. The ceiling here is set well below the quota so the
# system cannot do that to itself.

resource "google_cloud_tasks_queue" "lifecycle_steps" {
  project  = var.project_id
  name     = "lifecycle-steps"
  location = var.region

  rate_limits {
    max_dispatches_per_second = var.queue_max_dispatches_per_second
    max_concurrent_dispatches = var.queue_max_concurrent_dispatches
  }

  retry_config {
    max_attempts       = var.queue_max_attempts
    min_backoff        = "${var.queue_min_backoff_seconds}s"
    max_backoff        = "${var.queue_max_backoff_seconds}s"
    max_doublings      = var.queue_max_doublings
    max_retry_duration = "0s" # bounded by attempts, not by wall clock
  }

  depends_on = [google_project_service.required]
}

# The audit mirror sweep (REQ-018 AC-1), scheduled.
#
# The scheduler ENQUEUES A TASK rather than calling the worker directly, and
# that indirection is required rather than stylistic. The worker admits exactly
# two caller identities — the queue invoker on /tasks/*, the API service on
# /lookup/* (REQ-007 AC-10) — and grants run.invoker to exactly those two
# (REQ-026 AC-2). A scheduler calling the worker itself would be a third
# principal on both counts, and `requireCaller('cloud-tasks')` would refuse its
# token regardless.
#
# So the sweep arrives the way every other piece of worker work does: as a task
# dispatched by the queue, under the queue invoker's OIDC token. The scheduler
# holds cloudtasks.enqueuer and nothing on Cloud Run at all.
locals {
  audit_sweep_task = jsonencode({
    task = {
      httpRequest = {
        url        = "${google_cloud_run_v2_service.worker.uri}/tasks/mirror-audit"
        httpMethod = "POST"
        headers    = { "Content-Type" = "application/json" }
        body       = base64encode("{}")
        oidcToken = {
          serviceAccountEmail = google_service_account.queue_invoker.email
          audience            = google_cloud_run_v2_service.worker.uri
        }
      }
    }
  })
}

resource "google_cloud_scheduler_job" "audit_mirror" {
  project  = var.project_id
  name     = "lifecycle-audit-mirror"
  region   = var.region
  schedule = var.audit_mirror_schedule

  description = "Enqueues the audit mirror sweep (REQ-018 AC-1)."

  http_target {
    http_method = "POST"
    uri         = "https://cloudtasks.googleapis.com/v2/${google_cloud_tasks_queue.lifecycle_steps.id}/tasks"
    body        = base64encode(local.audit_sweep_task)

    headers = {
      "Content-Type" = "application/json"
    }

    # Calling a Google API, so an OAuth access token rather than an OIDC
    # identity token.
    oauth_token {
      service_account_email = google_service_account.scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  retry_config {
    retry_count = 3
  }

  depends_on = [google_project_service.required]
}

resource "google_project_iam_member" "scheduler_enqueues" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_service_account_iam_member" "scheduler_acts_as_queue_invoker" {
  # Needed to name the queue invoker in the task's oidcToken.
  service_account_id = google_service_account.queue_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.scheduler.email}"
}
