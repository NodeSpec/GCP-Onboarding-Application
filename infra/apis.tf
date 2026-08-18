# Service enablement.
#
# Declared rather than clicked, so an apply into an empty project works from
# nothing (REQ-009 AC-1). admin.googleapis.com is the one worth naming: it is
# the Admin SDK the worker calls, and REQ-027 AC-1 requires its enablement to be
# in Terraform rather than a step someone remembers to perform in the console.

locals {
  required_services = [
    "admin.googleapis.com", # Directory API (REQ-027 AC-1)
    "cloudresourcemanager.googleapis.com",
    "iam.googleapis.com",
    "run.googleapis.com",
    "firestore.googleapis.com",
    "cloudtasks.googleapis.com",
    "cloudscheduler.googleapis.com",
    "secretmanager.googleapis.com",
    "compute.googleapis.com",
    "iap.googleapis.com",
    "logging.googleapis.com",
    "artifactregistry.googleapis.com",
  ]
}

resource "google_project_service" "required" {
  for_each = toset(local.required_services)

  project = var.project_id
  service = each.value

  # Left enabled on destroy. Disabling an API tears down resources that other
  # things in the project may depend on, and a `terraform destroy` of this
  # stack has no business reaching that far.
  disable_on_destroy = false
}
