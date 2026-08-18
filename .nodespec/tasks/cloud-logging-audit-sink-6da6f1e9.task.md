# Task: Cloud Logging: audit sink

> **Scope:** implement ONLY this node ("Cloud Logging: audit sink"). Work belonging to other nodes appears here solely as interfaces and coordination points — do not implement or re-derive it.
> This document is DERIVED from the NodeSpec model + catalog (fingerprinted, regenerable via generate_task_docs). Node context/export is the model truth; propose model changes through the proposal flow — hand-edits to model facts here do not change the model.

## Component Purpose

**Role:** Logging
**Technology:** Google Cloud Logging
**Description:** Centralized log aggregation and analysis

## Your Deliverable

This service is provisioned, not programmed — no application code implements it (provider-managed, or operated by you if self-hosted).
- **Provisioning configuration (IaC)** — declare the service as config artifacts: existence, sizing, wiring, permissions. The IaC tool is NOT declared on this project's platform container — CONFIRM the tool with the user (Terraform / OpenTofu / Pulumi / provider-native / CDK) before authoring artifacts; do NOT assume one.
- **Connection contracts** for every interface below

## Implementation Context

<!-- AI-AUTHORED SECTION: NodeSpec never writes prose here. Your text survives regeneration verbatim while the derived sections around it keep refreshing. -->
_Not yet authored._ **Consuming AI — author this section BEFORE building.** Working from this full packet plus the repository, record the project-specific context no catalog can know: how this node's technology composes with its neighbors in THIS project, the integration specifics behind each interface contract, configuration rationale, and your intended implementation approach. Replace this placeholder (keep the heading) either by editing this file in the repo and pushing — NodeSpec surfaces the edit as a change card for the user to accept — or via an update_artifact patch through propose_patches. If a REVIEW-NEEDED line appears here later, the derived context changed after you wrote this: re-verify the section, then delete that line.

## Implementation Tasks

Ordered WORK ORDERS synthesized from the model — this node's deliverable kind, contracts, criterion attribution, configuration, and dependency chain. They guarantee coverage, scope, and traceability; they deliberately do NOT contain the implementation detail — that is your job (see the expansion directive below the list).

- [ ] **T1 — Provision Google Cloud Logging via IaC.**
  Author the provisioning definition as config artifacts bound to this node — existence, wiring, permissions, deployed under Company GCP Project.
  [PLACEHOLDER: config — no user configuration recorded for this node; confirm sizing/domains/settings with the user]
- [ ] **T2 — Expose the interface Lifecycle Step Executor consumes, per Contract "Audit Log Sink" (dependency).**
  Record the endpoint/identifiers Lifecycle Step Executor needs in this node's config artifacts — coordinate with Lifecycle Step Executor.
  Dependency contract — capture the reference/identifier wiring in this node's config artifacts; no payload schema expected.
  ↳ serves (unverified match): REQ-018 "Every audit event is mirrored to the dedicated Cloud Logging bucket with the same eventId, so the log copy can be reconciled against the Firestore copy" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-018 "No application runtime service account holds permission to delete log entries or shorten the bucket's retention policy, verified against the deployed IAM policy" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-018 "The audit log bucket carries a locked retention policy, and the retention period is set to Company's stated compliance requirement rather than a default" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T3 — Expose the interface Lifecycle API Service consumes, per Contract "Audit Log Sink" (dependency).**
  Record the endpoint/identifiers Lifecycle API Service needs in this node's config artifacts — coordinate with Lifecycle API Service.
  Dependency contract — capture the reference/identifier wiring in this node's config artifacts; no payload schema expected.
- [ ] **T4 — Configure the service to satisfy: "An attempt to shorten or remove the retention policy using each application runtime identity is refused" (REQ-018).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-018 "An attempt to shorten or remove the retention policy using each application runtime identity is refused"
- [ ] **T5 — Verify every acceptance criterion above and tick its box.**
  Ordering doctrine — plans follow schemas (contract-first TDD): schemas → test plans → implement → verify. Resolve any open [PLACEHOLDER: schema] gap FIRST (get_build_readiness supplies draftInputs; submit the schema via propose_patches update_contract) — test-plan scenarios touching a schemaless contract stay one-line [blocked by schema: …] markers until the schema lands, then the plan refreshes itself.
  AUTOMATED criteria: call get_test_plan for EACH requirement this node serves, implement the plan's test cases, run them, and report every outcome via report_test_results — a passing result flips the criterion's met flag automatically and the response receipt shows which criteria flipped.
  MANUAL criteria (rows marked (manual) above): report_test_results REFUSES to bind them — prove each by ticking its criterion box in this task doc and having the user approve the resulting change card; that approval is the only thing that flips a manual criterion met.
  This node is complete only when every criterion box is ticked and no `[PLACEHOLDER: …]` tag remains open.

**Your first action — expand these work orders.** Each task above guarantees WHAT must be covered, not HOW. Before writing any code or configuration, expand every task with the concrete implementation steps for THIS technology in THIS project — the specific resources, settings, files, schemas, and tests — using the Configuration, Interface Contracts, Technology Guidance, and node context as your references. Record the expanded list in this section via update_artifact (propose_patches) after this doc is accepted, keeping task IDs, criterion citations, and open `[PLACEHOLDER: …]` tags intact. Resolve placeholders with the user through the proposal flow; this node is never complete while one remains open. When the work orders are implemented, verify through the test lane: run get_test_plan for each requirement this node serves, implement and run the plan's tests, and report outcomes via report_test_results — passing results are the evidence that flips criteria met.

### Platform Capability Equivalence

This node is semantically equivalent to a "Google Cloud Logging" (gcp-cloud-logging) platform_capability node. Treat it as the managed GCP service for spec generation, code scaffolding, and architecture decisions.
- **Equivalent Role:** gcp-cloud-logging (Google Cloud Logging)
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

### REQ-018: Tamper-evident audit retention
Category: non-functional | Status: in-progress
Owned by the Cloud Logging node. Application-layer append-only discipline (REQ-010) is not by itself a tamper-evidence control: all Firestore access is server-side through Admin SDK credentials, which bypass security rules entirely, and Firestore IAM is database-scoped rather than per-collection. Genuine tamper-evidence therefore comes from the infrastructure. Every audit event is mirrored to a dedicated Cloud Logging bucket carrying a locked retention policy that no application runtime identity can shorten or delete within the retention window, and the log copy shares its eventId with the Firestore copy so the two can be reconciled. Any divergence between them is itself a detectable signal.

**Acceptance criteria — your task boxes:**
- [ ] Every audit event is mirrored to the dedicated Cloud Logging bucket with the same eventId, so the log copy can be reconciled against the Firestore copy
  → covered by Task T2
- [x] A reconciliation check over a sample window reports any audit event present in one store and absent from the other
  → possible match: Contract "Audit Log Sink" (dependency) from Lifecycle Step Executor (unverified — requirement not mapped to that node)
- [ ] No application runtime service account holds permission to delete log entries or shorten the bucket's retention policy, verified against the deployed IAM policy
  → covered by Task T2
- [ ] The audit log bucket carries a locked retention policy, and the retention period is set to Company's stated compliance requirement rather than a default (manual)
  → covered by Task T2
- [ ] An attempt to shorten or remove the retention policy using each application runtime identity is refused (manual)
  → covered by Task T4

## Interface Contracts

### RECEIVES FROM: Lifecycle Step Executor (worker)
- **Contract:** Audit Log Sink
- **Protocol:** dependency
- **Their Technology:** nodejs

**Schema:**
```
{
  "fields": [
    "eventId",
    "requestId",
    "stepId",
    "actor",
    "action",
    "targetUser",
    "before",
    "after",
    "outcome",
    "timestamp"
  ],
  "format": "structured JSON, one log entry per audit event, sharing the eventId with the Firestore document",
  "logName": "lifecycle-audit",
  "redaction": {
    "filter": "applied to every log sink, not only the audit sink",
    "verification": "a test logs a payload containing each field and asserts on the emitted record",
    "strippedFields": [
      "password",
      "oneTimePassword",
      "ciphertext",
      "secret",
      "smtpCredential",
      "key",
      "token",
      "x-goog-iap-jwt-assertion",
      "authorization"
    ]
  },
  "retention": "[PLACEHOLDER: config] log bucket retention period, set per Company's compliance requirement rather than a provider default",
  "description": "Structured audit events are mirrored from Firestore to Cloud Logging for retention beyond the operational store.",
  "tamperEvidence": "The bucket carries a LOCKED retention policy that no application runtime identity can shorten or delete within the window. This is the real tamper-evidence control - Firestore append-only discipline is application-layer only, because Admin SDK access bypasses security rules and Firestore IAM is database-scoped."
}
```

### RECEIVES FROM: Lifecycle API Service (backend-service)
- **Contract:** Audit Log Sink
- **Protocol:** dependency
- **Their Technology:** nodejs

**Schema:**
```
{
  "fields": [
    "eventId",
    "requestId",
    "stepId",
    "actor",
    "action",
    "targetUser",
    "before",
    "after",
    "outcome",
    "timestamp"
  ],
  "format": "structured JSON, one log entry per audit event, sharing the eventId with the Firestore document",
  "logName": "lifecycle-audit",
  "redaction": {
    "filter": "applied to every log sink, not only the audit sink",
    "verification": "a test logs a payload containing each field and asserts on the emitted record",
    "strippedFields": [
      "password",
      "oneTimePassword",
      "ciphertext",
      "secret",
      "smtpCredential",
      "key",
      "token",
      "x-goog-iap-jwt-assertion",
      "authorization"
    ]
  },
  "retention": "[PLACEHOLDER: config] log bucket retention period, set per Company's compliance requirement rather than a provider default",
  "description": "Structured audit events are mirrored from Firestore to Cloud Logging for retention beyond the operational store.",
  "tamperEvidence": "The bucket carries a LOCKED retention policy that no application runtime identity can shorten or delete within the window. This is the real tamper-evidence control - Firestore append-only discipline is application-layer only, because Admin SDK access bypasses security rules and Firestore IAM is database-scoped."
}
```

## Technology Guidance

_Reference for executing the Implementation Tasks above — apply where relevant. The task list stands even where this guidance is thin._

**Purpose:** Cloud Logging is Google Cloud's managed log management service for collecting, storing, searching, routing, and analyzing logs from Google Cloud, hybrid, and multicloud systems. Use it for centralized application and infrastructure log ingestion, troubleshooting, audit visibility, log-based metrics, and log routing to analytics or retention targets. Choose Cloud Logging over local file-based logging or scattered service consoles when you need centralized search and policy-driven retention, and pair it with Cloud Monitoring for alerting and metric correlation. Do not use it as a high-throughput message bus, transactional application datastore, or general-purpose warehouse for all historical analytics.

**SDK Initialization:**
```
// Cloud Run/GKE: structured JSON on stdout IS the integration
console.log(JSON.stringify({
  severity: 'INFO',
  message: 'order created',
  orderId,
  'logging.googleapis.com/trace': `projects/${project}/traces/${traceId}`,
}));
```

**Best Practices:**
- Adopt structured logging with consistent fields so logs are searchable and correlatable across services
- Route different log classes to the right buckets, sinks, and retention targets based on value and compliance needs
- Create log-based metrics and alerting only for signals that are actionable and owned
- Use exclusions, sampling, and sink strategies to manage cost and reduce noisy low-value logs
- Separate audit, platform, and application log use cases with clear retention and access controls
- Correlate log entries with trace IDs, request IDs, and service labels to accelerate troubleshooting
- Treat logging schema and field conventions as part of platform standards rather than per-team improvisation

**Anti-Patterns to Avoid:**
- Sending every debug event from production permanently without retention or cost controls
- Using Cloud Logging as a durable event transport instead of Pub/Sub or task services
- Keeping one flat undifferentiated log strategy for all teams and workloads
- Writing unstructured text logs that cannot be filtered or joined by operational context
- Granting broad unrestricted access to sensitive audit and application logs
- Using Cloud Logging as the primary analytics warehouse instead of routing selected data to purpose-built systems

**Security:** Logs are a data store with their own access model — logging.viewer is broad read on everything your services emit, so scrub credentials, tokens, and raw PII at the emission point; a leaked value in a log outlives the request forever within retention. Set per-bucket retention deliberately, use log views/field-level access for sensitive buckets, route audit logs to a locked project sinks-only, and remember exclusion filters are cost tools, not privacy tools — excluded entries never existed.

**Suggested File Structure:**
- `logging/log-sinks.yaml` (config)
- `logging/log-based-metrics.yaml` (config)
- `infra/cloud-logging.yaml` (config)

## Dependency Chain

Startup/initialization order based on edge directions and interaction patterns.

**Depends on THIS node being available:**
- Lifecycle Step Executor (initiates Audit Log Sink against this node (dependency))
- Lifecycle API Service (initiates Audit Log Sink against this node (dependency))

**Parent Container:** Company GCP Project (gcp)

## Existing Implementation

| File | Kind | Language | Status |
|------|------|----------|--------|
| `packages/shared/src/auditMirror.ts` | source | --- | draft |
| `packages/shared/src/cloudLoggingAudit.ts` | source | --- | draft |
| `packages/shared/src/auditMirror.emulator.test.ts` | test-plan | --- | draft |
