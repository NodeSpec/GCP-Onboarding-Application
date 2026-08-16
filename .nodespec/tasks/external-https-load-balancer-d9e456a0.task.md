# Task: External HTTPS Load Balancer

> **Scope:** implement ONLY this node ("External HTTPS Load Balancer"). Work belonging to other nodes appears here solely as interfaces and coordination points — do not implement or re-derive it.
> This document is DERIVED from the NodeSpec model + catalog (fingerprinted, regenerable via generate_task_docs). Node context/export is the model truth; propose model changes through the proposal flow — hand-edits to model facts here do not change the model.

## Component Purpose

**Role:** Load Balancer
**Technology:** Google Cloud Load Balancing
**Description:** Traffic distribution across service instances

## Your Deliverable

This service is provisioned, not programmed — no application code implements it (provider-managed, or operated by you if self-hosted).
- **Provisioning configuration (IaC)** — declare the service as config artifacts: existence, sizing, wiring, permissions. The IaC tool is NOT declared on this project's platform container — CONFIRM the tool with the user (Terraform / OpenTofu / Pulumi / provider-native / CDK) before authoring artifacts; do NOT assume one.
- **Connection contracts** for every interface below

## Implementation Context

<!-- AI-AUTHORED SECTION: NodeSpec never writes prose here. Your text survives regeneration verbatim while the derived sections around it keep refreshing. -->
_Not yet authored._ **Consuming AI — author this section BEFORE building.** Working from this full packet plus the repository, record the project-specific context no catalog can know: how this node's technology composes with its neighbors in THIS project, the integration specifics behind each interface contract, configuration rationale, and your intended implementation approach. Replace this placeholder (keep the heading) either by editing this file in the repo and pushing — NodeSpec surfaces the edit as a change card for the user to accept — or via an update_artifact patch through propose_patches. If a REVIEW-NEEDED line appears here later, the derived context changed after you wrote this: re-verify the section, then delete that line.

## Implementation Tasks

Ordered WORK ORDERS synthesized from the model — this node's deliverable kind, contracts, criterion attribution, configuration, and dependency chain. They guarantee coverage, scope, and traceability; they deliberately do NOT contain the implementation detail — that is your job (see the expansion directive below the list).

- [ ] **T1 — Provision Google Cloud Load Balancing via IaC.**
  Author the provisioning definition as config artifacts bound to this node — existence, wiring, permissions, deployed under Company GCP Project.
  [PLACEHOLDER: config — no user configuration recorded for this node; confirm sizing/domains/settings with the user]
- [ ] **T2 — Declare the wiring to Identity-Aware Proxy (gcp-identity-aware-proxy) per Contract "IAP Authorization Check" (rest).**
  Build to the contract schema EXACTLY (see Interface Contracts).
  ↳ serves (unverified match): REQ-024 "Exactly one backend service exists in the deployment, and it has IAP enabled — asserted in Terraform so an added backend fails the check" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T3 — Declare the wiring to Lifecycle API Service (nodejs) per Contract "IAP-Protected HTTPS Ingress" (rest).**
  Build to the contract schema EXACTLY (see Interface Contracts).
  ↳ serves (unverified match): REQ-024 "HTTP requests are redirected to HTTPS rather than served" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T4 — Configure the service to satisfy: "A serverless NEG targets the lifecycle-api Cloud Run service and is attached to the backend service" (REQ-024).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-024 "A serverless NEG targets the lifecycle-api Cloud Run service and is attached to the backend service"
- [ ] **T5 — Configure the service to satisfy: "A Google-managed TLS certificate is provisioned and attached, with the domain supplied as a variable" (REQ-024).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-024 "A Google-managed TLS certificate is provisioned and attached, with the domain supplied as a variable"
- [ ] **T6 — Configure the service to satisfy: "The worker Cloud Run service is not attached to this load balancer, verified by asserting the backend set contains only the api service" (REQ-024).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-024 "The worker Cloud Run service is not attached to this load balancer, verified by asserting the backend set contains only the api service"
- [ ] **T7 — Configure the service to satisfy: "The load balancer's service identity is the only principal granted run.invoker on the lifecycle-api service" (REQ-024).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-024 "The load balancer's service identity is the only principal granted run.invoker on the lifecycle-api service"
- [ ] **T8 — Verify every acceptance criterion above and tick its box.**
  Ordering doctrine — plans follow schemas (contract-first TDD): schemas → test plans → implement → verify. Resolve any open [PLACEHOLDER: schema] gap FIRST (get_build_readiness supplies draftInputs; submit the schema via propose_patches update_contract) — test-plan scenarios touching a schemaless contract stay one-line [blocked by schema: …] markers until the schema lands, then the plan refreshes itself.
  AUTOMATED criteria: call get_test_plan for EACH requirement this node serves, implement the plan's test cases, run them, and report every outcome via report_test_results — a passing result flips the criterion's met flag automatically and the response receipt shows which criteria flipped.
  MANUAL criteria (rows marked (manual) above): report_test_results REFUSES to bind them — prove each by ticking its criterion box in this task doc and having the user approve the resulting change card; that approval is the only thing that flips a manual criterion met.
  This node is complete only when every criterion box is ticked and no `[PLACEHOLDER: …]` tag remains open.

**Your first action — expand these work orders.** Each task above guarantees WHAT must be covered, not HOW. Before writing any code or configuration, expand every task with the concrete implementation steps for THIS technology in THIS project — the specific resources, settings, files, schemas, and tests — using the Configuration, Interface Contracts, Technology Guidance, and node context as your references. Record the expanded list in this section via update_artifact (propose_patches) after this doc is accepted, keeping task IDs, criterion citations, and open `[PLACEHOLDER: …]` tags intact. Resolve placeholders with the user through the proposal flow; this node is never complete while one remains open. When the work orders are implemented, verify through the test lane: run get_test_plan for each requirement this node serves, implement and run the plan's tests, and report outcomes via report_test_results — passing results are the evidence that flips criteria met.

### Platform Capability Equivalence

This node is semantically equivalent to a "Google Cloud Load Balancing" (gcp-cloud-load-balancing) platform_capability node. Treat it as the managed GCP service for spec generation, code scaffolding, and architecture decisions.
- **Equivalent Role:** gcp-cloud-load-balancing (Google Cloud Load Balancing)
- **Provider:** gcp

## Project Context

Company wants an application that supports the full user lifecycle in four phases:

1. User creation, including assignment of attributes and groups
2. Notifying the user of their new account with a welcome letter and initial password setting instructions
3. Updating a user's roles/attributes over time
4. Account deletion

Scope and constraints as stated by the customer:

- The application should only worry about one IDP for now — Google Workspace.
- All of the steps in account creation must be stateful and have optional two-party approval features.
- The application should run serverless — Cloud Run on GCP.
- Because it uses Google Workspace, the app must include instructions on how to configure a GCP service account to have admin permissions in Workspace WITHOUT using Domain-Wide Delegation.
- The serverless application must be protected by IAP, and must include code to verify the IAP JWT header so the security controls cannot be bypassed by reaching the service directly.

The product is an internal, operator-facing lifecycle console: an IAP-protected web UI plus an API where a requester drafts a lifecycle action, an optional second approver signs off, and a durable state machine executes the Workspace changes step by step — every step resumable, auditable, and idempotent, so a partially-completed onboarding is never left in an unknown state.

## Requirements — Your Scope

### REQ-024: External HTTPS load balancer provisioning
Category: technical | Status: in-progress
Owned by the External HTTPS Load Balancer node. Provisions the single ingress path into the system: the serverless NEG pointing at the lifecycle-api Cloud Run service, exactly one backend service, a Google-managed TLS certificate, and an HTTP-to-HTTPS redirect. The invariant this node must hold is that there is one backend and it has IAP enabled — the architecture briefly carried a second, unauthenticated backend and that was reverted to honour the customer's IAP constraint, so the count is asserted rather than assumed.

**Acceptance criteria — your task boxes:**
- [ ] A serverless NEG targets the lifecycle-api Cloud Run service and is attached to the backend service
  → covered by Task T4
- [ ] Exactly one backend service exists in the deployment, and it has IAP enabled — asserted in Terraform so an added backend fails the check
  → covered by Task T2
- [ ] A Google-managed TLS certificate is provisioned and attached, with the domain supplied as a variable
  → covered by Task T5
- [ ] HTTP requests are redirected to HTTPS rather than served
  → covered by Task T3
- [ ] The worker Cloud Run service is not attached to this load balancer, verified by asserting the backend set contains only the api service
  → covered by Task T6
- [ ] The load balancer's service identity is the only principal granted run.invoker on the lifecycle-api service
  → covered by Task T7

## Interface Contracts

### SENDS TO: Identity-Aware Proxy (auth-provider)
- **Contract:** IAP Authorization Check
- **Protocol:** rest
- **Transport:** http
- **Their Technology:** gcp-identity-aware-proxy

**Schema:**
```
{
  "notes": "IAP is the perimeter. The application still verifies the assertion independently (see IAP Assertion Verification) so that a perimeter bypass is not a security bypass.",
  "onDeny": "IAP returns 403 and the request never reaches Cloud Run",
  "onAllow": "IAP forwards the request with an added x-goog-iap-jwt-assertion header",
  "enforcedAt": "load-balancer backend service",
  "description": "Identity-Aware Proxy evaluates every request reaching the backend service before it is forwarded to Cloud Run. Configured on the backend service, not in application code.",
  "allowedPrincipals": "IAM role roles/iap.httpsResourceAccessor granted to the operator Google group only"
}
```

### SENDS TO: Lifecycle API Service (backend-service)
- **Contract:** IAP-Protected HTTPS Ingress
- **Protocol:** rest
- **Transport:** http
- **Their Technology:** nodejs

**Schema:**
```
{
  "invariant": "EVERY backend service in this deployment has IAP enabled. There is no exception and no carve-out. The system has no end-user-facing surface at all: people being onboarded never touch this application - they receive a letter and use Google's own sign-in and password-change flow. Any future feature requiring an unauthenticated route is a change to REQ-007 and needs the customer's agreement before it is designed.",
  "description": "The only network path into the application. External HTTPS load balancer -> serverless NEG -> Cloud Run. ONE backend service, IAP enabled on it. There is no second backend and no unauthenticated path.",
  "workerIngress": {
    "note": "lifecycle-worker is NOT attached to this load balancer and is therefore not IAP-protected - deliberately, because it has no human ingress path.",
    "controls": [
      "ingress internal-and-cloud-load-balancing",
      "run.invoker granted only to the Cloud Tasks queue invoker service account",
      "a valid OIDC token required on every request"
    ]
  },
  "requestHeaders": {
    "x-goog-iap-jwt-assertion": {
      "type": "string",
      "claims": {
        "aud": "/projects/{PROJECT_NUMBER}/global/backendServices/{BACKEND_SERVICE_ID}",
        "exp": "expiry, checked with configurable skew (default 30s)",
        "iat": "issued-at, checked with configurable skew",
        "iss": "https://cloud.google.com/iap",
        "sub": "stable Google account subject identifier",
        "email": "verified operator identity"
      },
      "required": true,
      "description": "ES256 JWT signed by IAP. Absence is a hard 401 from the application."
    },
    "x-goog-authenticated-user-email": {
      "type": "string",
      "required": false,
      "description": "Convenience header. NEVER trusted for identity - present for debugging only."
    }
  },
  "backendServices": {
    "operator-backend": {
      "iap": "ENABLED - roles/iap.httpsResourceAccessor granted to the operator group only",
      "routes": "all application routes",
      "target": "Cloud Run lifecycle-api",
      "invoker": "roles/run.invoker granted only to the load balancer service identity",
      "cloudRunIngress": "internal-and-cloud-load-balancing",
      "applicationCheck": "independently verifies the IAP assertion on every request - see IAP Assertion Verification"
    }
  }
}
```

## Technology Guidance

_Reference for executing the Implementation Tasks above — apply where relevant. The task list stands even where this guidance is thin._

**Purpose:** Cloud Load Balancing is Google Cloud's fully managed load balancing platform for distributing application and network traffic across backends using global or regional configurations. Use it for highly available ingress, cross-region failover, health-checked traffic steering, and Layer 4 or Layer 7 distribution in front of applications and services. Choose Cloud Load Balancing over Cloud DNS when you need active health-based traffic distribution instead of simple name resolution, and over Apigee when the primary need is traffic steering rather than API product governance. Do not use it as a service mesh for east-west traffic or as a substitute for API lifecycle management and developer portal capabilities.

**Configuration Template:**
```
gcloud compute backend-services create web-backend --global \
  --protocol=HTTPS --port-name=https --health-checks=web-hc
gcloud compute url-maps create web-map --default-service=web-backend
gcloud compute target-https-proxies create web-proxy --url-map=web-map \
  --certificate-map=web-certs
gcloud compute forwarding-rules create web-fr --global \
  --target-https-proxy=web-proxy --ports=443
```

**Best Practices:**
- Choose the load balancer type based on protocol, scope, and whether you need Layer 4 or Layer 7 behavior
- Use health checks that reflect true backend readiness rather than only port reachability
- Separate public and internal load balancing patterns based on network boundary and service exposure
- Use backend services and URL maps intentionally to preserve clear ownership and routing logic
- Monitor backend latency, unhealthy instances, and failover behavior as part of standard operations
- Pair internet-facing application load balancers with Cloud Armor and optional Cloud CDN where appropriate
- Model backend groups around service boundaries instead of mixing unrelated workloads behind one frontend

**Anti-Patterns to Avoid:**
- Using Cloud Load Balancing as a replacement for API management policies and consumer governance
- Treating DNS-only routing as equivalent to health-checked traffic distribution
- Using one oversized load balancer configuration for unrelated domains with conflicting routing needs
- Relying on default health checks that do not reflect real application readiness
- Ignoring internal versus external traffic boundaries and overexposing services unintentionally
- Using load balancing alone to solve service-to-service identity and east-west networking concerns

**Security:** HTTPS frontends with Google-managed certificates and a modern SSL policy — plaintext production listeners are a choice, not a default. Backends should accept traffic only from the load balancer path (firewall to Google front-end ranges or use IAP), attach Cloud Armor to every internet-facing backend service, and enable request logging on the backend service — the LB log is your edge forensic record.

**Suggested File Structure:**
- `network/load-balancer.yaml` (config)
- `network/url-maps.yaml` (config)
- `infra/cloud-load-balancing.yaml` (config)

## Dependency Chain

Startup/initialization order based on edge directions and interaction patterns.

**Must be available BEFORE this node starts:**
- Identity-Aware Proxy (this node calls/depends on it via IAP Authorization Check (rest))
- Lifecycle API Service (this node calls/depends on it via IAP-Protected HTTPS Ingress (rest))

## Error Handling Contracts

**Errors this node MUST handle from dependencies:**
- HTTP errors from Identity-Aware Proxy ("IAP Authorization Check"): handle 4xx (client error), 5xx (server error), timeouts, and connection refused
- HTTP errors from Lifecycle API Service ("IAP-Protected HTTPS Ingress"): handle 4xx (client error), 5xx (server error), timeouts, and connection refused

**Parent Container:** Company GCP Project (gcp)
