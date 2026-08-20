# What a deployment needs to know, and what the application reads.
#
# Every value the services consume is wired from these rather than typed into a
# configuration file (REQ-021 AC-6, REQ-025 AC-4). The audience is the one that
# fails hardest when hand-copied: the verifier compares it exactly, so a drifted
# value rejects every assertion and produces a console nobody can sign in to,
# with nothing in any log saying why.

output "console_url" {
  description = "Where operators reach the console. DNS for the domain must point at console_ip."
  value       = "https://${var.domain}"
}

output "console_ip" {
  description = "The load balancer's global address. Create the A record for var.domain against this."
  value       = google_compute_global_address.console.address
}

output "iap_audience" {
  description = "The exact audience string the API service verifies IAP assertions against (REQ-023 AC-3)."
  value       = local.iap_audience
}

output "iap_client_id" {
  description = "IAP OAuth client id (REQ-023 AC-1), surfaced rather than copied by hand."
  value       = google_iap_client.console.client_id
}

output "api_service_url" {
  description = "The API service's own URL. Unreachable directly: ingress admits only the load balancer."
  value       = google_cloud_run_v2_service.api.uri
}

output "worker_service_url" {
  description = "The worker's URL, and the OIDC audience Cloud Tasks mints tokens for (REQ-021 AC-4)."
  value       = google_cloud_run_v2_service.worker.uri
}

output "tasks_queue" {
  description = "The step queue's name (REQ-021 AC-6)."
  value       = google_cloud_tasks_queue.lifecycle_steps.name
}

output "api_service_account" {
  description = "The operator surface's runtime identity. Holds no Workspace admin role."
  value       = google_service_account.api.email
}

output "worker_service_account" {
  description = <<-EOT
    The worker's runtime identity. This is the email to assign the custom
    Workspace admin role to, under Account > Admin roles > Assign service
    accounts (REQ-027 AC-4). No Domain-Wide Delegation is configured for it, and
    none should be.
  EOT
  value       = google_service_account.worker.email
}

output "queue_invoker_service_account" {
  description = "The identity Cloud Tasks dispatches as, and one of exactly two principals admitted by the worker."
  value       = google_service_account.queue_invoker.email
}

output "audit_log_name" {
  description = "The log the audit mirror writes to (REQ-018 AC-1)."
  value       = local.audit_log_name
}

output "audit_log_view" {
  description = "The bucket view reconciliation reads the mirrored copy back through (REQ-018 AC-2)."
  value       = local.audit_log_view
}

output "smtp_secret" {
  description = "Secret Manager name for the relay app password. Created empty; populate out of band."
  value       = google_secret_manager_secret.smtp.id
}

output "credential_key_secret" {
  description = "Secret Manager name for the credential encryption key. Created empty; populate out of band."
  value       = google_secret_manager_secret.credential_key.id
}

output "smtp_egress_ip" {
  description = "The reserved address all outbound traffic leaves through. Register it in the Workspace SMTP relay's allowed IP list; the relay stops tarpitting the worker's connections once the source is known."
  value       = google_compute_address.smtp_egress.address
}
