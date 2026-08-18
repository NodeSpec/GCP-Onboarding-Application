# Task: Company GCP Project

> **Scope:** implement ONLY this node ("Company GCP Project"). Work belonging to other nodes appears here solely as interfaces and coordination points — do not implement or re-derive it.
> This document is DERIVED from the NodeSpec model + catalog (fingerprinted, regenerable via generate_task_docs). Node context/export is the model truth; propose model changes through the proposal flow — hand-edits to model facts here do not change the model.

## Component Purpose

**Role:** Google Cloud
**Technology:** Google Cloud Platform
**Description:** Google Cloud Platform providing compute, storage, messaging, and database services

## Your Deliverable

This container provisions the runtime context for the components inside it — no application code implements the container itself.
- **Provisioning configuration (IaC)** — declare the service as config artifacts: existence, sizing, wiring, permissions. The IaC tool is NOT declared on this project's platform container — CONFIRM the tool with the user (Terraform / OpenTofu / Pulumi / provider-native / CDK) before authoring artifacts; do NOT assume one.
- **Connection contracts** for every interface below

## Implementation Context

<!-- AI-AUTHORED SECTION: NodeSpec never writes prose here. Your text survives regeneration verbatim while the derived sections around it keep refreshing. -->
_Not yet authored._ **Consuming AI — author this section BEFORE building.** Working from this full packet plus the repository, record the project-specific context no catalog can know: how this node's technology composes with its neighbors in THIS project, the integration specifics behind each interface contract, configuration rationale, and your intended implementation approach. Replace this placeholder (keep the heading) either by editing this file in the repo and pushing — NodeSpec surfaces the edit as a change card for the user to accept — or via an update_artifact patch through propose_patches. If a REVIEW-NEEDED line appears here later, the derived context changed after you wrote this: re-verify the section, then delete that line.

## Implementation Tasks

Ordered WORK ORDERS synthesized from the model — this node's deliverable kind, contracts, criterion attribution, configuration, and dependency chain. They guarantee coverage, scope, and traceability; they deliberately do NOT contain the implementation detail — that is your job (see the expansion directive below the list).

- [ ] **T1 — Provision Google Cloud Platform via IaC.**
  Author the provisioning definition as config artifacts bound to this node — existence, wiring, permissions.
  [PLACEHOLDER: config — no user configuration recorded for this node; confirm sizing/domains/settings with the user]
- [ ] **T2 — Account for every hosted component in this container's definition.**
  Hosted here: Firestore: lifecycle state and audit, Identity-Aware Proxy, Cloud Logging: audit sink, Cloud Tasks: lifecycle-steps, Cloud Run: lifecycle-api, External HTTPS Load Balancer, Cloud Run: lifecycle-worker, Secret Manager.
  Each hosted component must be represented in the provisioning definition (compose service entry / subnet placement / deployment target, as appropriate for this container).
- [ ] **T3 — Configure the service to satisfy: "Every required document exists at its documented path and states the system version it describes: workspace-admin-setup.md, deployment.md, approval-policy.md, runbook.md, architecture.md" (REQ-015).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-015 "Every required document exists at its documented path and states the system version it describes: workspace-admin-setup.md, deployment.md, approval-policy.md, runbook.md, architecture.md"
- [ ] **T4 — Configure the service to satisfy: "docs/deployment.md covers project prerequisites, API enablement, Terraform apply, IAP OAuth brand/client setup, and granting operator access" (REQ-015).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-015 "docs/deployment.md covers project prerequisites, API enablement, Terraform apply, IAP OAuth brand/client setup, and granting operator access"
- [ ] **T5 — Configure the service to satisfy: "docs/approval-policy.md documents every policy knob with a fully-automated example and a fully-two-party example" (REQ-015).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-015 "docs/approval-policy.md documents every policy knob with a fully-automated example and a fully-two-party example"
- [ ] **T6 — Configure the service to satisfy: "docs/runbook.md covers diagnosing a stuck request, resuming it, cancelling it (including that cancellation dispatches a compensating unsuspend step), and the meaning of each step error class" (REQ-015).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-015 "docs/runbook.md covers diagnosing a stuck request, resuming it, cancelling it (including that cancellation dispatches a compensating unsuspend step), and the meaning of each step error class"
- [ ] **T7 — Configure the service to satisfy: "docs/architecture.md names every component, the trust boundaries, and what data each store holds — including that the credential record holds ciphertext rather than a hash, and why" (REQ-015).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-015 "docs/architecture.md names every component, the trust boundaries, and what data each store holds — including that the credential record holds ciphertext rather than a hash, and why"
- [ ] **T8 — Configure the service to satisfy: "The scope interpretation of the customer's word "roles" is documented for the customer to confirm or correct: that it is read as group membership plus role-describing attributes, that Workspace admin-role assignment is excluded, and that the exclusion exists because role-management privilege would let the service account mint Super Admins" (REQ-015).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-015 "The scope interpretation of the customer's word "roles" is documented for the customer to confirm or correct: that it is read as group membership plus role-describing attributes, that Workspace admin-role assignment is excluded, and that the exclusion exists because role-management privilege would let the service account mint Super Admins"
- [ ] **T9 — Configure the service to satisfy: "An engineer new to the repository reaches a working, IAP-protected deployment following only these documents" (REQ-015).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-015 "An engineer new to the repository reaches a working, IAP-protected deployment following only these documents"
- [ ] **T10 — Configure the service to satisfy: "terraform validate and terraform plan succeed against the committed configuration with no manual resource references" (REQ-009).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-009 "terraform validate and terraform plan succeed against the committed configuration with no manual resource references"
- [ ] **T11 — Configure the service to satisfy: "A from-scratch apply into an empty GCP project produces a reachable, IAP-protected endpoint following only the documented steps" (REQ-009).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-009 "A from-scratch apply into an empty GCP project produces a reachable, IAP-protected endpoint following only the documented steps"
- [ ] **T12 — Configure the service to satisfy: "The worker's runtime identity is the only one holding the Workspace admin role, and the API service's identity holds no Workspace admin role — verified by attempting a Directory API call with the API service's identity and observing it refused" (REQ-014).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-014 "The worker's runtime identity is the only one holding the Workspace admin role, and the API service's identity holds no Workspace admin role — verified by attempting a Directory API call with the API service's identity and observing it refused"
- [ ] **T13 — Configure the service to satisfy: "Rotating a secret version is picked up without redeploying the service" (REQ-014).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-014 "Rotating a secret version is picked up without redeploying the service"
- [ ] **T14 — Verify every acceptance criterion above and tick its box.**
  Ordering doctrine — plans follow schemas (contract-first TDD): schemas → test plans → implement → verify. Resolve any open [PLACEHOLDER: schema] gap FIRST (get_build_readiness supplies draftInputs; submit the schema via propose_patches update_contract) — test-plan scenarios touching a schemaless contract stay one-line [blocked by schema: …] markers until the schema lands, then the plan refreshes itself.
  AUTOMATED criteria: call get_test_plan for EACH requirement this node serves, implement the plan's test cases, run them, and report every outcome via report_test_results — a passing result flips the criterion's met flag automatically and the response receipt shows which criteria flipped.
  MANUAL criteria (rows marked (manual) above): report_test_results REFUSES to bind them — prove each by ticking its criterion box in this task doc and having the user approve the resulting change card; that approval is the only thing that flips a manual criterion met.
  This node is complete only when every criterion box is ticked and no `[PLACEHOLDER: …]` tag remains open.

**Your first action — expand these work orders.** Each task above guarantees WHAT must be covered, not HOW. Before writing any code or configuration, expand every task with the concrete implementation steps for THIS technology in THIS project — the specific resources, settings, files, schemas, and tests — using the Configuration, Interface Contracts, Technology Guidance, and node context as your references. Record the expanded list in this section via update_artifact (propose_patches) after this doc is accepted, keeping task IDs, criterion citations, and open `[PLACEHOLDER: …]` tags intact. Resolve placeholders with the user through the proposal flow; this node is never complete while one remains open. When the work orders are implemented, verify through the test lane: run get_test_plan for each requirement this node serves, implement and run the plan's tests, and report outcomes via report_test_results — passing results are the evidence that flips criteria met.

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

### REQ-015: Deployment, configuration, and operations documentation
Category: business | Status: in-progress
The deliverable includes documentation sufficient for an engineer at Company who has never seen the repository to stand the system up and run it. This requirement owns the documentation SET — that each document exists, is versioned against the system it describes, and is verified against a real deployment before release. Where another requirement owns a document's content, this one does not restate it: docs/workspace-admin-setup.md is specified by REQ-027, and the approval-policy knobs by REQ-002. Required documents: the Workspace admin configuration guide; a GCP deployment guide covering project prerequisites, API enablement, Terraform apply, the IAP OAuth brand/client setup and the operator-access grant; an approval-policy reference with worked examples; an operations runbook covering stuck, resumed and cancelled requests and each step error class; and an architecture overview naming each component, the trust boundaries, and the data stored in each store.

**Acceptance criteria — your task boxes:**
- [ ] Every required document exists at its documented path and states the system version it describes: workspace-admin-setup.md, deployment.md, approval-policy.md, runbook.md, architecture.md (manual)
  → covered by Task T3
- [ ] docs/deployment.md covers project prerequisites, API enablement, Terraform apply, IAP OAuth brand/client setup, and granting operator access (manual)
  → covered by Task T4
- [ ] docs/approval-policy.md documents every policy knob with a fully-automated example and a fully-two-party example (manual)
  → covered by Task T5
- [ ] docs/runbook.md covers diagnosing a stuck request, resuming it, cancelling it (including that cancellation dispatches a compensating unsuspend step), and the meaning of each step error class (manual)
  → covered by Task T6
- [ ] docs/architecture.md names every component, the trust boundaries, and what data each store holds — including that the credential record holds ciphertext rather than a hash, and why (manual)
  → covered by Task T7
- [ ] The scope interpretation of the customer's word "roles" is documented for the customer to confirm or correct: that it is read as group membership plus role-describing attributes, that Workspace admin-role assignment is excluded, and that the exclusion exists because role-management privilege would let the service account mint Super Admins (manual)
  → covered by Task T8
- [ ] An engineer new to the repository reaches a working, IAP-protected deployment following only these documents (manual)
  → covered by Task T9

### REQ-009: Serverless deployment on Cloud Run with infrastructure as code
Category: technical | Status: in-progress
The whole system runs serverless — no VMs, no clusters, no always-on instances. The API/console service and the step-executor worker are containerized and deployed as Cloud Run services that scale to zero; durable state is Firestore; step dispatch is Cloud Tasks; secrets are Secret Manager. The entire deployment — Cloud Run services and their runtime service accounts, the external HTTPS load balancer and serverless NEG, IAP enablement and its OAuth brand/client, Firestore database and indexes, Cloud Tasks queue with its retry configuration, Secret Manager secrets, and every IAM binding — is expressed as Terraform in the repository and applies cleanly to an empty project. The two Cloud Run services use separate runtime service accounts so the operator-facing surface and the Workspace-mutating surface do not share an identity.

**Acceptance criteria — your task boxes:**
- [ ] terraform validate and terraform plan succeed against the committed configuration with no manual resource references
  → covered by Task T10
- [x] The Terraform configuration provisions both Cloud Run services, the load balancer with serverless NEG, IAP, Firestore, the Cloud Tasks queue, and Secret Manager secrets
- [x] Both Cloud Run services are configured with min-instances 0 and scale to zero when idle
- [x] The API service and the worker service are bound to distinct runtime service accounts, and only the worker's identity holds the Workspace admin role
- [x] The Cloud Tasks queue targets the worker service with OIDC authentication, and the worker rejects task requests not carrying a valid OIDC token from the queue's service account
- [x] No resource in the deployment is a VM, managed instance group, or Kubernetes cluster
- [ ] A from-scratch apply into an empty GCP project produces a reachable, IAP-protected endpoint following only the documented steps (manual)
  → covered by Task T11

### REQ-014: Least-privilege runtime identities and secret provisioning
Category: technical | Status: in-progress
Owned by the GCP Project node, as infrastructure-as-code. The system holds no long-lived credentials: Google API access uses Application Default Credentials from the Cloud Run metadata server, and no service-account key is ever downloaded, mounted, or committed. Two secrets exist in Secret Manager — the email delivery provider key (worker only) and the credential data-encryption key (worker encrypts, API service decrypts) — each granted to exactly the identities that need it, per-secret and never at project scope.

Each Cloud Run service runs under its own runtime service account holding only the roles its responsibilities require. The separation that is real and enforceable is the Workspace admin role: the worker's identity holds it and the API service's identity does not, so a compromise of the operator-facing surface cannot mutate the directory. Note deliberately that Firestore access is NOT part of that separation — Firestore IAM is database-scoped rather than per-collection (the same fact recorded in REQ-010 and REQ-018), so both services necessarily share database-level access and any per-collection restriction would be fiction. The API service legitimately writes request and step documents at creation and on approval (REQ-001, REQ-002); the boundary between the two services' Firestore writes is enforced in the data access layer, not by IAM, and must not be claimed as an infrastructure control.

Cloud KMS envelope encryption is the hardening path for the encryption key if Company wants decrypt operations independently audited and key material never resident in a service process; it is a straight substitution and changes nothing else. In-code credential protection is REQ-019.

**Acceptance criteria — your task boxes:**
- [x] No service-account key file, API key, or password literal exists anywhere in the repository, verified by a secret-scanning check in CI
- [x] Secrets are referenced by Secret Manager resource name in configuration and resolved at runtime, never inlined into an environment variable at build time
- [x] Each runtime service account is granted secretAccessor only on the specific secrets it needs, not at project scope: the worker on notification-smtp-credentials and credential-encryption-key, the API service on credential-encryption-key alone
- [x] The API service and the worker are bound to distinct runtime service accounts in the deployed configuration
- [ ] The worker's runtime identity is the only one holding the Workspace admin role, and the API service's identity holds no Workspace admin role — verified by attempting a Directory API call with the API service's identity and observing it refused
  → covered by Task T12
- [ ] Rotating a secret version is picked up without redeploying the service
  → covered by Task T13
- [x] The deployment claims no per-collection Firestore IAM restriction anywhere, since Firestore IAM is database-scoped — a repository check finds no IAM binding or comment asserting collection-level Firestore permissions
- [x] The two long-lived secrets are the only ones in the deployment, and each carries a recorded justification and removal path — notification-smtp-credentials is removable by the relay IP-allowlisting hardening path (REQ-028), credential-encryption-key by Cloud KMS envelope encryption

## Technology Guidance

_Reference for executing the Implementation Tasks above — apply where relevant. The task list stands even where this guidance is thin._

**Purpose:** GCP cloud provider identifier for infrastructure container nodes. Use this as the technology for cloud-project, vpc, and subnet roles when the deployment target is GCP. Individual GCP services have their own technology entries and should be assigned to their respective leaf-role nodes, NOT to infrastructure containers.

**SDK Initialization:**
```
gcloud init && gcloud config set project my-project-id && gcloud auth application-default login
```

**Common API Patterns:**

#### Create Project
Create a GCP project under an organization folder with billing
```
gcloud projects create my-project-prod --name="My Project Prod" --folder=123456 && gcloud billing projects link my-project-prod --billing-account=BILLING_ID
```

#### Enable APIs
Enable required APIs for a project
```
gcloud services enable compute.googleapis.com container.googleapis.com cloudsql.googleapis.com --project=my-project-prod
```

#### Set IAM Policy
Grant IAM role to a service account
```
gcloud projects add-iam-policy-binding my-project-prod --member="serviceAccount:sa@project.iam.gserviceaccount.com" --role="roles/compute.admin"
```

**Configuration Template:**
```
# GCP Organization pattern (Terraform)
provider "google" {
  project = var.project_id
  region  = var.region
}
resource "google_project" "main" {
  name       = var.project_name
  project_id = var.project_id
  org_id     = var.org_id
  billing_account = var.billing_account
  labels = {
    environment = var.environment
    managed_by  = "terraform"
  }
}
```

**Best Practices:**
- Use Shared VPCs for multi-project networking
- Enable Cloud Audit Logs
- Use projects for resource isolation
- Implement organization policies

**Anti-Patterns to Avoid:**
- Using a single project for all environments
- Exporting service account keys instead of using workload identity
- Running resources without organization policies or folder hierarchy
- Leaving default compute service account with Editor role
- Ignoring VPC Service Controls for projects handling sensitive data

**Security:** Enable Cloud Audit Logs for all projects. Use Organization Policies to enforce constraints (e.g., restrict public IP creation). Implement VPC Service Controls for sensitive data perimeters. Use Workload Identity Federation instead of exported service account keys. Enable Security Command Center for threat detection. Use hierarchical firewall policies at the organization level.

**Integration Patterns:**
- Cloud Identity + IAM for organization-wide access management
- Cloud Logging + Cloud Monitoring for centralized observability
- Organization Policies for governance at scale
- Cloud Build or GitHub Actions for CI/CD pipelines
- Cloud Billing + Budgets for cost governance

**Contains:**
- Firestore: lifecycle state and audit [gcp-firestore] (database)
- Identity-Aware Proxy [gcp-identity-aware-proxy] (auth-provider)
- Cloud Logging: audit sink [gcp-cloud-logging] (logging)
- Cloud Tasks: lifecycle-steps [gcp-cloud-tasks] (queue)
- Cloud Run: lifecycle-api [gcp-cloud-run] (docker-container)
- External HTTPS Load Balancer [gcp-cloud-load-balancing] (load-balancer)
- Cloud Run: lifecycle-worker [gcp-cloud-run] (docker-container)
- Secret Manager [gcp-secret-manager] (secret-manager)

## Existing Implementation

| File | Kind | Language | Status |
|------|------|----------|--------|
| `docs/testing.md` | doc | --- | draft |
| `infra/versions.tf` | config | --- | draft |
| `infra/apis.tf` | config | --- | draft |
| `infra/hcl.test.ts` | test-plan | --- | draft |
| `infra/hcl.ts` | source | --- | draft |
| `vitest.emulator.config.ts` | config | --- | draft |
| `.gitignore` | config | --- | draft |
| `package.json` | config | --- | draft |
| `infra/iam.tf` | config | --- | draft |
| `infra/outputs.tf` | config | --- | draft |
| `vitest.config.ts` | config | --- | draft |
| `README.md` | doc | --- | draft |
| `infra/infra.test.ts` | test-plan | --- | draft |
| `infra/variables.tf` | config | --- | draft |
