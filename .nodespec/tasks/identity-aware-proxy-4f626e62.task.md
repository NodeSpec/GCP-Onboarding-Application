# Task: Identity-Aware Proxy

> **Scope:** implement ONLY this node ("Identity-Aware Proxy"). Work belonging to other nodes appears here solely as interfaces and coordination points — do not implement or re-derive it.
> This document is DERIVED from the NodeSpec model + catalog (fingerprinted, regenerable via generate_task_docs). Node context/export is the model truth; propose model changes through the proposal flow — hand-edits to model facts here do not change the model.

## Component Purpose

**Role:** Auth Provider
**Technology:** Google Identity-Aware Proxy
**Description:** Authentication and identity management service

## Your Deliverable

This service is provisioned, not programmed — no application code implements it (provider-managed, or operated by you if self-hosted).
- **Provisioning configuration (IaC)** — declare the service as config artifacts: existence, sizing, wiring, permissions. The IaC tool is NOT declared on this project's platform container — CONFIRM the tool with the user (Terraform / OpenTofu / Pulumi / provider-native / CDK) before authoring artifacts; do NOT assume one.
- **Connection contracts** for every interface below

## Implementation Context

<!-- AI-AUTHORED SECTION: NodeSpec never writes prose here. Your text survives regeneration verbatim while the derived sections around it keep refreshing. -->
_Not yet authored._ **Consuming AI — author this section BEFORE building.** Working from this full packet plus the repository, record the project-specific context no catalog can know: how this node's technology composes with its neighbors in THIS project, the integration specifics behind each interface contract, configuration rationale, and your intended implementation approach. Replace this placeholder (keep the heading) either by editing this file in the repo and pushing — NodeSpec surfaces the edit as a change card for the user to accept — or via an update_artifact patch through propose_patches. If a REVIEW-NEEDED line appears here later, the derived context changed after you wrote this: re-verify the section, then delete that line.

## Implementation Tasks

Ordered WORK ORDERS synthesized from the model — this node's deliverable kind, contracts, criterion attribution, configuration, and dependency chain. They guarantee coverage, scope, and traceability; they deliberately do NOT contain the implementation detail — that is your job (see the expansion directive below the list).

- [ ] **T1 — Provision Google Identity-Aware Proxy via IaC.**
  Author the provisioning definition as config artifacts bound to this node — existence, wiring, permissions, deployed under Company GCP Project.
  [PLACEHOLDER: config — no user configuration recorded for this node; confirm sizing/domains/settings with the user]
- [ ] **T2 — Expose the interface Lifecycle API Service consumes, per Contract "IAP Assertion Verification (JWK Set)" (rest).**
  Record the endpoint/identifiers Lifecycle API Service needs in this node's config artifacts — coordinate with Lifecycle API Service.
  Build to the contract schema EXACTLY (see Interface Contracts).
- [ ] **T3 — Expose the interface External HTTPS Load Balancer consumes, per Contract "IAP Authorization Check" (rest).**
  Record the endpoint/identifiers External HTTPS Load Balancer needs in this node's config artifacts — coordinate with External HTTPS Load Balancer.
  Build to the contract schema EXACTLY (see Interface Contracts).
- [ ] **T4 — Configure the service to satisfy: "Removing a member from the operator group revokes their access without a redeploy" (REQ-023).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-023 "Removing a member from the operator group revokes their access without a redeploy"
- [ ] **T5 — Configure the service to satisfy: "An account outside the operator group is refused at the perimeter and never reaches the application, confirmed against the deployed environment" (REQ-023).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-023 "An account outside the operator group is refused at the perimeter and never reaches the application, confirmed against the deployed environment"
- [ ] **T6 — Verify every acceptance criterion above and tick its box.**
  Ordering doctrine — plans follow schemas (contract-first TDD): schemas → test plans → implement → verify. Resolve any open [PLACEHOLDER: schema] gap FIRST (get_build_readiness supplies draftInputs; submit the schema via propose_patches update_contract) — test-plan scenarios touching a schemaless contract stay one-line [blocked by schema: …] markers until the schema lands, then the plan refreshes itself.
  AUTOMATED criteria: call get_test_plan for EACH requirement this node serves, implement the plan's test cases, run them, and report every outcome via report_test_results — a passing result flips the criterion's met flag automatically and the response receipt shows which criteria flipped.
  MANUAL criteria (rows marked (manual) above): report_test_results REFUSES to bind them — prove each by ticking its criterion box in this task doc and having the user approve the resulting change card; that approval is the only thing that flips a manual criterion met.
  This node is complete only when every criterion box is ticked and no `[PLACEHOLDER: …]` tag remains open.

**Your first action — expand these work orders.** Each task above guarantees WHAT must be covered, not HOW. Before writing any code or configuration, expand every task with the concrete implementation steps for THIS technology in THIS project — the specific resources, settings, files, schemas, and tests — using the Configuration, Interface Contracts, Technology Guidance, and node context as your references. Record the expanded list in this section via update_artifact (propose_patches) after this doc is accepted, keeping task IDs, criterion citations, and open `[PLACEHOLDER: …]` tags intact. Resolve placeholders with the user through the proposal flow; this node is never complete while one remains open. When the work orders are implemented, verify through the test lane: run get_test_plan for each requirement this node serves, implement and run the plan's tests, and report outcomes via report_test_results — passing results are the evidence that flips criteria met.

### Platform Capability Equivalence

This node is semantically equivalent to a "Google Identity-Aware Proxy" (gcp-identity-aware-proxy) platform_capability node. Treat it as the managed GCP service for spec generation, code scaffolding, and architecture decisions.
- **Equivalent Role:** gcp-identity-aware-proxy (Google Identity-Aware Proxy)
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

### REQ-023: Identity-Aware Proxy provisioning and access grant
Category: technical | Status: in-progress
Owned by the Identity-Aware Proxy node. Provisions IAP on the operator backend service: the OAuth brand and client, the IAM grant that decides which humans may reach the application, and the backend-service audience string the application verifies against. REQ-007 owns the application-side verification code; this requirement owns the perimeter configuration that produces the assertion in the first place. The two must agree on the audience string, and a mismatch is the single most likely cause of a working deployment rejecting every request — so that agreement is asserted here rather than discovered at runtime.

**Acceptance criteria — your task boxes:**
- [x] The OAuth brand and IAP client are provisioned, and the client id is surfaced as a Terraform output rather than copied by hand
  → possible match: Contract "IAP Assertion Verification (JWK Set)" (rest) from Lifecycle API Service (unverified — requirement not mapped to that node)
- [x] roles/iap.httpsResourceAccessor is granted to the operator Google group only — not to individual users, and not to allAuthenticatedUsers
  → possible match: Contract "IAP Assertion Verification (JWK Set)" (rest) from Lifecycle API Service (unverified — requirement not mapped to that node)
- [x] The backend-service audience string is emitted as a Terraform output and consumed by the API service as configuration, so the verifier and the perimeter cannot disagree
  → THIS NODE: internal logic
- [x] IAP is enabled on the operator backend service, and terraform plan reports no drift after apply
  → possible match: Contract "IAP Assertion Verification (JWK Set)" (rest) from Lifecycle API Service (unverified — requirement not mapped to that node)
- [ ] Removing a member from the operator group revokes their access without a redeploy
  → covered by Task T4
- [ ] An account outside the operator group is refused at the perimeter and never reaches the application, confirmed against the deployed environment (manual)
  → covered by Task T5

## Interface Contracts

### RECEIVES FROM: Lifecycle API Service (backend-service)
- **Contract:** IAP Assertion Verification (JWK Set)
- **Protocol:** rest
- **Transport:** http
- **Spec Format:** oauth_oidc
- **Their Technology:** nodejs

**Schema:**
```
{
  "cache": {
    "strategy": "in-memory, keyed by kid",
    "ttlSeconds": 3600,
    "refreshTrigger": "unknown kid, or TTL expiry",
    "onRefreshFailure": "reject the request (401) - never fall back to skipping verification"
  },
  "jwksUri": "https://www.gstatic.com/iap/verify/public_key-jwk",
  "algorithm": "ES256",
  "onFailure": {
    "body": {
      "error": "unauthenticated"
    },
    "status": 401,
    "logging": "reason and source IP only - the raw assertion is never logged"
  },
  "onSuccess": {
    "identity": {
      "email": "claims.email",
      "subject": "claims.sub"
    },
    "placement": "attached to the request context; no route handler may read identity from anywhere else"
  },
  "mustVerify": [
    "signature against the JWK for the token kid",
    "iss === https://cloud.google.com/iap",
    "aud === the exact configured backend-service audience string",
    "exp > now - skew",
    "iat < now + skew"
  ],
  "description": "The application independently verifies the IAP assertion rather than trusting the perimeter. Fail closed on every error path."
}
```

### RECEIVES FROM: External HTTPS Load Balancer (load-balancer)
- **Contract:** IAP Authorization Check
- **Protocol:** rest
- **Transport:** http
- **Their Technology:** gcp-cloud-load-balancing

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

## Technology Guidance

_Reference for executing the Implementation Tasks above — apply where relevant. The task list stands even where this guidance is thin._

**Purpose:** Zero-trust access to applications and VMs without a VPN: IAP sits in front of load-balancer backends, App Engine, or SSH/RDP tunnels and enforces Google identity + context (IAM role, optionally device/context-aware access) per request. The BeyondCorp pattern productized — internal tools get identity-gated on the internet instead of network-gated behind a perimeter.

**Best Practices:**
- Grant access via IAP-secured Web App User on groups, never individuals — access reviews happen at group level
- Verify the signed IAP JWT (x-goog-iap-jwt-assertion) in the backend — defense against header spoofing if anything bypasses the proxy
- Lock backends to only accept traffic from IAP (ingress controls / service perimeter) or the proxy is optional
- Use IAP TCP forwarding for SSH/RDP instead of public IPs or bastion sprawl

**Anti-Patterns to Avoid:**
- Trusting X-Goog-Authenticated-User-* headers without verifying the JWT assertion
- IAP in front while the backend also remains directly reachable — the proxy must be the only path
- Individual-user IAM bindings that turn offboarding into an archaeology project
- Standing a VPN up for one internal dashboard IAP could gate in an afternoon

**Security:** The trust model collapses if backends accept non-IAP traffic: enforce ingress so the proxy is unavoidable, then verify the IAP JWT audience and issuer in the app. Context-aware access levels (device state, IP, geo) attach at the IAM binding — use them for admin surfaces.

**Suggested File Structure:**
- `infra/gcp/iap.tf` (config)

## Dependency Chain

Startup/initialization order based on edge directions and interaction patterns.

**Depends on THIS node being available:**
- Lifecycle API Service (calls this node via IAP Assertion Verification (JWK Set) (rest))
- External HTTPS Load Balancer (calls this node via IAP Authorization Check (rest))

## Error Handling Contracts

**Errors this node MUST emit to consumers:**
- HTTP error responses to Lifecycle API Service ("IAP Assertion Verification (JWK Set)"): return proper 4xx for validation errors, 401/403 for auth failures, 5xx for internal errors with correlation IDs
- HTTP error responses to External HTTPS Load Balancer ("IAP Authorization Check"): return proper 4xx for validation errors, 401/403 for auth failures, 5xx for internal errors with correlation IDs

**Parent Container:** Company GCP Project (gcp)

## Existing Implementation

| File | Kind | Language | Status |
|------|------|----------|--------|
| `infra/iap.tf` | config | --- | draft |
