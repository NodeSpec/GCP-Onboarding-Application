# The two long-lived secrets (REQ-022), and no others.
#
# Both are created EMPTY. No secret value appears in this configuration or in
# Terraform state (AC-2), because a value passed through a variable is written
# to state in plaintext and state is a file people copy around. Versions are
# added out of band; the deployment guide documents how.
#
# Each carries a removal path, because a secret that can never go away is a
# secret nobody ever revisits (REQ-014 AC-8): the SMTP credential disappears if
# the relay is moved to IP allowlisting, and the encryption key disappears if
# credential protection moves to Cloud KMS envelope encryption.

resource "google_secret_manager_secret" "smtp" {
  project   = var.project_id
  secret_id = "notification-smtp-credentials"

  labels = {
    service   = "lifecycle-worker"
    purpose   = "smtp-relay-app-password"
    removable = "by-relay-ip-allowlisting"
  }

  # AC-1: stated, not inherited. `automatic` is what the provider would have
  # chosen, and saying so is the difference between a decision and a default.
  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret" "credential_key" {
  project   = var.project_id
  secret_id = "credential-encryption-key"

  labels = {
    service   = "lifecycle-worker-and-api"
    purpose   = "credential-handoff-data-encryption-key"
    removable = "by-cloud-kms-envelope-encryption"
  }

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

# AC-5, recorded as a decision rather than left to be discovered.
#
# The credential record stores the key VERSION it was encrypted under
# (REQ-019 AC-3), and the worker decrypts with that version rather than with
# `latest`. So a rotation does not strand in-flight ciphertext: records written
# under the old version keep decrypting for as long as that version is enabled.
#
# The drain step is therefore "leave the previous version ENABLED for at least
# the credential TTL (72 hours) after adding a new one, then disable it". This
# is not enforceable in Terraform — versions are added out of band, by design —
# so it lives in the rotation runbook and here, next to the secret it governs.
