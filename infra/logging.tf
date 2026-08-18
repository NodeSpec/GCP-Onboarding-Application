# The tamper-evident audit copy (REQ-018 AC-3, AC-4, AC-5).
#
# This is where the control actually lives. The application's append-only
# discipline is a property of code, and all Firestore access is through Admin
# SDK credentials that bypass security rules; anything that can run as either
# runtime identity can delete an audit document, and Firestore IAM is
# database-scoped so it cannot be narrowed to stop that.
#
# So the second copy goes somewhere the runtime identities cannot reach: a log
# bucket with a LOCKED retention policy. Locking is irreversible — once applied,
# the retention period cannot be shortened and the bucket cannot be deleted
# until every entry has aged out, by anyone, including a project owner. Nothing
# in this deployment holds a role permitting logging.buckets.update or
# logging.logEntries.delete (see iam.tf), and the lock means even a role granted
# later could not shorten the window.

resource "google_logging_project_bucket_config" "audit" {
  project        = var.project_id
  location       = "global"
  bucket_id      = "lifecycle-audit"
  description    = "Tamper-evident mirror of the Firestore audit trail (REQ-018)."
  retention_days = var.audit_retention_days

  # AC-4. Guarded by a variable because this cannot be undone: a non-production
  # project should be able to apply this stack without pinning years of logs to
  # a project someone will want to delete next week.
  locked = var.audit_bucket_locked
}

locals {
  audit_log_id   = "lifecycle-audit"
  audit_log_name = "projects/${var.project_id}/logs/${local.audit_log_id}"
  audit_log_view = "${google_logging_project_bucket_config.audit.id}/views/_AllLogs"
}

# Routes the mirror's entries into that bucket. Without this the entries land in
# _Default, whose 30-day retention is not a compliance window and is editable by
# anyone with configWriter — that is, the copy would exist and provide no
# tamper-evidence at all.
#
# There is deliberately NO IAM binding for this sink's writer identity, and the
# absence is a fact about Cloud Logging rather than an omission. A sink is
# granted a writer identity only where it routes across a boundary that needs
# one; this sink's destination bucket lives in the same project as the sink, and
# same-project routing requires no grant. The API accordingly returns no writer
# identity, so a roles/logging.bucketWriter binding against it would resolve to
# the empty string and fail the apply outright. Re-adding one will not work.
resource "google_logging_project_sink" "audit" {
  project     = var.project_id
  name        = "lifecycle-audit-to-bucket"
  destination = "logging.googleapis.com/${google_logging_project_bucket_config.audit.id}"

  filter = "logName=\"${local.audit_log_name}\""

  # The entries continue to _Default as well. Cheap, and it means a
  # misconfigured sink is a duplicate rather than a silent loss.
  exclusions {
    name        = "none"
    filter      = "severity < DEBUG"
    description = "Placeholder: nothing is excluded from the audit sink."
  }

  unique_writer_identity = true
}
