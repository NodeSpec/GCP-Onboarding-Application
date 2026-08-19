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

  # The Firestore API expects a protobuf Duration, which must be expressed in
  # seconds with an 's' suffix. An 'h' suffix (retention_days * 24 + "h") is
  # rejected at apply time with "duration must end with s", so the days are
  # converted to seconds here.
  retention = "${var.firestore_backup_retention_days * 24 * 3600}s"

  daily_recurrence {}
}

# ------------------------------------------------------------------- Indexes
#
# One per query the application actually issues (AC-2). Firestore refuses a
# composite query with no matching index at RUNTIME, so a missing index here is
# not a slow list — it is a 500 the first time an operator filters. They are
# declared rather than created from the error message's console link, which is
# how an index ends up in production and not in the repository (AC-5).
#
# Only genuine COMPOSITE indexes belong here. A query ordered on a single field
# (the audit mirror's scan over timestamp) is served by Firestore's automatic
# single-field index, which already tie-breaks on __name__; declaring a
# composite over one field plus __name__ is rejected by the API as unnecessary.
#
# The request list takes three INDEPENDENT filters (phase, status, targetUser),
# each optional, and always sorts on (createdAt desc, requestId desc). That is
# eight combinations, not three, and every one of them is a separate index as far
# as Firestore is concerned. They are all declared below, including the one with
# no filter at all. Two sort fields require a composite index even when nothing
# is filtered, which is the case that is easiest to forget and is also the one
# the console issues the moment it loads.

resource "google_firestore_index" "requests_by_recency" {
  project    = var.project_id
  database   = google_firestore_database.lifecycle.name
  collection = "lifecycleRequests"

  # No filter: the list as it opens. Firestore needs a composite index for any
  # query with more than one sort field, so this is not covered by the automatic
  # single-field indexes, and it is not covered by requests_by_status either,
  # because that one leads with an equality field this query does not supply.
  fields {
    field_path = "createdAt"
    order      = "DESCENDING"
  }
  fields {
    field_path = "requestId"
    order      = "DESCENDING"
  }
}

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

resource "google_firestore_index" "requests_awaiting_approval" {
  project    = var.project_id
  database   = google_firestore_database.lifecycle.name
  collection = "lifecycleRequests"

  # The approvals inbox (REQ-011). Close to requests_by_status above and not the
  # same index: this one orders on updatedAt, because an approver wants the
  # request that most recently stopped, not the one most recently raised. A
  # request created on Monday and halted this morning belongs at the top.
  #
  # It has no requestId tie-break, unlike every other index in this file, and
  # that is not an oversight. The tie-break exists to keep a paging cursor from
  # skipping or repeating a row across pages, and this list does not page: it is
  # one bounded read capped at 100, with no startAfter. Adding a third field
  # would put a column in the index that no query orders on.
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
  fields {
    field_path = "updatedAt"
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

resource "google_firestore_index" "requests_by_phase" {
  project    = var.project_id
  database   = google_firestore_database.lifecycle.name
  collection = "lifecycleRequests"

  # Phase alone. Not served by requests_by_phase_status below: an index that
  # leads on (phase, status) cannot answer a query that supplies phase and
  # leaves status empty, because status is still a field the scan orders on.
  fields {
    field_path = "phase"
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

resource "google_firestore_index" "requests_by_phase_target_user" {
  project    = var.project_id
  database   = google_firestore_database.lifecycle.name
  collection = "lifecycleRequests"

  # Phase and target user, with no status. Reachable from the console because
  # the three filters are independent selects, not one mode switch.
  fields {
    field_path = "phase"
    order      = "ASCENDING"
  }
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

resource "google_firestore_index" "requests_by_phase_status_target_user" {
  project    = var.project_id
  database   = google_firestore_database.lifecycle.name
  collection = "lifecycleRequests"

  # All three at once. The narrowest query the list can issue, and the one an
  # operator reaches by filling in the filter bar rather than by anything the
  # application does on its own.
  fields {
    field_path = "phase"
    order      = "ASCENDING"
  }
  fields {
    field_path = "status"
    order      = "ASCENDING"
  }
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
