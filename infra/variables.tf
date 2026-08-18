# Every value a deployment has to decide, declared here rather than written
# into a resource. The rule the requirements keep returning to is that a
# provider default is not a decision anyone made: a queue that retries five
# times because nobody said otherwise, or a Firestore region chosen by the
# console, is a property of the deployment that no reviewer can see. Anything
# an operator would reasonably want to change, or would want to know the value
# of, is a variable.

variable "project_id" {
  description = "The GCP project this deployment lives in."
  type        = string
}

variable "project_number" {
  description = <<-EOT
    The project NUMBER, not the id. It appears in the IAP audience string
    (/projects/<number>/global/backendServices/<id>), which the API service
    verifies every assertion against (REQ-007).
  EOT
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Cloud Tasks and Cloud Scheduler."
  type        = string
  default     = "us-central1"
}

variable "firestore_location" {
  description = <<-EOT
    Firestore location (REQ-020 AC-1). Separate from `region` because Firestore
    locations are their own namespace — multi-region names like `nam5` have no
    Cloud Run equivalent — and because moving a Firestore database means
    creating a new one.
  EOT
  type        = string
  default     = "nam5"
}

variable "domain" {
  description = "Domain for the managed TLS certificate on the operator console (REQ-024 AC-3)."
  type        = string
}

variable "operator_group" {
  description = <<-EOT
    The Google group whose members may reach the console through IAP
    (REQ-023 AC-2). A GROUP, never a list of individuals: access is then granted
    and revoked by group membership, with no Terraform apply in the loop
    (AC-5).
  EOT
  type        = string

  validation {
    condition     = can(regex("^[^@]+@[^@]+$", var.operator_group))
    error_message = "operator_group must be a group email address."
  }
}

variable "iap_support_email" {
  description = "Support contact on the OAuth consent screen. Must be the owner or a group the deployer belongs to."
  type        = string
}

variable "api_image" {
  description = <<-EOT
    The lifecycle-api container, BY DIGEST (REQ-025 AC-6). A tag is a mutable
    pointer: the same Terraform state would describe different running code
    depending on when it was applied, and a rollback would have nothing exact to
    roll back to.
  EOT
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.api_image))
    error_message = "api_image must be pinned by digest (…@sha256:…), not by tag."
  }
}

variable "worker_image" {
  description = "The lifecycle-worker container, by digest (REQ-026 AC-6)."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.worker_image))
    error_message = "worker_image must be pinned by digest (…@sha256:…), not by tag."
  }
}

# ----------------------------------------------------------------- Cloud Run

variable "api_request_timeout_seconds" {
  description = "Request timeout for the API service (REQ-025 AC-5). Operator requests are short; this is not the queue."
  type        = number
  default     = 60
}

variable "api_max_concurrency" {
  description = "Concurrent requests per API instance (REQ-025 AC-5)."
  type        = number
  default     = 80
}

variable "worker_request_timeout_seconds" {
  description = <<-EOT
    Request timeout for the worker (REQ-026 AC-5). One step, including its
    in-process retry window against the Directory API. The slowest step is a
    group assignment fanning out across several groups with backoff between
    attempts, so this is minutes rather than seconds — but it is stated, not
    inherited, because a timeout shorter than the retry window turns a
    recoverable step into a task failure.
  EOT
  type        = number
  default     = 600
}

variable "worker_max_concurrency" {
  description = <<-EOT
    Concurrent tasks per worker instance. Kept low deliberately: each task is a
    Workspace mutation, and concurrency here multiplies against the queue's own
    dispatch limit when computing pressure on the Directory API quota.
  EOT
  type        = number
  default     = 4
}

# --------------------------------------------------------------- Cloud Tasks

variable "queue_max_attempts" {
  description = "Delivery attempts before a task is dropped (REQ-021 AC-1)."
  type        = number
  default     = 8
}

variable "queue_min_backoff_seconds" {
  description = "Shortest retry interval (REQ-021 AC-1)."
  type        = number
  default     = 5
}

variable "queue_max_backoff_seconds" {
  description = "Longest retry interval (REQ-021 AC-1)."
  type        = number
  default     = 300
}

variable "queue_max_doublings" {
  description = "How many times the backoff doubles before going linear (REQ-021 AC-1)."
  type        = number
  default     = 4
}

variable "queue_max_dispatches_per_second" {
  description = <<-EOT
    Dispatch rate ceiling (REQ-021 AC-2). Held well below the Directory API's
    quota so the queue cannot generate its own 429s: a queue that outruns the
    API it drives converts a throughput problem into a retry storm, and the
    retries make it worse.
  EOT
  type        = number
  default     = 5
}

variable "queue_max_concurrent_dispatches" {
  description = "In-flight task ceiling (REQ-021 AC-2)."
  type        = number
  default     = 10
}

# ------------------------------------------------------------------ Firestore

variable "firestore_pitr_retention" {
  description = <<-EOT
    Point-in-time recovery window (REQ-020 AC-4). Valid values are 1h or 7d;
    7d is the useful one, since a mistake discovered inside an hour is rare.
  EOT
  type        = string
  default     = "7d"

  validation {
    condition     = contains(["1h", "7d"], var.firestore_pitr_retention)
    error_message = "firestore_pitr_retention must be 1h or 7d."
  }
}

variable "firestore_backup_retention_days" {
  description = "Retention for the daily Firestore backup schedule (REQ-020 AC-4)."
  type        = number
  default     = 14
}

# -------------------------------------------------------------------- Audit

variable "audit_retention_days" {
  description = <<-EOT
    Retention on the audit log bucket (REQ-018 AC-4). Set to Company's stated
    compliance requirement rather than a default — the default is 30 days, which
    is shorter than any retention obligation worth having the control for.
    Changing this AFTER the lock is applied is impossible by design.
  EOT
  type        = number
  default     = 2555 # seven years
}

variable "audit_bucket_locked" {
  description = <<-EOT
    Whether the audit bucket's retention policy is locked (REQ-018 AC-4, AC-5).

    LOCKING IS IRREVERSIBLE. Once true, the retention period cannot be shortened
    and the bucket cannot be deleted until every entry has aged out — by anyone,
    including a project owner. That is exactly the property the requirement
    asks for, and exactly why it is a variable: a non-production project should
    apply this stack without permanently pinning seven years of logs.
  EOT
  type        = bool
  default     = true
}

variable "audit_mirror_schedule" {
  description = <<-EOT
    Cron for the audit mirror sweep (REQ-018 AC-1). The interval is the window
    in which an audit event exists in Firestore and not yet in the log, so it
    is also the window in which a deletion is undetectable. Shorter is better;
    five minutes is the balance struck here.
  EOT
  type        = string
  default     = "*/5 * * * *"
}

# --------------------------------------------------------------- Application

variable "workspace_customer_id" {
  description = "Workspace customer id for Directory API calls. `my_customer` resolves to the caller's own tenant."
  type        = string
  default     = "my_customer"
}

variable "smtp_sender" {
  description = "The dedicated no-reply Workspace account letters are sent from (REQ-028 AC-2)."
  type        = string
}

variable "smtp_return_path" {
  description = <<-EOT
    Monitored group receiving asynchronous bounces (REQ-028 AC-6). Empty means
    bounces return to the no-reply account, which nobody reads.
  EOT
  type        = string
  default     = ""
}

variable "bootstrap_admins" {
  description = <<-EOT
    Operators granted the admin role before any role binding exists
    (REQ-012). The only way into an empty binding store; every other grant is
    made through the console afterwards.
  EOT
  type        = list(string)
  default     = []
}
