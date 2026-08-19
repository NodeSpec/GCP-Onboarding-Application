# IAP: the perimeter, and who is allowed through it (REQ-023).
#
# The brand and client are provisioned rather than created by hand (AC-1),
# because the client id is one half of what the application verifies against.
# The other half is the backend-service audience string (AC-3). Both are
# outputs, and the API service reads the audience as configuration, so the
# verifier and the perimeter cannot disagree — a hand-copied audience that
# drifts means every assertion is rejected and nobody can sign in, with no error
# anywhere that says why.

# The IAP service agent. It does not exist in a project until something asks
# for it, and the run.invoker grant on the API service names it, so a
# from-scratch apply into a fresh project used to fail with "Service account
# service-<number>@gcp-sa-iap.iam.gserviceaccount.com does not exist" until an
# operator ran `gcloud beta services identity create` by hand. This resource is
# that command: it asks Google to mint the agent, and it is idempotent, so it is
# also safe on a project where the agent already exists.
resource "google_project_service_identity" "iap" {
  provider = google-beta

  project = var.project_id
  service = "iap.googleapis.com"

  depends_on = [google_project_service.required]
}

resource "google_iap_brand" "console" {
  provider = google-beta

  project           = var.project_number
  support_email     = var.iap_support_email
  application_title = "Lifecycle Console"

  depends_on = [google_project_service.required]
}

resource "google_iap_client" "console" {
  provider = google-beta

  display_name = "Lifecycle Console"
  brand        = google_iap_brand.console.name
}

# AC-2: the operator GROUP, and nothing else.
#
# Not individual users, because then every joiner and leaver is a Terraform
# apply and the list drifts from reality the first time somebody is in a hurry.
# Not allAuthenticatedUsers, which would admit every Google account in the
# world. Group membership is the grant, so removing someone from the group
# revokes their access immediately and with no deployment (AC-5).
resource "google_iap_web_backend_service_iam_member" "operators" {
  project             = var.project_id
  web_backend_service = google_compute_backend_service.api.name
  role                = "roles/iap.httpsResourceAccessor"
  member              = "group:${var.operator_group}"
}

locals {
  # The exact string the API service verifies every assertion's `aud` against
  # (REQ-007). Built from the same resources the perimeter is built from, so it
  # cannot be stale.
  iap_audience = "/projects/${var.project_number}/global/backendServices/${google_compute_backend_service.api.generated_id}"
}
