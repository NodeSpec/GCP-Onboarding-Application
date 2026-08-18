# Firestore: the system's durable state and its audit trail (REQ-020).
#
# There is no security rules file anywhere in this deployment, and its absence
# is deliberate rather than an omission (AC-6). Both services reach Firestore
# through the Admin SDK, which bypasses security rules entirely — rules govern
# client SDK access, and no client SDK touches this database. Shipping a rules
# file would create a document that appears to constrain access and constrains
# nothing, which is worse than having none. The real boundary between the two
# services' writes is in the data access layer (REQ-014), and the tamper-evidence
# control over the audit trail is the Cloud Logging mirror (REQ-018), precisely
# because Firestore IAM is database-scoped and cannot express either.

resource "google_firestore_database" "lifecycle" {
  project     = var.project_id
  name        = "(default)"
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"

  # AC-4: recovery for the case this control exists for — an operator or a bug
  # writing something wrong, noticed later.
  point_in_time_recovery_enablement = var.firestore_pitr_retention == "7d" ? "POINT_IN_TIME_RECOVERY_ENABLED" : "POINT_IN_TIME_RECOVERY_DISABLED"

  # Deleting this database deletes every request, step and audit event in the
  # system. `ABANDON` leaves it standing when the stack is destroyed.
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"

  depends_on = [google_project_service.required]
}

resource "google_firestore_backup_schedule" "daily" {
  project  = var.project_id
  database = google_firestore_database.lifecycle.name

  retention = "${var.firestore_backup_retention_days * 24}h"

  daily_recurrence {}
}

# ------------------------------------------------------------------- Indexes
#
# One per query the application actually issues (AC-2). Firestore refuses a
# composite query with no matching index at RUNTIME, so a missing index here is
# not a slow list — it is a 500 the first time an operator filters. They are
# declared rather than created from the error message's console link, which is
# how an index ends up in production and not in the repository (AC-5).

resource "google_firestore_index" "requests_by_status" {
  project    = var.project_id
  database   = google_firestore_database.lifecycle.name
  collection = "lifecycleRequests"

  # The console's default list: newest first, optionally narrowed by status.
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }
  fields {
    field_path = "requestId"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "requests_by_target_user" {
  project    = var.project_id
  database   = google_firestore_database.lifecycle.name
  collection = "lifecycleRequests"

  # "What has happened to this person's account" — the question asked whenever
  # anyone investigates an account, and the reason targetUser is indexed twice.
  fields {
    field_path = "targetUser"
    order      = "ASCENDING"
  }
  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }
  fields {
    field_path = "requestId"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "requests_by_phase_status" {
  project    = var.project_id
  database   = google_firestore_database.lifecycle.name
  collection = "lifecycleRequests"

  fields {
    field_path = "phase"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }
  fields {
    field_path = "requestId"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "requests_by_target_user_status" {
  project    = var.project_id
  database   = google_firestore_database.lifecycle.name
  collection = "lifecycleRequests"

  # Backs the conflicting-request admission check (REQ-001): is anything
  # non-terminal already in flight against this account?
  fields {
    field_path = "targetUser"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }
  fields {
    field_path = "requestId"
    order      = "DESCENDING"
  }
}

resource "google_firestore_index" "audit_by_request" {
  project    = var.project_id
  database   = google_firestore_database.lifecycle.name
  collection = "auditEvents"

  # ASCENDING on timestamp, unlike the request lists: an audit trail is read
  # forwards, as the sequence of what happened.
  fields {
    field_path = "requestId"
    order      = "ASCENDING"
  }
  fields {
    field_path = "timestamp"
    order      = "ASCENDING"
  }
}

resource "google_firestore_index" "audit_by_timestamp" {
  project     = var.project_id
  database    = google_firestore_database.lifecycle.name
  collection  = "auditEvents"
  query_scope = "COLLECTION"

  # The audit mirror sweeps in commit order, and reconciliation reads a window
  # (REQ-018). Both are ordered scans over this field alone.
  fields {
    field_path = "timestamp"
    order      = "ASCENDING"
  }
  fields {
    field_path = "__name__"
    order      = "ASCENDING"
  }
}

# ----------------------------------------------------------------------- TTL
#
# AC-3, and REQ-019 AC-4. The credential record holds the ciphertext of a real
# person's initial password. Its removal is the last line of defence if nobody
# ever retrieves it: the application deletes on retrieval (REQ-017 AC-2), and
# this deletes when nobody does. Firestore performs it, so it happens whether or
# not the application is running or correct.

resource "google_firestore_field" "credential_ttl" {
  project    = var.project_id
  database   = google_firestore_database.lifecycle.name
  collection = "credentialHandoffs"
  field      = "expiresAt"

  ttl_config {}
}
