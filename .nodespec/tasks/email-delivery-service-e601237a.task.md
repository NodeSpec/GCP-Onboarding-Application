# Task: Email Delivery Service

> **Scope:** implement ONLY this node ("Email Delivery Service"). Work belonging to other nodes appears here solely as interfaces and coordination points — do not implement or re-derive it.
> This document is DERIVED from the NodeSpec model + catalog (fingerprinted, regenerable via generate_task_docs). Node context/export is the model truth; propose model changes through the proposal flow — hand-edits to model facts here do not change the model.

## Component Purpose

**Role:** External Service
**Description:** Third-party API or SaaS integration

## Your Deliverable

This component is an engine that owns its own internals. Never decompose its internals into architecture nodes, and never reimplement its functionality as application code.
- **Connection contracts** for every interface below (triggers, payloads, endpoints)
- **Configuration artifacts** that bind this engine into the system (config kind)

## Implementation Context

<!-- AI-AUTHORED SECTION: NodeSpec never writes prose here. Your text survives regeneration verbatim while the derived sections around it keep refreshing. -->
_Not yet authored._ **Consuming AI — author this section BEFORE building.** Working from this full packet plus the repository, record the project-specific context no catalog can know: how this node's technology composes with its neighbors in THIS project, the integration specifics behind each interface contract, configuration rationale, and your intended implementation approach. Replace this placeholder (keep the heading) either by editing this file in the repo and pushing — NodeSpec surfaces the edit as a change card for the user to accept — or via an update_artifact patch through propose_patches. If a REVIEW-NEEDED line appears here later, the derived context changed after you wrote this: re-verify the section, then delete that line.

## Implementation Tasks

Ordered WORK ORDERS synthesized from the model — this node's deliverable kind, contracts, criterion attribution, configuration, and dependency chain. They guarantee coverage, scope, and traceability; they deliberately do NOT contain the implementation detail — that is your job (see the expansion directive below the list).

- [ ] **T1 — Author the binding configuration for External Service.**
  Configuration artifacts that bind this engine into the system — the engine owns its internals; never reimplement them.
- [ ] **T2 — Expose the interface Lifecycle Step Executor consumes, per Contract "Welcome Letter Delivery" (rest).**
  Record the endpoint/identifiers Lifecycle Step Executor needs in this node's config artifacts — coordinate with Lifecycle Step Executor.
  Build to the contract schema EXACTLY (see Interface Contracts).
  ↳ serves (unverified match): REQ-028 "The SMTP relay service is configured to allow the no-reply account as a sender and to permit ANY recipient address, since the welcome letter goes to a personal address outside the domain" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-028 "A test letter to a personal-domain address arrives in the inbox rather than the spam folder" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T3 — Configure the service to satisfy: "App passwords are confirmed available in Company's Workspace tenant before this design is built — Google progressively restricts them and they require 2SV, so if the tenant has them disabled this option is void and the IP-allowlisting path or an ESP must be chosen instead" (REQ-028).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-028 "App passwords are confirmed available in Company's Workspace tenant before this design is built — Google progressively restricts them and they require 2SV, so if the tenant has them disabled this option is void and the IP-allowlisting path or an ESP must be chosen instead"
- [ ] **T4 — Configure the service to satisfy: "A dedicated no-reply Workspace account exists for sending, holding no admin role and belonging to no person, so that offboarding a human never breaks onboarding" (REQ-028).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-028 "A dedicated no-reply Workspace account exists for sending, holding no admin role and belonging to no person, so that offboarding a human never breaks onboarding"
- [ ] **T5 — Configure the service to satisfy: "SPF, DKIM and DMARC are configured for the sending domain and validated against a live send to an external address" (REQ-028).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-028 "SPF, DKIM and DMARC are configured for the sending domain and validated against a live send to an external address"
- [ ] **T6 — Configure the service to satisfy: "Return-Path is set to a monitored Workspace group so asynchronous bounces land somewhere a human reads, and the runbook names who monitors it" (REQ-028).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-028 "Return-Path is set to a monitored Workspace group so asynchronous bounces land somewhere a human reads, and the runbook names who monitors it"
- [ ] **T7 — Verify every acceptance criterion above and tick its box.**
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

### REQ-028: Email delivery via Google Workspace SMTP relay
Category: technical | Status: in-progress
Owned by the Email Delivery Service node. RESOLVED: welcome letters are sent through the Google Workspace SMTP relay service (smtp-relay.gmail.com:587, STARTTLS), authenticated with SMTP AUTH using a dedicated no-reply Workspace account and an app password held in Secret Manager. Reached over Cloud Run's default egress — no VPC connector, no Cloud NAT, no reserved IP.

Why this and not a third-party ESP: no additional vendor, no DKIM delegation to an outside party, and mail originates from Company's own domain so SPF, DKIM and DMARC are already aligned — which is what decides inbox versus spam for letters going to personal Gmail and Outlook addresses.

Why this and not the Gmail API: sending through Gmail requires acting as a mailbox. Service accounts have none, and impersonating a user's mailbox requires Domain-Wide Delegation, which the customer explicitly ruled out. The relay is the Workspace-native path that honours that constraint.

The accepted cost is a long-lived credential. It is bounded: the app password is scoped to one no-reply account that holds no admin role, it is revocable instantly from the Admin console, and it is rotatable without redeploying. The documented hardening path removes it entirely — swap SMTP AUTH for source-IP allowlisting on the relay, reached through Cloud Run Direct VPC egress plus Cloud NAT and a reserved static IP. That path MUST use Direct VPC egress and NOT the Serverless VPC Access connector, which is backed by a managed instance group and would violate REQ-009's serverless constraint. It is deferred from MVP because it adds five infrastructure resources and always-on NAT cost for a benefit the scoped, revocable app password already bounds.

The second accepted cost is bounce visibility. SMTP returns a synchronous accept or reject at submission, which is recorded on the step, but asynchronous bounces return to the Return-Path mailbox rather than to a webhook — and without Domain-Wide Delegation the application cannot read that mailbox programmatically. Bounce detection is therefore human-monitored, which is workable because an operator is already in the loop handing over the password, and because REQ-030 provides a deliberate resend path when a letter does not land.

**Acceptance criteria — your task boxes:**
- [ ] App passwords are confirmed available in Company's Workspace tenant before this design is built — Google progressively restricts them and they require 2SV, so if the tenant has them disabled this option is void and the IP-allowlisting path or an ESP must be chosen instead (manual)
  → covered by Task T3
- [ ] A dedicated no-reply Workspace account exists for sending, holding no admin role and belonging to no person, so that offboarding a human never breaks onboarding (manual)
  → covered by Task T4
- [ ] The SMTP relay service is configured to allow the no-reply account as a sender and to permit ANY recipient address, since the welcome letter goes to a personal address outside the domain (manual)
  → covered by Task T2
- [ ] SPF, DKIM and DMARC are configured for the sending domain and validated against a live send to an external address (manual)
  → covered by Task T5
- [ ] A test letter to a personal-domain address arrives in the inbox rather than the spam folder (manual)
  → covered by Task T2
- [ ] Return-Path is set to a monitored Workspace group so asynchronous bounces land somewhere a human reads, and the runbook names who monitors it (manual)
  → covered by Task T6
- [x] The SMTP host, port, sender address and Return-Path are supplied as configuration and the app password is resolved from Secret Manager at runtime, so switching provider requires no code change outside the NotificationSender implementation
  → THIS NODE: internal logic
- [x] A synchronous SMTP rejection is surfaced as a typed error the notification step records and can be resumed from, rather than being silently swallowed
  → THIS NODE: internal logic
- [x] The SMTP credential is never logged and never included in an audit payload, verified by the redaction test in REQ-010
  → THIS NODE: internal logic
- [x] Rotating the app password to a new Secret Manager version is picked up without redeploying the worker
  → THIS NODE: internal logic

## Interface Contracts

### RECEIVES FROM: Lifecycle Step Executor (worker)
- **Contract:** Welcome Letter Delivery
- **Protocol:** rest
- **Transport:** http
- **Their Technology:** nodejs

**Schema:**
```
{
  "provider": {
    "decision": "Google Workspace SMTP relay service - RESOLVED",
    "endpoint": "smtp-relay.gmail.com:587 (STARTTLS)",
    "reachedVia": "Cloud Run default egress - no VPC connector, no Cloud NAT, no reserved IP required for this authentication mode",
    "hardeningPath": "Replace SMTP AUTH with source-IP allowlisting on the relay, via Cloud Run Direct VPC egress + Cloud NAT + a reserved static IP - removes the stored credential entirely. MUST use Direct VPC egress, NOT the Serverless VPC Access connector, which is backed by a managed instance group and would violate REQ-009.",
    "authentication": "SMTP AUTH using a dedicated no-reply Workspace account and an app password held in Secret Manager",
    "adminConsolePath": "Apps > Google Workspace > Gmail > Routing > SMTP relay service",
    "whyThisAndNotAnEsp": "No third-party vendor, no DKIM delegation to an outside party, and mail originates from the customer's own domain so SPF/DKIM/DMARC are already aligned - which decides inbox versus spam for letters sent to personal addresses.",
    "requiredRelaySettings": {
      "recipients": "Any addresses - REQUIRED, because the welcome letter goes to a personal address outside the domain",
      "requireTls": true,
      "allowedSenders": "the dedicated no-reply account",
      "requireSmtpAuth": true
    },
    "whyThisAndNotTheGmailApi": "Sending through the Gmail API requires acting as a mailbox. Service accounts have none, and impersonating a user's mailbox requires Domain-Wide Delegation, which the customer explicitly ruled out."
  },
  "response": {
    "messageId": "persisted on the step as the delivery id",
    "smtpResult": "synchronous accept or reject at submission time, persisted on the step"
  },
  "returnPath": "a monitored Workspace group, so asynchronous bounces land somewhere a human reads",
  "description": "The system's single outbound mail channel, carrying two message types through one sender and one relay: the welcome letter to a new hire's out-of-band address, and the approval notice to eligible approvers. One NotificationSender interface, one credential, one delivery path.",
  "messageTypes": {
    "welcome-letter": {
      "contains": "account name and instructions to sign in at Google and set a password",
      "recipient": "the notificationAddress on the request - an out-of-band personal address, never the new primary mailbox",
      "idempotency": "the notification step's idempotency key - a retry after a successful send must not produce a second letter",
      "neverContains": [
        "the one-time password",
        "any token or link into this application"
      ],
      "recipientIsNotAnIapPrincipal": "which is why this message contains no link into the application at all"
    },
    "approver-notification": {
      "whyThin": "an approver clicking through sees everything in the console behind IAP; mail is the worst place to put change detail",
      "contains": "request id, phase, target user, requester, approval deadline when configured, and a link to the request in the console",
      "recipient": "identities eligible to approve the halted step, resolved from roleBindings against the snapshotted policy, excluding the requester",
      "idempotency": "keyed on requestId + stepId - a redelivery does not resend",
      "neverContains": [
        "the computed diff",
        "any attribute value",
        "any credential or token"
      ],
      "recipientIsAnIapPrincipal": "so the console link is safe here: an approver who is not signed in is authenticated at the perimeter before seeing anything. This is the opposite of the welcome-letter case and is why one message may link into the app and the other may not."
    }
  },
  "failureSemantics": {
    "welcome-letter": "records the provider error on the step and leaves the request resumable",
    "approver-notification": "records the error and retries, but leaves the request in awaiting_approval - the approval is still pending, only the telling failed"
  },
  "deliveryTelemetryLimit": "SMTP gives a synchronous accept/reject only. Asynchronous bounces return to the Return-Path mailbox rather than to a webhook, and without Domain-Wide Delegation the application cannot read that mailbox programmatically - so bounce detection is human-monitored."
}
```

## Dependency Chain

Startup/initialization order based on edge directions and interaction patterns.

**Depends on THIS node being available:**
- Lifecycle Step Executor (calls this node via Welcome Letter Delivery (rest))

## Error Handling Contracts

**Errors this node MUST emit to consumers:**
- HTTP error responses to Lifecycle Step Executor ("Welcome Letter Delivery"): return proper 4xx for validation errors, 401/403 for auth failures, 5xx for internal errors with correlation IDs
