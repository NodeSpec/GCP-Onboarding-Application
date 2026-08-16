# Task: Cloud Run: lifecycle-api

> **Scope:** implement ONLY this node ("Cloud Run: lifecycle-api"). Work belonging to other nodes appears here solely as interfaces and coordination points — do not implement or re-derive it.
> This document is DERIVED from the NodeSpec model + catalog (fingerprinted, regenerable via generate_task_docs). Node context/export is the model truth; propose model changes through the proposal flow — hand-edits to model facts here do not change the model.

## Component Purpose

**Role:** Docker Container
**Technology:** Google Cloud Run
**Description:** Single Docker container runtime

## Your Deliverable

**Working code for this component**, honoring the contracts and criteria below, plus its configuration artifacts and tests.

## Implementation Context

<!-- AI-AUTHORED SECTION: NodeSpec never writes prose here. Your text survives regeneration verbatim while the derived sections around it keep refreshing. -->
_Not yet authored._ **Consuming AI — author this section BEFORE building.** Working from this full packet plus the repository, record the project-specific context no catalog can know: how this node's technology composes with its neighbors in THIS project, the integration specifics behind each interface contract, configuration rationale, and your intended implementation approach. Replace this placeholder (keep the heading) either by editing this file in the repo and pushing — NodeSpec surfaces the edit as a change card for the user to accept — or via an update_artifact patch through propose_patches. If a REVIEW-NEEDED line appears here later, the derived context changed after you wrote this: re-verify the section, then delete that line.

## Implementation Tasks

Ordered WORK ORDERS synthesized from the model — this node's deliverable kind, contracts, criterion attribution, configuration, and dependency chain. They guarantee coverage, scope, and traceability; they deliberately do NOT contain the implementation detail — that is your job (see the expansion directive below the list).

- [ ] **T1 — Scaffold the Google Cloud Run component.**
  Create the source layout, build files, and test harness this node's working code lives in.
  Start from the catalog's suggested structure: `src/cloud-run/server.ts`, `cloudrun/service.yaml`, `Dockerfile`, `infra/cloud-run.yaml`.
- [ ] **T2 — Account for every hosted component in this container's definition.**
  Hosted here: Operator Console UI, Lifecycle API Service.
  Each hosted component must be represented in the provisioning definition (compose service entry / subnet placement / deployment target, as appropriate for this container).
- [ ] **T3 — Implement: "The service is provisioned with ingress set to internal-and-cloud-load-balancing, so a direct *.run.app request fails at the platform" (REQ-025).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-025 "The service is provisioned with ingress set to internal-and-cloud-load-balancing, so a direct *.run.app request fails at the platform"
- [ ] **T4 — Implement: "The service runs under its own runtime service account, distinct from the worker's" (REQ-025).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-025 "The service runs under its own runtime service account, distinct from the worker's"
- [ ] **T5 — Implement: "min-instances is 0 and the service scales to zero when idle" (REQ-025).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-025 "min-instances is 0 and the service scales to zero when idle"
- [ ] **T6 — Implement: "The IAP audience string, Firestore project, Cloud Tasks queue name and worker URL are injected as configuration from Terraform outputs, not hardcoded" (REQ-025).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-025 "The IAP audience string, Firestore project, Cloud Tasks queue name and worker URL are injected as configuration from Terraform outputs, not hardcoded"
- [ ] **T7 — Implement: "Request timeout and concurrency are set explicitly rather than left at provider defaults" (REQ-025).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-025 "Request timeout and concurrency are set explicitly rather than left at provider defaults"
- [ ] **T8 — Implement: "The container image is referenced by immutable digest rather than a mutable tag" (REQ-025).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-025 "The container image is referenced by immutable digest rather than a mutable tag"
- [ ] **T9 — Verify every acceptance criterion above and tick its box.**
  Ordering doctrine — plans follow schemas (contract-first TDD): schemas → test plans → implement → verify. Resolve any open [PLACEHOLDER: schema] gap FIRST (get_build_readiness supplies draftInputs; submit the schema via propose_patches update_contract) — test-plan scenarios touching a schemaless contract stay one-line [blocked by schema: …] markers until the schema lands, then the plan refreshes itself.
  AUTOMATED criteria: call get_test_plan for EACH requirement this node serves, implement the plan's test cases, run them, and report every outcome via report_test_results — a passing result flips the criterion's met flag automatically and the response receipt shows which criteria flipped.
  MANUAL criteria (rows marked (manual) above): report_test_results REFUSES to bind them — prove each by ticking its criterion box in this task doc and having the user approve the resulting change card; that approval is the only thing that flips a manual criterion met.
  This node is complete only when every criterion box is ticked and no `[PLACEHOLDER: …]` tag remains open.

**Your first action — expand these work orders.** Each task above guarantees WHAT must be covered, not HOW. Before writing any code or configuration, expand every task with the concrete implementation steps for THIS technology in THIS project — the specific resources, settings, files, schemas, and tests — using the Configuration, Interface Contracts, Technology Guidance, and node context as your references. Record the expanded list in this section via update_artifact (propose_patches) after this doc is accepted, keeping task IDs, criterion citations, and open `[PLACEHOLDER: …]` tags intact. Resolve placeholders with the user through the proposal flow; this node is never complete while one remains open. When the work orders are implemented, verify through the test lane: run get_test_plan for each requirement this node serves, implement and run the plan's tests, and report outcomes via report_test_results — passing results are the evidence that flips criteria met.

### Platform Capability Equivalence

This node is semantically equivalent to a "Google Cloud Run" (gcp-cloud-run) platform_capability node. Treat it as the managed GCP service for spec generation, code scaffolding, and architecture decisions.
- **Equivalent Role:** gcp-cloud-run (Google Cloud Run)
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

### REQ-025: Cloud Run lifecycle-api service provisioning
Category: technical | Status: in-progress
Owned by the Cloud Run: lifecycle-api node. Provisions the operator-facing service that hosts the API and serves the console SPA: container image reference, its own runtime service account, ingress restricted so the load balancer is the only reachable path, scale-to-zero, request concurrency and timeout, and the configuration it needs injected. This service's identity is deliberately the weaker of the two — no Workspace admin role, no step-document write access — and that separation is enforced here at provisioning time as well as asserted in REQ-014.

**Acceptance criteria — your task boxes:**
- [ ] The service is provisioned with ingress set to internal-and-cloud-load-balancing, so a direct *.run.app request fails at the platform
  → covered by Task T3
- [ ] The service runs under its own runtime service account, distinct from the worker's
  → covered by Task T4
- [ ] min-instances is 0 and the service scales to zero when idle
  → covered by Task T5
- [ ] The IAP audience string, Firestore project, Cloud Tasks queue name and worker URL are injected as configuration from Terraform outputs, not hardcoded
  → covered by Task T6
- [ ] Request timeout and concurrency are set explicitly rather than left at provider defaults
  → covered by Task T7
- [ ] The container image is referenced by immutable digest rather than a mutable tag
  → covered by Task T8

## Technology Guidance

_Reference for executing the Implementation Tasks above — apply where relevant. The task list stands even where this guidance is thin._

**Purpose:** Google Cloud Run is Google Cloud's fully managed serverless platform for running stateless containers and function-style workloads on demand with HTTP and event-driven invocation models. Use it for containerized web services, APIs, background jobs, and function deployments that need autoscaling, revision management, and managed infrastructure. Choose Cloud Run over Cloud Functions when you want container packaging, broader runtime control, or service-style deployments, and over GKE when you do not need cluster-level Kubernetes management. Do not use it for stateful services that depend on local persistence or for platforms that require custom Kubernetes primitives, operators, or daemon workloads.

**Configuration Template:**
```
# Deploy from source; private by default — grant invoker explicitly
gcloud run deploy my-service --source . --region us-central1 --no-allow-unauthenticated
gcloud run services add-iam-policy-binding my-service --region us-central1 \
  --member="serviceAccount:caller@my-project.iam.gserviceaccount.com" --role="roles/run.invoker"
```

**Best Practices:**
- Build services as stateless containers and externalize durable state to managed backing services
- Use revisions and traffic splitting for safe rollouts and controlled production changes
- Tune concurrency, CPU, and memory settings based on actual request patterns and latency goals
- Protect service access with identity-aware ingress rules and least-privilege service accounts
- Separate synchronous HTTP services from asynchronous jobs and event consumers into distinct deployments
- Use structured logs, traces, and request correlation IDs for observability across revisions
- Pin production images by digest and source them from trusted registries and CI pipelines

**Anti-Patterns to Avoid:**
- Treating Cloud Run as a stateful container host with reliance on local disk persistence
- Bundling many unrelated services into one container just to avoid multiple deployments
- Ignoring concurrency settings and then misreading scaling, memory, or latency behavior
- Using Cloud Run where Kubernetes-specific networking, sidecars, or operators are required
- Embedding secrets into container images instead of using managed configuration or secret injection
- Deploying mutable latest-tag images to production without versioning or provenance controls

**Security:** Deploy --no-allow-unauthenticated by default and grant roles/run.invoker explicitly; public endpoints are an opt-in decision. Run each service under its own least-privilege service account — never the default compute service account. Mount secrets from Secret Manager instead of plaintext env vars, and set ingress to internal (or internal + load balancer) for service-to-service traffic.

**Suggested File Structure:**
- `src/cloud-run/server.ts` (source)
- `cloudrun/service.yaml` (config)
- `Dockerfile` (config)
- `infra/cloud-run.yaml` (config)

**Parent Container:** Company GCP Project (gcp)

**Contains:**
- Operator Console UI [react] (frontend-app)
- Lifecycle API Service [nodejs] (backend-service)
