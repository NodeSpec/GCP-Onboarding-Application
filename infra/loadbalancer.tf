# The external HTTPS load balancer (REQ-024).
#
# There is exactly ONE backend service in this deployment and it has IAP enabled
# (AC-2, and REQ-007 AC-11). That is not an incidental fact about the current
# shape of the system — it is the property that makes "every operator-facing
# route is behind IAP" checkable rather than asserted. A second backend added
# later would be a second way in, and the infra test asserts the count so adding
# one fails rather than quietly widening the perimeter.
#
# The worker is not attached here at all (AC-5). It has no human callers, so
# putting it behind IAP would add a control with nothing to control.

resource "google_compute_region_network_endpoint_group" "api" {
  project               = var.project_id
  name                  = "lifecycle-api-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.api.name
  }
}

resource "google_compute_backend_service" "api" {
  project = var.project_id
  name    = "lifecycle-api-backend"

  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"

  backend {
    group = google_compute_region_network_endpoint_group.api.id
  }

  # The perimeter. Everything in this file exists to make sure there is no path
  # to the application that does not pass through here.
  iap {
    enabled              = true
    oauth2_client_id     = google_iap_client.console.client_id
    oauth2_client_secret = google_iap_client.console.secret
  }

  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

resource "google_compute_url_map" "console" {
  project         = var.project_id
  name            = "lifecycle-console"
  default_service = google_compute_backend_service.api.id
}

resource "google_compute_managed_ssl_certificate" "console" {
  project = var.project_id
  name    = "lifecycle-console-cert"

  managed {
    domains = [var.domain]
  }
}

resource "google_compute_target_https_proxy" "console" {
  project          = var.project_id
  name             = "lifecycle-console-https"
  url_map          = google_compute_url_map.console.id
  ssl_certificates = [google_compute_managed_ssl_certificate.console.id]
}

resource "google_compute_global_address" "console" {
  project = var.project_id
  name    = "lifecycle-console-ip"
}

resource "google_compute_global_forwarding_rule" "https" {
  project = var.project_id
  name    = "lifecycle-console-https"

  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.console.id
  ip_address            = google_compute_global_address.console.id
  port_range            = "443"
}

# ------------------------------------------------------------ HTTP redirect
#
# AC-4: port 80 redirects and serves nothing. An operator who types the bare
# hostname must not reach a plaintext response — and, more to the point, must
# not reach a response at all before IAP has seen them.

resource "google_compute_url_map" "redirect" {
  project = var.project_id
  name    = "lifecycle-console-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  project = var.project_id
  name    = "lifecycle-console-http"
  url_map = google_compute_url_map.redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  project = var.project_id
  name    = "lifecycle-console-http"

  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_http_proxy.redirect.id
  ip_address            = google_compute_global_address.console.id
  port_range            = "80"
}
