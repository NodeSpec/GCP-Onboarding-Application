# Task: Lifecycle API Service

> **Scope:** implement ONLY this node ("Lifecycle API Service"). Work belonging to other nodes appears here solely as interfaces and coordination points — do not implement or re-derive it.
> This document is DERIVED from the NodeSpec model + catalog (fingerprinted, regenerable via generate_task_docs). Node context/export is the model truth; propose model changes through the proposal flow — hand-edits to model facts here do not change the model.

## Component Purpose

**Role:** Backend Service
**Technology:** Node.js
**Description:** Server-side application or microservice

## Your Deliverable

**Working code for this component**, honoring the contracts and criteria below, plus its configuration artifacts and tests.

## Implementation Context

<!-- AI-AUTHORED SECTION: NodeSpec never writes prose here. Your text survives regeneration verbatim while the derived sections around it keep refreshing. -->
_Not yet authored._ **Consuming AI — author this section BEFORE building.** Working from this full packet plus the repository, record the project-specific context no catalog can know: how this node's technology composes with its neighbors in THIS project, the integration specifics behind each interface contract, configuration rationale, and your intended implementation approach. Replace this placeholder (keep the heading) either by editing this file in the repo and pushing — NodeSpec surfaces the edit as a change card for the user to accept — or via an update_artifact patch through propose_patches. If a REVIEW-NEEDED line appears here later, the derived context changed after you wrote this: re-verify the section, then delete that line.

## Implementation Tasks

Ordered WORK ORDERS synthesized from the model — this node's deliverable kind, contracts, criterion attribution, configuration, and dependency chain. They guarantee coverage, scope, and traceability; they deliberately do NOT contain the implementation detail — that is your job (see the expansion directive below the list).

- [ ] **T1 — Scaffold the Node.js component.**
  Create the source layout, build files, and test harness this node's working code lives in.
  Start from the catalog's suggested structure: `src/index.ts`, `src/routes/index.ts`, `package.json`, `tsconfig.json`.
- [ ] **T2 — Implement the integration with Identity-Aware Proxy (gcp-identity-aware-proxy) per Contract "IAP Assertion Verification (JWK Set)" (rest).**
  Build to the contract schema EXACTLY (see Interface Contracts).
  ↳ serves (unverified match): REQ-010 "When a request is refused with 401 by assertion verification, or with 403 by the self-approval guard or a role check, the API shall write an audit event carrying the refusal reason, the requested path, and the source IP, recording actor identity only where verification succeeded" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-010 "When any audit event is written, the API shall persist a payload containing no password, no ciphertext, no secret value, and no raw JWT assertion, verified by a test that drives every audit-writing path and asserts on the persisted documents" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-007 "Every load-balancer backend service in the deployment has IAP enabled — asserted against the committed Terraform, so a backend added without IAP fails the check" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-007 "IAP is enabled on the operator backend service and access is granted only to the intended operator group in the OAuth/IAM configuration" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-017 "The one-time password is returned only to the authenticated operator who created the request, verified against the IAP identity, and a retrieval attempt by any other operator returns 403" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T3 — Implement the integration with Cloud Logging: audit sink (gcp-cloud-logging) per Contract "Audit Log Sink" (dependency).**
  Dependency contract — capture the reference/identifier wiring in this node's config artifacts; no payload schema expected.
  ↳ serves (unverified match): REQ-012 "The admin role can edit approval policy, cancel or resume any request, and read the full audit trail" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-012 "Role binding changes write audit events recording the actor, the subject, and the before/after roles" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-010 "Each audit event records actor identity, action, target user, before/after state, outcome, and timestamp" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-010 "When an operator performs an approve, reject, cancel, resume, credential retrieval, or role-binding change, the API shall write the audit event and the state change it describes in a single Firestore transaction, verified by a test that forces the transaction to fail and observes neither the state change nor the audit event" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-010 "When an automated step writes an audit event, the API shall record the actor as the system principal and shall also record the originating human requester of the parent request, so no machine action is left unattributable" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-010 "The data access layer exposes no update or delete operation against the audit collection, verified by a test asserting the module's public surface and by a repository check for direct Firestore delete calls on that collection" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-010 "When an operator requests the audit history for a lifecycle request, the API shall return every audit event recorded against that request in ascending timestamp order, with no event omitted" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-031 "A refused attempt writes an audit event naming the operator, the targeted protected account, and the action attempted" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-017 "The decrypted plaintext appears only in the response body — never in a URL, a redirect target, or any log entry" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-017 "Every retrieval attempt — success, wrong operator, second attempt, expired — produces an audit event naming the operator identity" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T4 — Implement the integration with Secret Manager (gcp-secret-manager) per Contract "Secret Manager Access" (dependency).**
  Dependency contract — capture the reference/identifier wiring in this node's config artifacts; no payload schema expected.
- [ ] **T5 — Implement the integration with Cloud Tasks: lifecycle-steps (gcp-cloud-tasks) per Contract "Step Task Enqueue" (rest).**
  Build to the contract schema EXACTLY (see Interface Contracts).
  ↳ serves (unverified match): REQ-002 "When a step enters 'awaiting_approval' with an expiry configured, a Cloud Task is scheduled for the expiry instant; if the approval is still pending when that task fires the request terminates in 'rejected' with reason 'approval_expired', and if the step was already decided the task is a no-op" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-002 "With requiresApproval=false for every step, a request runs end to end with no human interaction beyond submission" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-031 "A create, update or delete request targeting an address on the protected-account list is refused at admission with 409 and a typed ProtectedAccount error, and no request or step document is persisted" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-007 "The lifecycle-worker service admits exactly two caller identities, each confined to its own route class: the Cloud Tasks queue invoker on /tasks/*, and the lifecycle-api service account on /lookup/*. A token issued to either identity is rejected with 401 on the other's routes, and an unauthenticated request is rejected on both" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T6 — Implement the integration with Firestore: lifecycle state and audit (gcp-firestore) per Contract "Lifecycle State Store" (nosql).**
  Build to the contract schema EXACTLY (see Interface Contracts).
  ↳ serves (unverified match): REQ-017 "Retrieval reads and clears the ciphertext inside a single Firestore transaction, so two concurrent retrievals yield exactly one success" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T7 — Implement the integration with Lifecycle Step Executor (nodejs) per Contract "Directory Lookup (read-only)" (rest).**
  Build to the contract schema EXACTLY (see Interface Contracts).
- [ ] **T8 — Expose the interface External HTTPS Load Balancer consumes, per Contract "IAP-Protected HTTPS Ingress" (rest).**
  Record the endpoint/identifiers External HTTPS Load Balancer needs in this node's config artifacts — coordinate with External HTTPS Load Balancer.
  Build to the contract schema EXACTLY (see Interface Contracts).
  ↳ serves (unverified match): REQ-031 "The dedicated no-reply sending account and the Return-Path monitoring group are on the protected list by default, so the system cannot break its own notification path" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-031 "The protected-account list is read from configuration and can be changed without a code release" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-031 "Matching is case-insensitive and covers the primary email and any alias, so a protected account cannot be reached through an alternate address" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-031 "The protected-account list is documented in the runbook alongside how to amend it, since an over-broad list silently blocks legitimate offboarding" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-007 "Each deployed Cloud Run service rejects a direct request to its *.run.app URL, proving the load balancer is the only ingress path into the system" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T9 — Expose the interface Operator Console UI consumes, per Contract "Lifecycle Operator API" (rest).**
  Record the endpoint/identifiers Operator Console UI needs in this node's config artifacts — coordinate with Operator Console UI.
  Build to the contract schema EXACTLY (see Interface Contracts).
  ↳ serves (unverified match): REQ-012 "Every API route declares a required role, and a call from an identity lacking it is rejected with 403 before the handler executes" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-012 "Every action the console offers is independently authorized server-side, verified by tests that call the API directly while bypassing the UI — hiding a control in the console is never the enforcement" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-031 "An operator with the admin role is refused just as a requester is — protection is not a permission level that can be escalated past" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T10 — Implement: "An authenticated identity with no role binding can read nothing and submit nothing — every route returns 403" (REQ-012).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-012 "An authenticated identity with no role binding can read nothing and submit nothing — every route returns 403"
- [ ] **T11 — Implement: "The requester role can create and submit requests but cannot approve any request, including requests created by others" (REQ-012).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-012 "The requester role can create and submit requests but cannot approve any request, including requests created by others"
- [ ] **T12 — Implement: "The approver role can approve requests created by others and is still refused approval of its own requests" (REQ-012).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-012 "The approver role can approve requests created by others and is still refused approval of its own requests"
- [ ] **T13 — Implement: "Group-based bindings resolve to the same effective permissions as an equivalent individual binding" (REQ-012).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-012 "Group-based bindings resolve to the same effective permissions as an equivalent individual binding"
- [ ] **T14 — Implement: "The deployed system exposes no unauthenticated route: an unauthenticated request to every path in the application's route table is rejected, enumerated as a test rather than spot-checked" (REQ-007).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-007 "The deployed system exposes no unauthenticated route: an unauthenticated request to every path in the application's route table is rejected, enumerated as a test rather than spot-checked"
- [ ] **T15 — Implement: "The one-time password can be retrieved exactly once; the ciphertext is destroyed on retrieval and a second attempt returns 410" (REQ-017).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-017 "The one-time password can be retrieved exactly once; the ciphertext is destroyed on retrieval and a second attempt returns 410"
- [ ] **T16 — Implement: "A retrieval after the credential record's TTL has expired returns 410 with the ciphertext already removed" (REQ-017).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-017 "A retrieval after the credential record's TTL has expired returns 410 with the ciphertext already removed"
- [ ] **T17 — Verify every acceptance criterion above and tick its box.**
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

### REQ-001: Lifecycle request creation and step-plan persistence
Category: functional | Status: in-progress
Owned by the Lifecycle API Service. Every lifecycle action (create, notify, update, delete) is admitted as a persisted LifecycleRequest plus one durable step document per step in the phase's step plan, written before any Workspace call is made. Each step record carries its own status (pending, awaiting_approval, ready, running, succeeded, failed, skipped), attempt counter, input snapshot, output, error, and a stable idempotency key. The API also owns the concurrency guard: a target user may have only one non-terminal request at a time, so two operators cannot drive conflicting changes against the same account. Durable execution of these steps is REQ-016, owned by the step executor.

**Acceptance criteria — your task boxes:**
- [x] Creating a lifecycle request persists a LifecycleRequest document plus one step document per step in the phase's step plan, all with status 'pending' and attempt=0, before any Workspace call is made
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] Submitting a request for a target user that already has a non-terminal request returns 409 and creates no second request, so two operators cannot drive conflicting changes against the same account concurrently
  → possible match: Contract "Lifecycle Operator API" (rest) from Operator Console UI (unverified — requirement not mapped to that node)
- [x] Each persisted step carries a stable idempotency key derived from requestId, stepId and an attempt-invariant payload hash, distinct across requests and steps
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] The submitted payload is validated against the phase schema and rejected with 400 before any document is persisted
  → THIS NODE: internal logic
- [x] The full step history of a request (status, attempts, timestamps, actor, error) is retrievable through a single API call for operator inspection
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] The first step of a newly created request is either dispatched or halted in 'awaiting_approval' according to the policy snapshotted onto the request
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] When the first step is halted in 'awaiting_approval', the approver-notification record is written in the same Firestore transaction as the halt, so a halt can never be committed without its notification record; the notification task is then enqueued from that record after the transaction commits, and an enqueue that fails leaves the record outstanding for a sweeper rather than losing the halt (REQ-032 performs the send)
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)

### REQ-012: Operator role model derived from verified identity
Category: functional | Status: in-progress
IAP proves who the caller is; the application decides what they may do. Operator identities from the verified assertion are mapped to application roles — requester (may draft and submit requests), approver (may approve or reject requests they did not create), admin (may edit approval policy, cancel or resume any request, and read the full audit trail) — through a role binding store keyed on the verified email, supporting both individual and Google-group-based bindings. Every API route declares its required role and is checked server-side on every call. Role assignment changes are themselves audited, and an operator with no binding is authenticated but authorized for nothing.

**Acceptance criteria — your task boxes:**
- [ ] Every API route declares a required role, and a call from an identity lacking it is rejected with 403 before the handler executes
  → covered by Task T9
- [ ] An authenticated identity with no role binding can read nothing and submit nothing — every route returns 403
  → covered by Task T10
- [ ] The requester role can create and submit requests but cannot approve any request, including requests created by others
  → covered by Task T11
- [ ] The approver role can approve requests created by others and is still refused approval of its own requests
  → covered by Task T12
- [ ] The admin role can edit approval policy, cancel or resume any request, and read the full audit trail
  → covered by Task T3
- [ ] Role binding changes write audit events recording the actor, the subject, and the before/after roles
  → covered by Task T3
- [ ] Group-based bindings resolve to the same effective permissions as an equivalent individual binding
  → covered by Task T13
- [ ] Every action the console offers is independently authorized server-side, verified by tests that call the API directly while bypassing the UI — hiding a control in the console is never the enforcement
  → covered by Task T9

### REQ-002: Optional two-party approval on any step
Category: functional | Status: in-progress
Any step in any lifecycle phase can be marked as requiring two-party approval by policy. When a step requires approval, execution halts at that step in status 'awaiting_approval' until a second, distinct human identity approves it. The requester may never approve their own request (enforced server-side against the IAP-verified identity, not a client-supplied field). Approval policy is configuration, not code: a policy document declares, per phase and per step, whether approval is required, which operator role may approve, and an optional expiry after which the pending approval auto-rejects. Approvals and rejections are recorded with the approver identity, timestamp, and free-text justification. Rejecting a step terminates the request in status 'rejected' and dispatches no further steps.

**Acceptance criteria — your task boxes:**
- [x] A step whose policy sets requiresApproval=true halts in status 'awaiting_approval' and dispatches no Workspace call until approved
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] An approval attempt by the same identity that created the request is rejected with 403 and the step remains in 'awaiting_approval'
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] An approval by a distinct identity holding the required approver role transitions the step to 'ready' and dispatches its execution task
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] A rejection transitions the request to 'rejected', records approver identity, timestamp and justification, and dispatches no further steps
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] An approval or rejection submitted with an empty or whitespace-only justification is refused by the server with 400, independently of any client-side check
  → THIS NODE: internal logic
- [x] Approval policy is read from configuration at request-creation time and snapshotted onto the request, so a later policy edit cannot retroactively change an in-flight request's approval requirements
  → THIS NODE: internal logic
- [ ] When a step enters 'awaiting_approval' with an expiry configured, a Cloud Task is scheduled for the expiry instant; if the approval is still pending when that task fires the request terminates in 'rejected' with reason 'approval_expired', and if the step was already decided the task is a no-op
  → covered by Task T5
- [ ] With requiresApproval=false for every step, a request runs end to end with no human interaction beyond submission
  → covered by Task T5

### REQ-010: Audit event model, operator-action auditing and log redaction
Category: non-functional | Status: in-progress
Owned by the Lifecycle API Service, which also owns the shared audit and logging library both services use. Every operator action — approval, rejection, cancellation, resume, credential retrieval, role-binding change — and every authorization failure writes an append-only audit event carrying event id, request id, step id, actor identity (from the verified IAP assertion, or the system principal for automated steps), action, before/after state, target user, outcome, and timestamp. Audit events are written in the same Firestore transaction as the state change they describe.

Append-only in Firestore is enforced by the data access layer, which exposes no update or delete path for the audit collection. Note explicitly that Firestore security rules do NOT apply here, because all access is server-side through Admin SDK credentials which bypass rules entirely, and Firestore IAM is database-scoped rather than per-collection, so neither is a real control. Tamper-evident retention is REQ-018. Worker-side transition auditing is carried by REQ-016.

The redaction filter lives here too: secrets, passwords, ciphertext, and raw JWT assertions never reach any log sink.

**Acceptance criteria — your task boxes:**
- [ ] Each audit event records actor identity, action, target user, before/after state, outcome, and timestamp
  → covered by Task T3
- [ ] When an operator performs an approve, reject, cancel, resume, credential retrieval, or role-binding change, the API shall write the audit event and the state change it describes in a single Firestore transaction, verified by a test that forces the transaction to fail and observes neither the state change nor the audit event
  → covered by Task T3
- [ ] When a request is refused with 401 by assertion verification, or with 403 by the self-approval guard or a role check, the API shall write an audit event carrying the refusal reason, the requested path, and the source IP, recording actor identity only where verification succeeded
  → covered by Task T2
- [ ] When an automated step writes an audit event, the API shall record the actor as the system principal and shall also record the originating human requester of the parent request, so no machine action is left unattributable
  → covered by Task T3
- [ ] The data access layer exposes no update or delete operation against the audit collection, verified by a test asserting the module's public surface and by a repository check for direct Firestore delete calls on that collection
  → covered by Task T3
- [x] A structured-logging redaction filter strips password, ciphertext, key, secret, token and assertion fields from every sink, verified by a test that logs a payload containing each and asserts on the emitted record
  → possible match: Contract "IAP Assertion Verification (JWK Set)" (rest) to Identity-Aware Proxy (unverified — requirement not mapped to that node)
- [ ] When any audit event is written, the API shall persist a payload containing no password, no ciphertext, no secret value, and no raw JWT assertion, verified by a test that drives every audit-writing path and asserts on the persisted documents
  → covered by Task T2
- [ ] When an operator requests the audit history for a lifecycle request, the API shall return every audit event recorded against that request in ascending timestamp order, with no event omitted
  → covered by Task T3

### REQ-031: Protected accounts excluded from lifecycle targeting
Category: technical | Status: in-progress
Owned by the Lifecycle API Service. This application manages Workspace users, and several Workspace users are load-bearing for the application itself — most pointedly the dedicated no-reply account whose app password sends every welcome letter (REQ-028). Nothing currently stops an operator submitting a delete request against it, which would silently break onboarding for everyone and leave no obvious cause: the letters simply stop arriving. Break-glass administrator accounts and the Return-Path monitoring group have the same property.

A configured protected-account list is therefore checked at request admission and any request targeting a protected principal is refused. Enforcement lives at admission rather than at execution because REQ-001 makes the API the sole creator of requests and steps — the worker only ever executes steps that already exist, so there is no path to a Workspace mutation that bypasses this check, and a second guard in the worker would be redundant rather than defence in depth.

The list is configuration, not code, so a tenant can protect its own break-glass accounts without a release. Refusals are audited, because an attempt to offboard a protected account is exactly the signal a security team wants to see.

**Acceptance criteria — your task boxes:**
- [ ] A create, update or delete request targeting an address on the protected-account list is refused at admission with 409 and a typed ProtectedAccount error, and no request or step document is persisted
  → covered by Task T5
- [ ] The dedicated no-reply sending account and the Return-Path monitoring group are on the protected list by default, so the system cannot break its own notification path
  → covered by Task T8
- [ ] The protected-account list is read from configuration and can be changed without a code release
  → covered by Task T8
- [ ] Matching is case-insensitive and covers the primary email and any alias, so a protected account cannot be reached through an alternate address
  → covered by Task T8
- [ ] A refused attempt writes an audit event naming the operator, the targeted protected account, and the action attempted
  → covered by Task T3
- [ ] An operator with the admin role is refused just as a requester is — protection is not a permission level that can be escalated past
  → covered by Task T9
- [ ] The protected-account list is documented in the runbook alongside how to amend it, since an over-broad list silently blocks legitimate offboarding
  → covered by Task T8

### REQ-007: IAP protection with server-side JWT assertion verification
Category: technical | Status: in-progress
The customer's constraint is that the serverless application is protected by IAP and verifies the JWT header so the security controls cannot be bypassed. This requirement states exactly how far that protection reaches across the deployed services, so the coverage is auditable rather than assumed. There are no exceptions: the system exposes no unauthenticated route of any kind.

OPERATOR SURFACE (lifecycle-api, serving the console and the operator API): the only load-balancer backend service in the system. IAP is enabled on it, and the application independently verifies IAP's signed assertion on every request rather than trusting the perimeter. Middleware reads the x-goog-iap-jwt-assertion header, verifies the ES256 signature against Google's IAP public JWK set (cached with refresh on unknown kid), and checks issuer == https://cloud.google.com/iap, the exact expected audience string /projects/PROJECT_NUMBER/global/backendServices/BACKEND_SERVICE_ID, and exp/iat within tolerance. The verified email and sub claims become the request identity; no client-supplied header or body field may ever set identity. A request without a valid assertion is rejected with 401 before any route handler runs — fail closed.

WORKER (lifecycle-worker): not IAP-protected, and deliberately so — IAP is a control on human access, and the worker has no human ingress path. It is not attached to the load balancer at all. It is protected by Cloud Run ingress restricted to internal-and-cloud-load-balancing, run.invoker granted only to the Cloud Tasks queue's invoker service account, and a required OIDC token on every request. This is stated explicitly so that "not behind IAP" is a documented, tested property rather than something the customer discovers.

Across both services, Cloud Run ingress is restricted to internal-and-cloud-load-balancing and run.invoker is granted only to the appropriate caller identity, so a direct *.run.app request cannot reach either of them.

There is no end-user-facing surface anywhere in this system. Users being onboarded never interact with the application; they receive a letter and use Google's own sign-in and password-change flow. That is what allows total IAP coverage, and any future feature that would require an unauthenticated route is a change to this requirement and needs the customer's agreement first.

**Acceptance criteria — your task boxes:**
- [x] Every operator-facing route rejects a request carrying no x-goog-iap-jwt-assertion header with 401, and no route handler is invoked
  → possible match: Contract "IAP Assertion Verification (JWK Set)" (rest) to Identity-Aware Proxy (unverified — requirement not mapped to that node)
- [x] A request with a syntactically valid but wrongly-signed assertion is rejected with 401
  → possible match: Contract "IAP Assertion Verification (JWK Set)" (rest) to Identity-Aware Proxy (unverified — requirement not mapped to that node)
- [x] A request whose assertion carries a different audience string than the configured backend-service audience is rejected with 401
  → possible match: Contract "IAP Assertion Verification (JWK Set)" (rest) to Identity-Aware Proxy (unverified — requirement not mapped to that node)
- [x] A request whose assertion carries an issuer other than https://cloud.google.com/iap is rejected with 401
  → possible match: Contract "IAP Assertion Verification (JWK Set)" (rest) to Identity-Aware Proxy (unverified — requirement not mapped to that node)
- [x] An expired assertion (exp in the past beyond the configured skew) is rejected with 401
  → possible match: Contract "IAP Assertion Verification (JWK Set)" (rest) to Identity-Aware Proxy (unverified — requirement not mapped to that node)
- [x] A valid assertion populates the request identity from the token's email and sub claims, and a client-supplied identity header or body field is ignored and never overrides it
  → possible match: Contract "IAP Assertion Verification (JWK Set)" (rest) to Identity-Aware Proxy (unverified — requirement not mapped to that node)
- [x] An unknown key id triggers a JWK set refresh and the request succeeds if the refreshed set contains the key; a still-unknown kid is rejected with 401
  → THIS NODE: internal logic
- [x] Verification failures are logged with the reason and source IP but never log the raw assertion
  → possible match: Contract "IAP Assertion Verification (JWK Set)" (rest) to Identity-Aware Proxy (unverified — requirement not mapped to that node)
- [ ] Each deployed Cloud Run service rejects a direct request to its *.run.app URL, proving the load balancer is the only ingress path into the system
  → covered by Task T8
- [ ] The lifecycle-worker service admits exactly two caller identities, each confined to its own route class: the Cloud Tasks queue invoker on /tasks/*, and the lifecycle-api service account on /lookup/*. A token issued to either identity is rejected with 401 on the other's routes, and an unauthenticated request is rejected on both
  → covered by Task T5
- [ ] Every load-balancer backend service in the deployment has IAP enabled — asserted against the committed Terraform, so a backend added without IAP fails the check
  → covered by Task T2
- [ ] The deployed system exposes no unauthenticated route: an unauthenticated request to every path in the application's route table is rejected, enumerated as a test rather than spot-checked
  → covered by Task T14
- [ ] IAP is enabled on the operator backend service and access is granted only to the intended operator group in the OAuth/IAM configuration (manual)
  → covered by Task T2

### REQ-017: One-time password retrieval by the requesting operator
Category: functional | Status: in-progress
Owned by the Lifecycle API Service. Credential handoff is split-channel: the welcome letter carries no credential, and the generated one-time password is retrieved exactly once by the operator who created the request, through the IAP-protected console, then handed to the new hire out of band. Retrieval decrypts the stored ciphertext using the credential data-encryption key, returns the plaintext once, and destroys the ciphertext in the same transaction — so two concurrent retrievals yield exactly one success. Only the originating requester may retrieve it; any other operator, including an admin, is refused. This is the only path by which a credential leaves the system, and it terminates at an authenticated operator inside the perimeter — the person being onboarded never touches this application.

**Acceptance criteria — your task boxes:**
- [ ] The one-time password is returned only to the authenticated operator who created the request, verified against the IAP identity, and a retrieval attempt by any other operator returns 403
  → covered by Task T2
- [ ] The one-time password can be retrieved exactly once; the ciphertext is destroyed on retrieval and a second attempt returns 410
  → covered by Task T15
- [ ] Retrieval reads and clears the ciphertext inside a single Firestore transaction, so two concurrent retrievals yield exactly one success
  → covered by Task T6
- [ ] A retrieval after the credential record's TTL has expired returns 410 with the ciphertext already removed
  → covered by Task T16
- [ ] The decrypted plaintext appears only in the response body — never in a URL, a redirect target, or any log entry
  → covered by Task T3
- [ ] Every retrieval attempt — success, wrong operator, second attempt, expired — produces an audit event naming the operator identity
  → covered by Task T3

## Interface Contracts

### SENDS TO: Identity-Aware Proxy (auth-provider)
- **Contract:** IAP Assertion Verification (JWK Set)
- **Protocol:** rest
- **Transport:** http
- **Spec Format:** oauth_oidc
- **Their Technology:** gcp-identity-aware-proxy

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

### SENDS TO: Cloud Logging: audit sink (logging)
- **Contract:** Audit Log Sink
- **Protocol:** dependency
- **Their Technology:** gcp-cloud-logging

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

### SENDS TO: Secret Manager (secret-manager)
- **Contract:** Secret Manager Access
- **Protocol:** dependency
- **Their Technology:** gcp-secret-manager

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

### SENDS TO: Cloud Tasks: lifecycle-steps (queue)
- **Contract:** Step Task Enqueue
- **Protocol:** rest
- **Transport:** http
- **Their Technology:** gcp-cloud-tasks

**Schema:**
```
{
  "queue": {
    "name": "lifecycle-steps",
    "rateLimits": {
      "maxDispatchesPerSecond": 10,
      "maxConcurrentDispatches": 20
    },
    "retryConfig": {
      "maxAttempts": 8,
      "maxDoublings": 4,
      "maxBackoffSeconds": 600,
      "minBackoffSeconds": 5
    }
  },
  "oidcToken": {
    "audience": "{WORKER_BASE_URL}",
    "appliesTo": "both task types",
    "serviceAccountEmail": "{QUEUE_INVOKER_SA}"
  },
  "taskTypes": {
    "execute-step": {
      "url": "{WORKER_BASE_URL}/tasks/execute-step",
      "enqueuedBy": [
        "lifecycle-api (first step of a request)",
        "lifecycle-worker (each subsequent step)"
      ],
      "httpMethod": "POST",
      "bodyContract": "Step Execution Dispatch",
      "scheduleTime": "optional - carries the offboarding hold period and the approval expiry sweep",
      "deduplication": "task name derived from the step idempotency key, so a double-enqueue of the same step collapses to one task"
    },
    "notify-approvers": {
      "url": "{WORKER_BASE_URL}/tasks/notify-approvers",
      "body": {
        "stepId": "string",
        "requestId": "string"
      },
      "enqueuedBy": [
        "lifecycle-api (when it halts a request's first step)",
        "lifecycle-worker (when it halts any subsequent step)"
      ],
      "httpMethod": "POST",
      "deduplication": "task name derived from requestId + stepId + 'approver-notification', so a redelivery or a double-halt collapses to one task",
      "whyThroughTheQueue": "Only the worker holds the SMTP credential. Routing notification through the queue means the API service never needs one, and the notification inherits this queue's retry budget rather than growing a second delivery path.",
      "enqueuedTransactionally": "in the SAME Firestore transaction as the halt, so a step cannot be committed as awaiting_approval without its notification being scheduled"
    }
  },
  "description": "The API service and the worker enqueue Cloud Tasks for the worker to execute. Two task types share the queue: step execution, and approver notification. Cloud Tasks provides at-least-once delivery, backoff and the retry budget - the application provides idempotency."
}
```

### RECEIVES FROM: External HTTPS Load Balancer (load-balancer)
- **Contract:** IAP-Protected HTTPS Ingress
- **Protocol:** rest
- **Transport:** http
- **Their Technology:** gcp-cloud-load-balancing

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

### RECEIVES FROM: Operator Console UI (frontend-app)
- **Contract:** Lifecycle Operator API
- **Protocol:** rest
- **Transport:** http
- **Spec Format:** openapi
- **Their Technology:** react

**Schema:**
```
{
  "info": {
    "title": "Lifecycle Operator API",
    "version": "1.0.0",
    "description": "The operator console's only backend. Every route requires a verified IAP assertion and declares a required application role."
  },
  "paths": {
    "/api/me": {
      "get": {
        "summary": "Signed-in identity and effective roles, derived server-side from the verified assertion",
        "responses": {
          "200": {
            "schema": {
              "$ref": "#/components/schemas/Identity"
            }
          }
        },
        "requiredRole": "any authenticated"
      }
    },
    "/api/roles": {
      "get": {
        "summary": "Operator role bindings",
        "requiredRole": "admin"
      },
      "put": {
        "summary": "Set operator role bindings (individual or Google-group)",
        "requiredRole": "admin"
      }
    },
    "/api/policy": {
      "get": {
        "summary": "Current approval policy",
        "requiredRole": "admin"
      },
      "put": {
        "summary": "Replace approval policy; affects only requests created after the change",
        "requestBody": {
          "schema": {
            "$ref": "#/components/schemas/ApprovalPolicy"
          }
        },
        "requiredRole": "admin"
      }
    },
    "/api/requests": {
      "get": {
        "summary": "List lifecycle requests",
        "responses": {
          "200": {
            "schema": {
              "$ref": "#/components/schemas/RequestPage"
            }
          }
        },
        "parameters": [
          "phase",
          "status",
          "targetUser",
          "cursor",
          "limit"
        ],
        "requiredRole": "requester|approver|admin"
      },
      "post": {
        "summary": "Create and submit a lifecycle request",
        "responses": {
          "201": {
            "schema": {
              "$ref": "#/components/schemas/LifecycleRequest"
            }
          },
          "400": "schema validation failure",
          "409": "conflicting in-flight request for the same target user"
        },
        "requestBody": {
          "schema": {
            "$ref": "#/components/schemas/CreateRequest"
          }
        },
        "requiredRole": "requester|admin"
      }
    },
    "/api/requests/{requestId}": {
      "get": {
        "summary": "Request detail including snapshotted approval policy and computed diff",
        "responses": {
          "200": {
            "schema": {
              "$ref": "#/components/schemas/LifecycleRequest"
            }
          }
        },
        "requiredRole": "requester|approver|admin"
      }
    },
    "/api/requests/{requestId}/audit": {
      "get": {
        "summary": "Chronological audit history for the request",
        "responses": {
          "200": {
            "schema": {
              "type": "array",
              "items": {
                "$ref": "#/components/schemas/AuditEvent"
              }
            }
          }
        },
        "requiredRole": "admin"
      }
    },
    "/api/requests/{requestId}/steps": {
      "get": {
        "summary": "Ordered step timeline with status, attempts, timestamps and errors",
        "responses": {
          "200": {
            "schema": {
              "type": "array",
              "items": {
                "$ref": "#/components/schemas/Step"
              }
            }
          }
        },
        "requiredRole": "requester|approver|admin"
      }
    },
    "/api/requests/{requestId}/cancel": {
      "post": {
        "summary": "Cancel a held or awaiting request; unsuspends the account when cancelling during an offboarding hold",
        "responses": {
          "200": "request transitioned to cancelled"
        },
        "requiredRole": "admin"
      }
    },
    "/api/requests/{requestId}/resume": {
      "post": {
        "summary": "Re-dispatch the first non-terminal step of a failed request",
        "responses": {
          "200": "step re-dispatched",
          "409": "request is not in a resumable state"
        },
        "requiredRole": "admin"
      }
    },
    "/api/requests/{requestId}/credential": {
      "get": {
        "summary": "One-time retrieval of the generated initial password in split-channel mode",
        "responses": {
          "200": {
            "schema": {
              "type": "object",
              "properties": {
                "oneTimePassword": {
                  "type": "string"
                }
              }
            }
          },
          "410": "already retrieved or expired"
        },
        "requiredRole": "the originating requester only"
      }
    },
    "/api/requests/{requestId}/steps/{stepId}/reject": {
      "post": {
        "summary": "Reject a step awaiting approval; terminates the request",
        "responses": {
          "200": "request transitioned to rejected; no further steps dispatched"
        },
        "requestBody": {
          "schema": {
            "$ref": "#/components/schemas/ApprovalDecision"
          }
        },
        "requiredRole": "approver|admin"
      }
    },
    "/api/requests/{requestId}/steps/{stepId}/approve": {
      "post": {
        "summary": "Approve a step awaiting two-party approval",
        "responses": {
          "200": "step transitioned to ready and its execution task dispatched",
          "403": "self-approval attempt, or caller lacks the approver role required by the snapshotted policy",
          "409": "step is not in awaiting_approval"
        },
        "requestBody": {
          "schema": {
            "$ref": "#/components/schemas/ApprovalDecision"
          }
        },
        "requiredRole": "approver|admin"
      }
    }
  },
  "openapi": "3.1.0",
  "components": {
    "schemas": {
      "Step": {
        "type": "object",
        "required": [
          "stepId",
          "name",
          "ordinal",
          "status",
          "attempts"
        ],
        "properties": {
          "name": {
            "type": "string"
          },
          "error": {
            "type": "object",
            "properties": {
              "code": {
                "type": "string"
              },
              "class": {
                "enum": [
                  "retryable",
                  "terminal",
                  "validation",
                  "permission"
                ]
              },
              "message": {
                "type": "string"
              }
            }
          },
          "status": {
            "enum": [
              "pending",
              "awaiting_approval",
              "ready",
              "running",
              "succeeded",
              "failed",
              "skipped"
            ]
          },
          "stepId": {
            "type": "string"
          },
          "ordinal": {
            "type": "integer"
          },
          "attempts": {
            "type": "integer"
          },
          "startedAt": {
            "type": "string",
            "format": "date-time"
          },
          "completedAt": {
            "type": "string",
            "format": "date-time"
          },
          "idempotencyKey": {
            "type": "string"
          },
          "requiresApproval": {
            "type": "boolean"
          }
        }
      },
      "Identity": {
        "type": "object",
        "required": [
          "email",
          "subject",
          "roles"
        ],
        "properties": {
          "email": {
            "type": "string",
            "format": "email"
          },
          "roles": {
            "type": "array",
            "items": {
              "enum": [
                "requester",
                "approver",
                "admin"
              ]
            }
          },
          "subject": {
            "type": "string"
          }
        }
      },
      "AuditEvent": {
        "type": "object",
        "required": [
          "eventId",
          "requestId",
          "actor",
          "action",
          "outcome",
          "timestamp"
        ],
        "properties": {
          "actor": {
            "type": "object",
            "properties": {
              "kind": {
                "enum": [
                  "human",
                  "system"
                ]
              },
              "email": {
                "type": "string"
              },
              "onBehalfOf": {
                "type": "string"
              }
            }
          },
          "after": {
            "type": "object"
          },
          "action": {
            "type": "string"
          },
          "before": {
            "type": "object"
          },
          "stepId": {
            "type": "string"
          },
          "eventId": {
            "type": "string"
          },
          "outcome": {
            "enum": [
              "success",
              "failure",
              "denied"
            ]
          },
          "requestId": {
            "type": "string"
          },
          "timestamp": {
            "type": "string",
            "format": "date-time"
          },
          "targetUser": {
            "type": "string"
          }
        }
      },
      "RequestPage": {
        "type": "object",
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/components/schemas/LifecycleRequest"
            }
          },
          "nextCursor": {
            "type": "string"
          }
        }
      },
      "CreatePayload": {
        "type": "object",
        "required": [
          "primaryEmail",
          "givenName",
          "familyName",
          "notificationAddress"
        ],
        "properties": {
          "title": {
            "type": "string"
          },
          "groups": {
            "type": "array",
            "items": {
              "type": "string",
              "format": "email"
            }
          },
          "givenName": {
            "type": "string"
          },
          "department": {
            "type": "string"
          },
          "familyName": {
            "type": "string"
          },
          "orgUnitPath": {
            "type": "string",
            "default": "/"
          },
          "managerEmail": {
            "type": "string",
            "format": "email"
          },
          "primaryEmail": {
            "type": "string",
            "format": "email"
          },
          "customSchemas": {
            "type": "object",
            "additionalProperties": true
          },
          "notificationAddress": {
            "type": "string",
            "format": "email",
            "description": "Out-of-band address for the welcome letter. Must not be the new primary email."
          }
        }
      },
      "CreateRequest": {
        "type": "object",
        "required": [
          "phase",
          "payload"
        ],
        "properties": {
          "phase": {
            "enum": [
              "create",
              "notify",
              "update",
              "delete"
            ]
          },
          "payload": {
            "oneOf": [
              {
                "$ref": "#/components/schemas/CreatePayload"
              },
              {
                "$ref": "#/components/schemas/NotifyPayload"
              },
              {
                "$ref": "#/components/schemas/UpdatePayload"
              },
              {
                "$ref": "#/components/schemas/DeletePayload"
              }
            ]
          },
          "justification": {
            "type": "string"
          }
        }
      },
      "DeletePayload": {
        "type": "object",
        "required": [
          "primaryEmail"
        ],
        "properties": {
          "primaryEmail": {
            "type": "string",
            "format": "email"
          },
          "holdPeriodHours": {
            "type": "integer",
            "default": 0,
            "minimum": 0
          },
          "dataTransferSuccessor": {
            "type": "string",
            "format": "email"
          },
          "removeGroupsBeforeDelete": {
            "type": "boolean",
            "default": true
          }
        }
      },
      "NotifyPayload": {
        "type": "object",
        "required": [
          "primaryEmail",
          "notificationAddress",
          "mode"
        ],
        "properties": {
          "mode": {
            "enum": [
              "split-channel",
              "claim-link"
            ]
          },
          "templateId": {
            "type": "string"
          },
          "primaryEmail": {
            "type": "string",
            "format": "email"
          },
          "templateVersion": {
            "type": "string"
          },
          "notificationAddress": {
            "type": "string",
            "format": "email"
          }
        }
      },
      "UpdatePayload": {
        "type": "object",
        "required": [
          "primaryEmail"
        ],
        "properties": {
          "addGroups": {
            "type": "array",
            "items": {
              "type": "string",
              "format": "email"
            }
          },
          "attributes": {
            "type": "object",
            "description": "Desired values for changed attributes only",
            "additionalProperties": true
          },
          "orgUnitPath": {
            "type": "string"
          },
          "primaryEmail": {
            "type": "string",
            "format": "email"
          },
          "removeGroups": {
            "type": "array",
            "items": {
              "type": "string",
              "format": "email"
            }
          }
        }
      },
      "ApprovalPolicy": {
        "type": "object",
        "constraints": [
          "the delete phase's delete step may not set requiresApproval=false"
        ],
        "description": "Per-phase, per-step approval configuration. Snapshotted onto each request at creation.",
        "additionalProperties": {
          "type": "object",
          "additionalProperties": {
            "type": "object",
            "properties": {
              "expiryHours": {
                "type": "integer"
              },
              "approverRole": {
                "enum": [
                  "approver",
                  "admin"
                ]
              },
              "requiresApproval": {
                "type": "boolean"
              }
            }
          }
        }
      },
      "ApprovalDecision": {
        "type": "object",
        "required": [
          "justification"
        ],
        "properties": {
          "justification": {
            "type": "string",
            "minLength": 1
          }
        }
      },
      "LifecycleRequest": {
        "type": "object",
        "required": [
          "requestId",
          "phase",
          "status",
          "requestedBy",
          "createdAt",
          "policySnapshot"
        ],
        "properties": {
          "phase": {
            "enum": [
              "create",
              "notify",
              "update",
              "delete"
            ]
          },
          "status": {
            "enum": [
              "draft",
              "running",
              "awaiting_approval",
              "held",
              "succeeded",
              "failed",
              "rejected",
              "cancelled"
            ]
          },
          "createdAt": {
            "type": "string",
            "format": "date-time"
          },
          "requestId": {
            "type": "string"
          },
          "targetUser": {
            "type": "string",
            "format": "email"
          },
          "requestedBy": {
            "type": "string",
            "format": "email"
          },
          "computedDiff": {
            "type": "object",
            "description": "For update requests: before/after per changed attribute and per group change"
          },
          "policySnapshot": {
            "$ref": "#/components/schemas/ApprovalPolicy"
          }
        }
      }
    }
  }
}
```

### SENDS TO: Firestore: lifecycle state and audit (database)
- **Contract:** Lifecycle State Store
- **Protocol:** nosql
- **Transport:** grpc
- **Their Technology:** gcp-firestore

**Schema:**
```
{
  "collections": {
    "auditEvents": {
      "docId": "eventId",
      "fields": {
        "actor": "{kind: human|system, email, onBehalfOf}",
        "after": "object|null",
        "action": "string",
        "before": "object|null",
        "stepId": "string|null",
        "outcome": "success|failure|denied",
        "requestId": "string",
        "timestamp": "timestamp",
        "targetUser": "string|null"
      },
      "indexes": [
        "requestId+timestamp asc",
        "actor.email+timestamp desc"
      ],
      "appendOnly": true,
      "enforcement": "append-only is enforced by the data access layer, which exposes no update or delete path for this collection. Firestore SECURITY RULES DO NOT APPLY - all access is server-side via Admin SDK credentials, which bypass rules entirely - and Firestore IAM is database-scoped rather than per-collection, so neither is a real control. Tamper-evidence comes from the Cloud Logging mirror with a locked retention policy."
    },
    "roleBindings": {
      "note": "The worker's read access here is a data-access-layer widening, not a security boundary change: Firestore IAM is database-scoped, so both services already share database-level access (REQ-014).",
      "docId": "normalized email or group address",
      "fields": {
        "kind": "user|group",
        "roles": "array of requester|approver|admin",
        "updatedAt": "timestamp",
        "updatedBy": "string"
      },
      "readableBy": [
        "lifecycle-api",
        "lifecycle-worker (to resolve approver-notification recipients - REQ-032)"
      ],
      "writableBy": [
        "lifecycle-api"
      ]
    },
    "approvalPolicy": {
      "docId": "current",
      "fields": {
        "policy": "object",
        "version": "number",
        "updatedAt": "timestamp",
        "updatedBy": "string"
      }
    },
    "lifecycleRequests": {
      "docId": "requestId",
      "fields": {
        "phase": "string",
        "status": "draft|running|awaiting_approval|held|succeeded|failed|rejected|cancelled",
        "payload": "object (validated request payload)",
        "createdAt": "timestamp",
        "holdUntil": "timestamp|null",
        "updatedAt": "timestamp",
        "targetUser": "string (email)",
        "requestedBy": "string (verified operator email)",
        "computedDiff": "object|null",
        "policySnapshot": "object (approval policy frozen at creation)"
      },
      "indexes": [
        "status+createdAt desc",
        "targetUser+createdAt desc",
        "phase+status",
        "targetUser+status (for the non-terminal in-flight conflict check)"
      ],
      "readableBy": [
        "lifecycle-api",
        "lifecycle-worker"
      ]
    },
    "credentialHandoffs": {
      "ttl": "expiresAt (Firestore TTL policy)",
      "docId": "requestId",
      "notes": "ENCRYPTED, not hashed: the operator must recover the actual password, and a hash cannot be reversed. Plaintext is never persisted.",
      "fields": {
        "expiresAt": "timestamp",
        "keyVersion": "string",
        "retrievedAt": "timestamp|null",
        "primaryEmail": "string",
        "oneTimePasswordCiphertext": "string (encrypted under the Secret Manager credential-encryption key)"
      },
      "accessBy": {
        "lifecycle-api": "read + decrypt-once for operator retrieval, then destroy the ciphertext",
        "lifecycle-worker": "create - generates the password, encrypts it, stores ciphertext only"
      }
    },
    "lifecycleRequests/{requestId}/steps": {
      "docId": "stepId",
      "fields": {
        "name": "string",
        "error": "object|null",
        "input": "object (snapshot at dispatch)",
        "output": "object|null",
        "status": "pending|awaiting_approval|ready|running|succeeded|failed|skipped",
        "ordinal": "number",
        "approval": "{approvedBy, decision, justification, at}|null",
        "attempts": "number",
        "startedAt": "timestamp|null",
        "completedAt": "timestamp|null",
        "idempotencyKey": "string",
        "requiresApproval": "boolean",
        "approverNotification": "{sentAt, recipients, deliveryId, error}|null - the idempotency record that stops a redelivered notify task resending"
      },
      "writableBy": [
        "lifecycle-worker",
        "lifecycle-api (creation, and approval transitions)"
      ]
    }
  },
  "description": "Firestore in Native mode. All lifecycle state is here - nothing durable lives in process memory. State transitions and their audit events are written in the same transaction.",
  "transactionRules": [
    "every status transition reads the current status inside the transaction and rejects illegal transitions",
    "every status transition writes its audit event in the same transaction",
    "a halt into awaiting_approval enqueues its approver-notification task in the same transaction, so a halt cannot be committed without the notification being scheduled",
    "duplicate task delivery observes a non-ready status and returns without side effects",
    "credential retrieval reads retrievedAt inside the transaction and refuses a second success"
  ]
}
```

### SENDS TO: Lifecycle Step Executor (worker)
- **Contract:** Directory Lookup (read-only)
- **Protocol:** rest
- **Transport:** http
- **Spec Format:** openapi
- **Their Technology:** nodejs

**Schema:**
```
{
  "info": {
    "title": "Directory Lookup",
    "version": "1.0.0",
    "description": "Read-only Workspace lookups the operator console needs to pick a target user, a group, or an org unit. Served by the worker because the worker holds the ONLY Workspace admin role - the API service never talks to the Directory API directly, so REQ-014's identity separation is preserved unchanged."
  },
  "paths": {
    "/lookup/users": {
      "get": {
        "summary": "Search domain users by prefix for the target-user picker",
        "backedBy": "Directory users.list with a query, read-only",
        "responses": {
          "200": "matching users: primaryEmail, fullName, orgUnitPath, suspended"
        },
        "parameters": [
          "q (prefix on primaryEmail, givenName, familyName)",
          "limit",
          "pageToken"
        ]
      }
    },
    "/lookup/groups": {
      "get": {
        "summary": "List domain groups for the group picker",
        "backedBy": "Directory groups.list",
        "responses": {
          "200": "groups: email, name, description"
        }
      }
    },
    "/lookup/orgunits": {
      "get": {
        "summary": "List org units for the orgUnitPath picker",
        "backedBy": "Directory orgunits.list",
        "responses": {
          "200": "org unit paths and names"
        }
      }
    },
    "/lookup/users/{primaryEmail}": {
      "get": {
        "summary": "Fetch one user plus current group memberships, for pre-filling an update request",
        "backedBy": "Directory users.get + members.list",
        "responses": {
          "200": "user attributes and current memberships",
          "404": "no such user in the domain"
        }
      }
    }
  },
  "openapi": "3.1.0",
  "security": {
    "caller": "OIDC token issued to the lifecycle-api runtime service account",
    "audience": "the worker service URL",
    "rationale": "Opening the worker to a second caller is the cost of this design. Confining each caller to its own route class is what keeps that cost bounded - the API can read the directory but can never invoke step execution.",
    "enforcement": "PER-ROUTE. The /lookup/* routes accept ONLY the API service identity. The /tasks/* routes accept ONLY the Cloud Tasks queue invoker identity. Neither identity may reach the other's routes, and a request bearing no OIDC token reaches nothing."
  },
  "invariants": [
    "Every route here is strictly read-only - no Directory mutation is reachable through this contract, verified by a test that enumerates the lookup router and asserts no write operation is bound",
    "Results are for picker population and pre-fill only; the authoritative pre-mutation state read still happens inside the executing step (REQ-013), because a lookup result is already stale by the time an operator submits",
    "Lookup responses are not cached beyond the request, so a group created moments ago is selectable"
  ]
}
```

## Technology Guidance

_Reference for executing the Implementation Tasks above — apply where relevant. The task list stands even where this guidance is thin._

**Purpose:** JavaScript/TypeScript on the server — the default backend for product teams already writing TS on the frontend (one language, shared types end-to-end). Spans API services, workers, webhook handlers, CLIs and realtime services. TypeScript is the default; plain JS needs a reason.

**SDK Initialization:**
```
npm init -y && npm install express typescript @types/express tsx && npx tsc --init
// src/server.ts
import express from "express";
const app = express();
app.use(express.json());
app.listen(3000);
```

**Common API Patterns:**

#### REST Endpoint
Express route handler with async DB query and error handling
```
app.get("/api/users/:id", async (req, res) => {
  const user = await db.users.findById(req.params.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json(user);
});
```

#### Middleware
Authentication middleware pattern
```
function authenticate(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try { req.user = verifyToken(token); next(); }
  catch { res.status(401).json({ error: "Invalid token" }); }
}
```

#### Error Handler
Global error handling middleware
```
app.use((err, req, res, _next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});
```

**Configuration Template:**
```
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

**Best Practices:**
- TypeScript strict mode + a schema validator (zod) at every boundary — request bodies, env vars, queue payloads
- Share types with the frontend through a workspace package — the reason this stack wins is losing it is the anti-pattern
- Structured logging (pino) + graceful shutdown (SIGTERM drains in-flight work) — the two ops basics AIs skip
- Pin the runtime version in package.json engines + the lockfile committed
- Worker-role nodes: one queue consumer per process, scale horizontally — do not thread inside Node

**Anti-Patterns to Avoid:**
- Blocking the event loop with sync CPU work — move it to a worker node or a queue
- Floating dependency ranges in production services
- Express-era callback patterns in new code — async/await everywhere
- Reading process.env at call sites instead of one validated config module

**Security:** Use helmet middleware for secure HTTP headers. Validate all input with a schema library (zod, joi). Use parameterized queries to prevent SQL injection. Set rate limiting on public endpoints. Never expose stack traces in production error responses. Use environment variables for secrets, never hardcode. Enable CORS with explicit origin allowlists.

**Integration Patterns:**
- Express or Fastify for HTTP server framework
- Prisma, Drizzle, or Knex for type-safe database access
- Bull/BullMQ for background job processing with Redis
- Pino or Winston for structured logging
- Jest or Vitest for testing with supertest for HTTP assertions

**Suggested File Structure:**
- `src/index.ts` (source)
- `src/routes/index.ts` (source)
- `package.json` (config)
- `tsconfig.json` (config)

## Dependency Chain

Startup/initialization order based on edge directions and interaction patterns.

**Must be available BEFORE this node starts:**
- Identity-Aware Proxy (this node calls/depends on it via IAP Assertion Verification (JWK Set) (rest))
- Cloud Logging: audit sink (this node calls/depends on it via Audit Log Sink (dependency))
- Secret Manager (this node calls/depends on it via Secret Manager Access (dependency))
- Cloud Tasks: lifecycle-steps (this node calls/depends on it via Step Task Enqueue (rest))
- Firestore: lifecycle state and audit (this node calls/depends on it via Lifecycle State Store (nosql))
- Lifecycle Step Executor (this node calls/depends on it via Directory Lookup (read-only) (rest))

**Depends on THIS node being available:**
- External HTTPS Load Balancer (calls this node via IAP-Protected HTTPS Ingress (rest))
- Operator Console UI (calls this node via Lifecycle Operator API (rest))

## Error Handling Contracts

**Errors this node MUST emit to consumers:**
- HTTP error responses to External HTTPS Load Balancer ("IAP-Protected HTTPS Ingress"): return proper 4xx for validation errors, 401/403 for auth failures, 5xx for internal errors with correlation IDs
- HTTP error responses to Operator Console UI ("Lifecycle Operator API"): return proper 4xx for validation errors, 401/403 for auth failures, 5xx for internal errors with correlation IDs

**Errors this node MUST handle from dependencies:**
- HTTP errors from Identity-Aware Proxy ("IAP Assertion Verification (JWK Set)"): handle 4xx (client error), 5xx (server error), timeouts, and connection refused
- HTTP errors from Cloud Tasks: lifecycle-steps ("Step Task Enqueue"): handle 4xx (client error), 5xx (server error), timeouts, and connection refused
- Database errors from Firestore: lifecycle state and audit ("Lifecycle State Store"): handle connection pool exhaustion, query timeout, constraint violations, and deadlocks
- HTTP errors from Lifecycle Step Executor ("Directory Lookup (read-only)"): handle 4xx (client error), 5xx (server error), timeouts, and connection refused

**Parent Container:** Cloud Run: lifecycle-api (docker-container)

## Existing Implementation

| File | Kind | Language | Status |
|------|------|----------|--------|
| `packages/shared/src/model.ts` | source | --- | draft |
| `services/api/src/middleware/iapAuth.test.ts` | test-plan | --- | draft |
| `.nodespec/tests/req-007.tests.md` - Test plan for requirement: IAP protection with server-side JWT assertion verification | test-plan | markdown | draft |
| `packages/shared/src/logging.ts` | source | --- | draft |
| `packages/shared/src/dispatcher.ts` | source | --- | draft |
| `.nodespec/tests/req-010.tests.md` - Test plan for requirement: Audit event model, operator-action auditing and log redaction | test-plan | markdown | draft |
| `services/api/src/schemas.ts` | source | --- | draft |
| `services/api/src/index.ts` | source | --- | draft |
| `services/api/src/authz.ts` | source | --- | draft |
| `packages/shared/src/transitions.test.ts` | test-plan | --- | draft |
| `packages/shared/src/store.ts` | source | --- | draft |
| `.nodespec/tests/req-002.tests.md` - Test plan for requirement: Optional two-party approval on any step | test-plan | markdown | draft |
| `services/api/src/tasks/dispatcher.ts` | source | --- | draft |
| `services/api/src/routes/requests.ts` | source | --- | draft |
| `services/api/src/schemas.test.ts` | test-plan | --- | draft |
| `packages/shared/src/dispatcher.test.ts` | test-plan | --- | draft |
| `services/api/package.json` | config | --- | draft |
| `services/api/src/middleware/iapAuth.ts` | source | --- | draft |
| `.nodespec/tests/req-001.tests.md` - Test plan for requirement: Lifecycle request creation and step-plan persistence | test-plan | markdown | draft |
| `services/api/tsconfig.json` | config | --- | draft |
| `packages/shared/tsconfig.json` | config | --- | draft |
| `packages/shared/src/index.ts` | source | --- | draft |
| `services/api/src/logging.ts` | source | --- | draft |
| `packages/shared/package.json` | config | --- | draft |
| `packages/shared/src/policy.ts` | source | --- | draft |
| `packages/shared/src/store.emulator.test.ts` | test-plan | --- | draft |
| `packages/shared/src/requestFactory.ts` | source | --- | draft |
| `packages/shared/src/logging.test.ts` | test-plan | --- | draft |
| `services/api/src/config.test.ts` | test-plan | --- | draft |
| `packages/shared/src/requestFactory.test.ts` | test-plan | --- | draft |
| `packages/shared/src/stepPlans.ts` | source | --- | draft |
| `packages/shared/src/transitions.ts` | source | --- | draft |
| `services/api/src/config.ts` | source | --- | draft |
| `packages/shared/src/stepPlans.test.ts` | test-plan | --- | draft |
