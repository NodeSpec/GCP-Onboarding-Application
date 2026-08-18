# Task: Secret Manager

> **Scope:** implement ONLY this node ("Secret Manager"). Work belonging to other nodes appears here solely as interfaces and coordination points — do not implement or re-derive it.
> This document is DERIVED from the NodeSpec model + catalog (fingerprinted, regenerable via generate_task_docs). Node context/export is the model truth; propose model changes through the proposal flow — hand-edits to model facts here do not change the model.

## Component Purpose

**Role:** Secret Manager
**Technology:** Google Cloud Secret Manager
**Description:** Centralized secrets and key management

## Your Deliverable

This service is provisioned, not programmed — no application code implements it (provider-managed, or operated by you if self-hosted).
- **Provisioning configuration (IaC)** — declare the service as config artifacts: existence, sizing, wiring, permissions. The IaC tool is NOT declared on this project's platform container — CONFIRM the tool with the user (Terraform / OpenTofu / Pulumi / provider-native / CDK) before authoring artifacts; do NOT assume one.
- **Connection contracts** for every interface below

## Implementation Context

<!-- AI-AUTHORED SECTION: NodeSpec never writes prose here. Your text survives regeneration verbatim while the derived sections around it keep refreshing. -->
_Not yet authored._ **Consuming AI — author this section BEFORE building.** Working from this full packet plus the repository, record the project-specific context no catalog can know: how this node's technology composes with its neighbors in THIS project, the integration specifics behind each interface contract, configuration rationale, and your intended implementation approach. Replace this placeholder (keep the heading) either by editing this file in the repo and pushing — NodeSpec surfaces the edit as a change card for the user to accept — or via an update_artifact patch through propose_patches. If a REVIEW-NEEDED line appears here later, the derived context changed after you wrote this: re-verify the section, then delete that line.

## Implementation Tasks

Ordered WORK ORDERS synthesized from the model — this node's deliverable kind, contracts, criterion attribution, configuration, and dependency chain. They guarantee coverage, scope, and traceability; they deliberately do NOT contain the implementation detail — that is your job (see the expansion directive below the list).

- [ ] **T1 — Provision Google Cloud Secret Manager via IaC.**
  Author the provisioning definition as config artifacts bound to this node — existence, wiring, permissions, deployed under Company GCP Project.
  [PLACEHOLDER: config — no user configuration recorded for this node; confirm sizing/domains/settings with the user]
- [ ] **T2 — Expose the interface Lifecycle Step Executor consumes, per Contract "Secret Manager Access" (dependency).**
  Record the endpoint/identifiers Lifecycle Step Executor needs in this node's config artifacts — coordinate with Lifecycle Step Executor.
  Dependency contract — capture the reference/identifier wiring in this node's config artifacts; no payload schema expected.
  ↳ serves (unverified match): REQ-022 "Adding a new secret version does not require redeploying either Cloud Run service" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T3 — Expose the interface Lifecycle API Service consumes, per Contract "Secret Manager Access" (dependency).**
  Record the endpoint/identifiers Lifecycle API Service needs in this node's config artifacts — coordinate with Lifecycle API Service.
  Dependency contract — capture the reference/identifier wiring in this node's config artifacts; no payload schema expected.
- [ ] **T4 — Configure the service to satisfy: "The credential data-encryption key is generated with sufficient entropy for the chosen cipher and its generation procedure is documented rather than ad hoc" (REQ-022).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-022 "The credential data-encryption key is generated with sufficient entropy for the chosen cipher and its generation procedure is documented rather than ad hoc"
- [ ] **T5 — Verify every acceptance criterion above and tick its box.**
  Ordering doctrine — plans follow schemas (contract-first TDD): schemas → test plans → implement → verify. Resolve any open [PLACEHOLDER: schema] gap FIRST (get_build_readiness supplies draftInputs; submit the schema via propose_patches update_contract) — test-plan scenarios touching a schemaless contract stay one-line [blocked by schema: …] markers until the schema lands, then the plan refreshes itself.
  AUTOMATED criteria: call get_test_plan for EACH requirement this node serves, implement the plan's test cases, run them, and report every outcome via report_test_results — a passing result flips the criterion's met flag automatically and the response receipt shows which criteria flipped.
  MANUAL criteria (rows marked (manual) above): report_test_results REFUSES to bind them — prove each by ticking its criterion box in this task doc and having the user approve the resulting change card; that approval is the only thing that flips a manual criterion met.
  This node is complete only when every criterion box is ticked and no `[PLACEHOLDER: …]` tag remains open.

**Your first action — expand these work orders.** Each task above guarantees WHAT must be covered, not HOW. Before writing any code or configuration, expand every task with the concrete implementation steps for THIS technology in THIS project — the specific resources, settings, files, schemas, and tests — using the Configuration, Interface Contracts, Technology Guidance, and node context as your references. Record the expanded list in this section via update_artifact (propose_patches) after this doc is accepted, keeping task IDs, criterion citations, and open `[PLACEHOLDER: …]` tags intact. Resolve placeholders with the user through the proposal flow; this node is never complete while one remains open. When the work orders are implemented, verify through the test lane: run get_test_plan for each requirement this node serves, implement and run the plan's tests, and report outcomes via report_test_results — passing results are the evidence that flips criteria met.

### Platform Capability Equivalence

This node is semantically equivalent to a "Google Cloud Secret Manager" (gcp-secret-manager) platform_capability node. Treat it as the managed GCP service for spec generation, code scaffolding, and architecture decisions.
- **Equivalent Role:** gcp-secret-manager (Google Cloud Secret Manager)
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

### REQ-022: Secret Manager resource provisioning
Category: technical | Status: in-progress
Owned by the Secret Manager node. Provisions the two secret resources the system needs — notification-smtp-credentials (the app password for the dedicated no-reply Workspace account used against the SMTP relay, REQ-028) and credential-encryption-key (protecting the one-time password between generation and operator retrieval) — with their replication policy and version lifecycle. The IAM bindings that scope who may read them, and the runtime identity separation they enforce, belong to REQ-014; this requirement covers the resources themselves and the hygiene around them, in particular that no secret value is ever written into Terraform state.

**Acceptance criteria — your task boxes:**
- [x] Both secrets — notification-smtp-credentials and credential-encryption-key — are provisioned by name with an explicit replication policy rather than the provider default
  → possible match: Contract "Secret Manager Access" (dependency) from Lifecycle Step Executor (unverified — requirement not mapped to that node)
- [x] No secret VALUE appears in Terraform configuration or state — secrets are created empty and populated out of band, verified by inspecting the state file for the known values
  → possible match: Contract "Secret Manager Access" (dependency) from Lifecycle Step Executor (unverified — requirement not mapped to that node)
- [ ] The credential data-encryption key is generated with sufficient entropy for the chosen cipher and its generation procedure is documented rather than ad hoc
  → covered by Task T4
- [ ] Adding a new secret version does not require redeploying either Cloud Run service
  → covered by Task T2
- [x] A prior secret version remains accessible for at least the credential TTL window after rotation, so ciphertext written under the old version stays decryptable — or the rotation runbook documents an explicit drain step, and whichever is chosen is recorded as a decision
  → possible match: Contract "Secret Manager Access" (dependency) from Lifecycle Step Executor (unverified — requirement not mapped to that node)
- [x] Secret resources carry labels identifying their owning service and purpose
  → possible match: Contract "Secret Manager Access" (dependency) from Lifecycle Step Executor (unverified — requirement not mapped to that node)

## Interface Contracts

### RECEIVES FROM: Lifecycle Step Executor (worker)
- **Contract:** Secret Manager Access
- **Protocol:** dependency
- **Their Technology:** nodejs

**Schema:**
```
{
  "iam": "roles/secretmanager.secretAccessor granted per-secret, never at project scope",
  "secrets": {
    "credential-encryption-key": {
      "purpose": "protect the one-time password between generation and operator retrieval. The worker encrypts at creation; the API service decrypts exactly once when the requesting operator retrieves it.",
      "consumers": [
        "lifecycle-worker",
        "lifecycle-api"
      ],
      "hardeningPath": "Cloud KMS envelope encryption is a straight substitution if Company wants decrypt operations independently audited and key material never resident in a service process.",
      "whyEncryptionAndNotHashing": "Split-channel handoff must return the ACTUAL password to the operator. A hash cannot be reversed, so hashing is the wrong primitive here - it is right for verifying a presented value, wrong for recovering a stored one."
    },
    "notification-smtp-credentials": {
      "nature": "long-lived by necessity. Bounded by being scoped to one no-reply account with no admin role, revocable instantly from the Admin console, and rotatable without redeploying. The hardening path (relay IP allowlisting via Direct VPC egress) removes this secret entirely - see the Welcome Letter Delivery contract.",
      "purpose": "SMTP AUTH against the Google Workspace SMTP relay - the app password for the dedicated no-reply Workspace account",
      "consumers": [
        "lifecycle-worker"
      ],
      "renamedFrom": "notification-provider-api-key, when the provider decision resolved to the Workspace relay rather than a third-party ESP"
    }
  },
  "rotation": "a new secret version is picked up without redeploying the service; the rotation runbook covers draining in-flight ciphertext or retaining the prior version until TTL expiry",
  "description": "Runtime secret resolution by resource name. No secret value is ever baked into an image, a build-time environment variable, or the repository.",
  "accessPattern": "read at runtime via the Secret Manager client using the service's own runtime identity",
  "notResolvedHere": [
    "Google API credentials - those come from the Cloud Run metadata server as Application Default Credentials, never from a stored key"
  ]
}
```

### RECEIVES FROM: Lifecycle API Service (backend-service)
- **Contract:** Secret Manager Access
- **Protocol:** dependency
- **Their Technology:** nodejs

**Schema:**
```
{
  "iam": "roles/secretmanager.secretAccessor granted per-secret, never at project scope",
  "secrets": {
    "credential-encryption-key": {
      "purpose": "protect the one-time password between generation and operator retrieval. The worker encrypts at creation; the API service decrypts exactly once when the requesting operator retrieves it.",
      "consumers": [
        "lifecycle-worker",
        "lifecycle-api"
      ],
      "hardeningPath": "Cloud KMS envelope encryption is a straight substitution if Company wants decrypt operations independently audited and key material never resident in a service process.",
      "whyEncryptionAndNotHashing": "Split-channel handoff must return the ACTUAL password to the operator. A hash cannot be reversed, so hashing is the wrong primitive here - it is right for verifying a presented value, wrong for recovering a stored one."
    },
    "notification-smtp-credentials": {
      "nature": "long-lived by necessity. Bounded by being scoped to one no-reply account with no admin role, revocable instantly from the Admin console, and rotatable without redeploying. The hardening path (relay IP allowlisting via Direct VPC egress) removes this secret entirely - see the Welcome Letter Delivery contract.",
      "purpose": "SMTP AUTH against the Google Workspace SMTP relay - the app password for the dedicated no-reply Workspace account",
      "consumers": [
        "lifecycle-worker"
      ],
      "renamedFrom": "notification-provider-api-key, when the provider decision resolved to the Workspace relay rather than a third-party ESP"
    }
  },
  "rotation": "a new secret version is picked up without redeploying the service; the rotation runbook covers draining in-flight ciphertext or retaining the prior version until TTL expiry",
  "description": "Runtime secret resolution by resource name. No secret value is ever baked into an image, a build-time environment variable, or the repository.",
  "accessPattern": "read at runtime via the Secret Manager client using the service's own runtime identity",
  "notResolvedHere": [
    "Google API credentials - those come from the Cloud Run metadata server as Application Default Credentials, never from a stored key"
  ]
}
```

## Technology Guidance

_Reference for executing the Implementation Tasks above — apply where relevant. The task list stands even where this guidance is thin._

**Purpose:** Secret Manager is Google Cloud's managed service for storing and controlling access to secrets such as API keys, passwords, tokens, and certificates with versioning and auditability. Use it to centralize sensitive configuration, rotate secret versions, and keep credentials out of source code, images, and deployment manifests. Choose Secret Manager over environment files or ad hoc configuration stores when values are sensitive and need governed access, audit logging, and controlled distribution. Do not use it as a general-purpose database, a high-throughput cache, or a replacement for user authentication systems.

**SDK Initialization:**
```
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const client = new SecretManagerServiceClient(); // ADC / workload identity
const [version] = await client.accessSecretVersion({
  name: 'projects/my-project/secrets/db-password/versions/latest',
});
const secret = version.payload.data.toString();
```

**Best Practices:**
- Grant least-privilege access to individual secrets using dedicated service identities
- Separate secrets by environment, application, or ownership boundary to reduce blast radius
- Rotate secrets and certificates through versioned updates instead of overwriting values blindly
- Reference secrets at runtime or deployment time instead of embedding them in code or images
- Audit secret access, version usage, and IAM changes as part of regular security operations
- Use customer-managed encryption and organizational policy controls where compliance requires them
- Keep secret names and metadata consistent so applications can discover and consume them predictably

**Anti-Patterns to Avoid:**
- Storing non-sensitive application configuration in Secret Manager without need
- Granting broad project-wide access to all secrets for convenience
- Embedding secrets directly in source code, container images, or CI scripts
- Polling secrets excessively in hot request paths instead of caching resolved values appropriately
- Using Secret Manager as an end-user identity provider or authorization engine
- Mixing unrelated teams and environments into one flat secret namespace without boundaries

**Security:** Grant secretmanager.secretAccessor per secret per identity — never project-wide accessor. Access via workload identity / ADC; a JSON key that unlocks the secret store defeats the store. Reference specific versions in config you must pin, use rotation schedules for credentials that support it, and never copy secret values into env files, logs, or build artifacts — access them at runtime.

**Suggested File Structure:**
- `security/secret-access.yaml` (config)
- `security/secret-map.json` (config)
- `infra/secret-manager.yaml` (config)

## Dependency Chain

Startup/initialization order based on edge directions and interaction patterns.

**Depends on THIS node being available:**
- Lifecycle Step Executor (initiates Secret Manager Access against this node (dependency))
- Lifecycle API Service (initiates Secret Manager Access against this node (dependency))

**Parent Container:** Company GCP Project (gcp)
