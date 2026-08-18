# The three identities, and what each one may do (REQ-014).
#
# The separation that is real and enforceable is the Workspace admin role: the
# worker's identity holds it, the API service's does not, so a compromise of the
# operator-facing surface cannot mutate the directory. That grant is not made
# here — Workspace admin roles are not GCP resources and are assigned in the
# Admin console (REQ-027) — which is why the identity exists here and the
# privilege is documented there.
#
# Firestore access is NOT part of that separation and this file does not pretend
# it is. Firestore IAM is database-scoped, not per-collection, so both services
# necessarily hold the same database-level access; claiming otherwise in a
# binding or a comment would be fiction (REQ-014 AC-7). The boundary between
# their writes lives in the data access layer.

resource "google_service_account" "api" {
  project      = var.project_id
  account_id   = "lifecycle-api"
  display_name = "lifecycle-api runtime"
  description  = "Operator-facing surface. Holds NO Workspace admin role (REQ-014)."

  depends_on = [google_project_service.required]
}

resource "google_service_account" "worker" {
  project      = var.project_id
  account_id   = "lifecycle-worker"
  display_name = "lifecycle-worker runtime"
  description  = "Step executor. The only identity carrying the Workspace admin role (REQ-014, REQ-027)."

  depends_on = [google_project_service.required]
}

resource "google_service_account" "queue_invoker" {
  project      = var.project_id
  account_id   = "lifecycle-queue-invoker"
  display_name = "Cloud Tasks dispatch identity"
  description  = "The identity Cloud Tasks mints OIDC tokens as (REQ-021 AC-3)."

  depends_on = [google_project_service.required]
}

resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = "lifecycle-scheduler"
  display_name = "Cloud Scheduler identity"
  description  = "Drives the audit mirror sweep (REQ-018 AC-1)."

  depends_on = [google_project_service.required]
}

# --------------------------------------------------------------- Datastore
#
# Both services, at the same scope, for the reason stated above. Stated once,
# together, rather than in two places where it could read as two decisions.

resource "google_project_iam_member" "firestore" {
  for_each = {
    api    = google_service_account.api.email
    worker = google_service_account.worker.email
  }

  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${each.value}"
}

# ----------------------------------------------------------------- Secrets
#
# AC-3: per-secret, never at project scope. The API service can decrypt a
# credential because REQ-017's retrieval terminates there; it has no reason to
# hold the SMTP password and does not.

resource "google_secret_manager_secret_iam_member" "worker_smtp" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.smtp.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_secret_manager_secret_iam_member" "worker_credential_key" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.credential_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.worker.email}"
}

resource "google_secret_manager_secret_iam_member" "api_credential_key" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.credential_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.api.email}"
}

# ------------------------------------------------------------- Cloud Tasks

resource "google_project_iam_member" "api_enqueues" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "worker_enqueues" {
  # The worker enqueues too: the next step after one completes, the approval
  # expiry timer, and the approver notice.
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${google_service_account.worker.email}"
}

# Cloud Tasks and Cloud Scheduler mint OIDC tokens AS these identities, which
# requires acting as them.
resource "google_service_account_iam_member" "tasks_mints_queue_invoker" {
  service_account_id = google_service_account.queue_invoker.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${var.project_number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
}

resource "google_service_account_iam_member" "api_acts_as_queue_invoker" {
  service_account_id = google_service_account.queue_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.api.email}"
}

resource "google_service_account_iam_member" "worker_acts_as_queue_invoker" {
  service_account_id = google_service_account.queue_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.worker.email}"
}

# ------------------------------------------------------------------ Logging
#
# REQ-018 AC-3, from the other direction: what is NOT granted.
#
# Neither runtime identity is given roles/logging.admin, roles/logging.configWriter
# or roles/logging.privateLogViewer, and neither is given any role carrying
# logging.logEntries.delete or logging.buckets.update. logging.logWriter is the
# narrowest role that permits writing an entry and permits nothing else — it
# cannot delete an entry, cannot alter a bucket, and cannot touch a retention
# policy. That is the whole shape of the control: the identities that produce
# audit records cannot remove them.

resource "google_project_iam_member" "log_writer" {
  for_each = {
    api    = google_service_account.api.email
    worker = google_service_account.worker.email
  }

  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${each.value}"
}

resource "google_project_iam_member" "worker_reads_audit_log" {
  # Reconciliation reads the log copy back (REQ-018 AC-2). A viewer role reads
  # and cannot write, delete, or reconfigure.
  project = var.project_id
  role    = "roles/logging.viewer"
  member  = "serviceAccount:${google_service_account.worker.email}"
}
