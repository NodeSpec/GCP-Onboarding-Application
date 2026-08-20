# The VPC both services egress through.
#
# The worker takes ingress INTERNAL_LOAD_BALANCER (REQ-026 AC-1), so a request
# arriving from the public internet is refused by Google's front end before it
# reaches the container. That is the control working. It is also, without this
# file, a wall between the API service and the worker's lookup routes: the API
# has to call the worker for every directory picker (REQ-029), and a Cloud Run
# service with no VPC egress makes that call over the public internet like
# anyone else. The refusal is a 404, indistinguishable from a missing route, and
# nothing is logged on the worker because nothing reaches it.
#
# Routing the API's egress through a VPC in this project makes the call arrive
# as internal traffic, so both requirements hold as written rather than one
# quietly defeating the other.
#
# Both services are attached. The API service needs the VPC so its calls to the
# worker's lookup routes arrive as internal traffic. The worker joined later,
# for a different reason: the Workspace SMTP relay judges connections by source
# IP, and a worker egressing from the shared Cloud Run pool presents a
# different, unpredictable address on every attempt. The relay tarpits
# unfamiliar sources with 421 at EHLO, before authentication is ever offered,
# so no credential or relay setting can fix it. Routing the worker through the
# NAT below gives it one reserved, registrable address, which is the hardening
# path REQ-028 records for exactly this failure.

variable "vpc_subnet_cidr" {
  description = <<-EOT
    The subnet both services' egress interfaces are allocated from.

    Direct VPC egress takes one address per running instance, so this has to
    hold both services' max_instance_count with room to spare. A /26 is 64
    addresses against a combined ceiling of 20 instances, which is deliberate
    slack: exhausting the range does not degrade anything, it fails instance
    startup.

    It peers with nothing, so the range only has to avoid colliding with
    anything you might later peer it to.
  EOT
  type        = string
  default     = "10.8.0.0/26"
}

resource "google_compute_network" "lifecycle" {
  project = var.project_id
  name    = "lifecycle"

  # No default subnets. One subnet, in one region, carrying two services.
  auto_create_subnetworks = false

  depends_on = [google_project_service.required]
}

resource "google_compute_subnetwork" "lifecycle" {
  project       = var.project_id
  name          = "lifecycle-${var.region}"
  region        = var.region
  network       = google_compute_network.lifecycle.id
  ip_cidr_range = var.vpc_subnet_cidr

  # Firestore, Secret Manager, Cloud Tasks and Cloud Logging are then reached
  # over Google's own network rather than out through NAT and back. Cheaper, and
  # one less hop that can be observed.
  private_ip_google_access = true
}

# ---------------------------------------------------------------------- NAT
#
# Not decoration. With egress set to ALL_TRAFFIC each service loses its default
# route to the internet. The API service has exactly one destination out there
# that is not a Google API: https://www.gstatic.com/iap/verify/public_key-jwk,
# the JWKS the IAP assertion verifier fetches on a cold start and whenever it
# meets an unfamiliar key id. The worker has one too: the Workspace SMTP relay
# at smtp-relay.gmail.com:587.
#
# Private Google Access covers neither. Without NAT the JWKS fetch hangs, every
# IAP assertion fails to verify, and nobody can sign in; and no welcome letter
# leaves the building.
#
# The NAT translates through one reserved address rather than an auto-allocated
# pool. The address is the worker's identity as far as the SMTP relay is
# concerned: it is registered in the relay's allowed list on the Workspace
# side, which is what stops the relay treating every connection as a stranger.
# Auto-allocation would rotate the address under that registration and
# reintroduce the 421s at the relay's whim.

resource "google_compute_address" "smtp_egress" {
  project = var.project_id
  name    = "lifecycle-egress"
  region  = var.region

  depends_on = [google_project_service.required]
}

resource "google_compute_router" "lifecycle" {
  project = var.project_id
  name    = "lifecycle"
  region  = var.region
  network = google_compute_network.lifecycle.id
}

resource "google_compute_router_nat" "lifecycle" {
  project = var.project_id
  name    = "lifecycle"
  router  = google_compute_router.lifecycle.name
  region  = var.region

  nat_ip_allocate_option = "MANUAL_ONLY"
  nat_ips                = [google_compute_address.smtp_egress.self_link]

  # Scoped to the one subnet rather than to the whole network, so a subnet added
  # later does not silently acquire an internet path by inheriting this.
  source_subnetwork_ip_ranges_to_nat = "LIST_OF_SUBNETWORKS"
  subnetwork {
    name                    = google_compute_subnetwork.lifecycle.id
    source_ip_ranges_to_nat = ["ALL_IP_RANGES"]
  }

  # Errors only. Logging every translation on a service that also talks to
  # Firestore on every request is a volume of logs nobody reads, and the entries
  # that matter are the failures.
  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
