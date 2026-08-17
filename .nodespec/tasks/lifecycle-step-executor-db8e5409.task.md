# Task: Lifecycle Step Executor

> **Scope:** implement ONLY this node ("Lifecycle Step Executor"). Work belonging to other nodes appears here solely as interfaces and coordination points — do not implement or re-derive it.
> This document is DERIVED from the NodeSpec model + catalog (fingerprinted, regenerable via generate_task_docs). Node context/export is the model truth; propose model changes through the proposal flow — hand-edits to model facts here do not change the model.

## Component Purpose

**Role:** Background Worker
**Technology:** Node.js
**Description:** Background worker service that consumes jobs and events to perform domain work

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
- [ ] **T2 — Implement the integration with Cloud Tasks: lifecycle-steps (gcp-cloud-tasks) per Contract "Step Task Enqueue" (rest).**
  Build to the contract schema EXACTLY (see Interface Contracts).
  ↳ serves (unverified match): REQ-029 "A /lookup/* request bearing an OIDC token issued to the Cloud Tasks queue invoker identity is rejected with 401, and a /tasks/* request bearing the API service identity is likewise rejected with 401" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-029 "Lookup results are not treated as authoritative: the executing step still performs its own pre-mutation state read, verified by a test where live state changes between lookup and execution and the step observes the newer state" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-006 "The offboarding step plan executes in order: suspend, revoke sessions/tokens, remove group memberships, optional data transfer, delete" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-006 "Suspension takes effect before any destructive step runs, and a request halted after suspension leaves the account suspended but intact" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-006 "The delete step defaults to requiresApproval=true and cannot be configured below two-party approval" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-006 "Cancelling during the hold period appends a compensating 'unsuspend' step and dispatches it, rather than terminating the request directly" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-006 "The request reaches 'cancelled' only after the unsuspend step succeeds and the account is observably active again in Workspace" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-006 "A cancellation whose unsuspend step fails leaves the request in 'failed' with the account still suspended and the error recorded — never in 'cancelled'" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-006 "A delete step targeting a user already absent from the domain resolves as satisfied (idempotent) rather than failing" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-006 "When a Drive data-transfer successor is specified, the transfer is initiated and confirmed complete before the delete step is dispatched" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-006 "Every offboarding step, including the compensating unsuspend, records the affected user, actor, and outcome to the audit log" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T3 — Implement the integration with Firestore: lifecycle state and audit (gcp-firestore) per Contract "Lifecycle State Store" (nosql).**
  Build to the contract schema EXACTLY (see Interface Contracts).
- [ ] **T4 — Implement the integration with Secret Manager (gcp-secret-manager) per Contract "Secret Manager Access" (dependency).**
  Dependency contract — capture the reference/identifier wiring in this node's config artifacts; no payload schema expected.
- [ ] **T5 — Implement the integration with Cloud Logging: audit sink (gcp-cloud-logging) per Contract "Audit Log Sink" (dependency).**
  Dependency contract — capture the reference/identifier wiring in this node's config artifacts; no payload schema expected.
- [ ] **T6 — Implement the integration with Email Delivery Service per Contract "Welcome Letter Delivery" (rest).**
  Build to the contract schema EXACTLY (see Interface Contracts).
- [ ] **T7 — Implement the integration with Google Workspace (Admin SDK Directory) per Contract "Google Admin SDK Directory API" (rest).**
  Build to the contract schema EXACTLY (see Interface Contracts).
  ↳ serves (unverified match): REQ-029 "Every lookup route is read-only — a test enumerates the lookup router and asserts no Directory write operation is bound to any of them" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-029 "Lookup calls pass through the same shared Workspace client as mutations, inheriting its retry and error classification — verified by the absence of any separate Directory client in the lookup path" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T8 — Expose the interface Cloud Tasks: lifecycle-steps consumes, per Contract "Step Execution Dispatch" (rest).**
  Record the endpoint/identifiers Cloud Tasks: lifecycle-steps needs in this node's config artifacts — coordinate with Cloud Tasks: lifecycle-steps.
  Build to the contract schema EXACTLY (see Interface Contracts).
- [ ] **T9 — Expose the interface Lifecycle API Service consumes, per Contract "Directory Lookup (read-only)" (rest).**
  Record the endpoint/identifiers Lifecycle API Service needs in this node's config artifacts — coordinate with Lifecycle API Service.
  Build to the contract schema EXACTLY (see Interface Contracts).
  ↳ serves (unverified match): REQ-029 "A /lookup/* request with no OIDC token is rejected with 401 before any handler runs" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-029 "A lookup for a user or group that does not exist returns 404 rather than an empty success" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T10 — Implement: "A prefix search returns matching domain users with primaryEmail, full name, org unit path and suspended flag, paginated" (REQ-029).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-029 "A prefix search returns matching domain users with primaryEmail, full name, org unit path and suspended flag, paginated"
- [ ] **T11 — Implement: "Fetching one user returns their current attributes and group memberships, sufficient to pre-fill an update request" (REQ-029).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-029 "Fetching one user returns their current attributes and group memberships, sufficient to pre-fill an update request"
- [ ] **T12 — Implement: "The group picker lists domain groups and the org-unit picker lists org unit paths" (REQ-029).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-029 "The group picker lists domain groups and the org-unit picker lists org unit paths"
- [ ] **T13 — Implement: "A creation request for a primary email that already exists in the domain fails validation before any mutation is attempted and the request terminates in 'failed' with a typed AlreadyExists error" (REQ-003).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-003 "A creation request for a primary email that already exists in the domain fails validation before any mutation is attempted and the request terminates in 'failed' with a typed AlreadyExists error"
- [ ] **T14 — Implement: "The console link resolves to the request detail behind IAP, so an approver who is not signed in is authenticated at the perimeter before seeing anything" (REQ-032).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-032 "The console link resolves to the request detail behind IAP, so an approver who is not signed in is authenticated at the perimeter before seeing anything"
- [ ] **T15 — Verify every acceptance criterion above and tick its box.**
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

### REQ-029: Read-only directory lookup for operator pickers
Category: functional | Status: in-progress
Owned by the Lifecycle Step Executor. Phases 3 and 4 act on an existing user and Phase 1 assigns groups and an org unit, so an operator must be able to find a user, a group and an org unit before submitting anything. Without this, target emails and group names are free text validated only when the worker executes, which turns a typo into a failed request discovered minutes later.

The lookup surface lives on the worker rather than the API service because the worker holds the only Workspace admin role; routing lookups through it preserves REQ-014's identity separation exactly as written and keeps the shared Workspace client the single choke point for retry and error classification (REQ-013). The API service calls it with an OIDC token and never touches the Directory API itself.

Opening the worker to a second caller is the real cost of this design, and it is bounded by per-route isolation: /lookup/* admits only the API service identity, /tasks/* only the Cloud Tasks queue invoker identity, and each rejects the other. Every lookup route is strictly read-only. Lookup results populate pickers and pre-fill forms only — the authoritative state read still happens inside the executing step, because any lookup result is already stale by the time an operator submits.

**Acceptance criteria — your task boxes:**
- [ ] A prefix search returns matching domain users with primaryEmail, full name, org unit path and suspended flag, paginated
  → covered by Task T10
- [ ] Fetching one user returns their current attributes and group memberships, sufficient to pre-fill an update request
  → covered by Task T11
- [ ] The group picker lists domain groups and the org-unit picker lists org unit paths
  → covered by Task T12
- [ ] Every lookup route is read-only — a test enumerates the lookup router and asserts no Directory write operation is bound to any of them
  → covered by Task T7
- [ ] A /lookup/* request bearing an OIDC token issued to the Cloud Tasks queue invoker identity is rejected with 401, and a /tasks/* request bearing the API service identity is likewise rejected with 401
  → covered by Task T2
- [ ] A /lookup/* request with no OIDC token is rejected with 401 before any handler runs
  → covered by Task T9
- [ ] Lookup calls pass through the same shared Workspace client as mutations, inheriting its retry and error classification — verified by the absence of any separate Directory client in the lookup path
  → covered by Task T7
- [ ] A lookup for a user or group that does not exist returns 404 rather than an empty success
  → covered by Task T9
- [ ] Lookup results are not treated as authoritative: the executing step still performs its own pre-mutation state read, verified by a test where live state changes between lookup and execution and the step observes the newer state
  → covered by Task T2

### REQ-030: Welcome letter resend and credential regeneration
Category: functional | Status: in-progress
Owned by the Lifecycle Step Executor. The welcome letter goes to a personal address that can be mistyped, spam-filtered or simply never read, and with the Workspace SMTP relay a bounce may not even be observable (REQ-028). REQ-004's idempotency is correct for automatic retries but deliberately prevents a second send, so without this requirement a lost letter has no remedy: a new create request fails because the account already exists (REQ-003), and if the one-time password was already retrieved or its TTL expired (REQ-017, REQ-019) the credential is gone too. That is a dead end reachable on an ordinary day, and closing it is the point of this requirement.

Resend is expressed as a notify-phase request against an existing user — the phase already exists in the request model, so no new lifecycle shape is introduced. Where the credential is no longer available, the request additionally regenerates it: the worker sets a fresh one-time password via users.update with changePasswordAtNextLogin=true, writes new ciphertext with a new TTL, and invalidates the prior record. Regeneration resets a real person's password, so it is auditable as a credential rotation and is a step the approval policy can gate like any other.

**Acceptance criteria — your task boxes:**
- [x] A notify-phase request against an existing user is admitted and sends a fresh letter, without being blocked by the create-phase primary-email collision check
  → possible match: Contract "Welcome Letter Delivery" (rest) to Email Delivery Service (unverified — requirement not mapped to that node)
- [x] Each notify request has its own notification step and its own delivery id, so resending is not suppressed by the previous request's idempotency record
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] A resend requested with regenerate=false reuses the existing credential record when it is still valid, and is refused with a typed CredentialUnavailable error when it has been retrieved or has expired
  → THIS NODE: internal logic
- [x] A resend requested with regenerate=true sets a fresh one-time password via users.update with changePasswordAtNextLogin=true, writes new ciphertext with a new TTL, and invalidates the prior credential record
  → possible match: Contract "Audit Log Sink" (dependency) to Cloud Logging: audit sink (unverified — requirement not mapped to that node)
- [x] After regeneration the superseded ciphertext is unretrievable — an attempt against the old record returns 410
  → THIS NODE: internal logic
- [x] Regeneration writes an audit event typed as a credential rotation, naming the operator and the target user, and never recording either password value
  → possible match: Contract "Audit Log Sink" (dependency) to Cloud Logging: audit sink (unverified — requirement not mapped to that node)
- [x] The regeneration step is subject to the approval policy like any other step, so a tenant can require two-party approval before an operator resets a person's password
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] Resending to a corrected notification address updates the address on the new request without mutating the original request's record
  → THIS NODE: internal logic
- [x] A resend for a user whose account has been deleted fails validation before any Workspace call
  → THIS NODE: internal logic

### REQ-005: Phase 3 — Role and attribute updates over time
Category: functional | Status: in-progress
An existing user's attributes, org unit, and group memberships can be changed after onboarding. The update request is expressed as a desired-state diff: the operator submits the fields to change and the groups to add/remove, and the app computes the concrete change set against the user's live Workspace state at execution time. The computed diff is shown for approval before execution when the step requires approval, so the approver sees exactly what will change rather than a raw payload. Updates use Admin SDK users.update / users.patch and members.insert / members.delete, each group change as its own idempotent step so partial failure is recoverable. A change that would be a no-op against live state is recorded as 'skipped' rather than executed.

RECORDED INTERPRETATION — what "roles" means. The customer's phase 3 asks to update "a user's roles/attributes over time". In Google Workspace "role" can mean two very different things: an access grouping (group membership), or a Workspace ADMIN role assigned through roleAssignments. This requirement reads it as the former, for three reasons.

First, coherence: phase 1 grants groups at creation and phase 3 is the only phase that changes anything afterwards, so if "roles" excluded groups, group membership would be write-once — which no user-lifecycle tool can be, and which would leave the customer's own four phases unable to close.

Second, the scenario the phrase describes: "over time" is the mover case, someone changing team or job. In Workspace that is expressed as group membership plus org unit and job attributes. Administrative privilege is not what changes when a person moves teams.

Third, and decisively, admin-role management is a privilege-escalation surface. A service account able to assign admin roles can grant itself — or anyone else — Super Admin. The customer explicitly refused Domain-Wide Delegation to keep this integration's blast radius small; handing the same integration the ability to mint administrators would undo that, and as a side effect of routine attribute updates rather than a deliberate decision.

So "roles" here means group memberships, together with the attributes that describe a role: job title, department, manager, and org unit path. Assigning or revoking WORKSPACE ADMIN roles is out of scope, and the custom admin role deliberately lacks the privilege (REQ-027). If Company does want admin-role management, it is an additive change — one additional scope, one additional privilege on the custom admin role, and an explicit acceptance of the escalation surface — and it should be a conversation, not an assumption inherited from an ambiguous word.

**Acceptance criteria — your task boxes:**
- [x] Submitting an update request computes a diff against the user's live Workspace state and persists it on the request before execution
  → possible match: Contract "Lifecycle State Store" (nosql) to Firestore: lifecycle state and audit (unverified — requirement not mapped to that node)
- [x] The rendered approval payload shows the before/after value of every changed attribute and every group being added or removed
  → THIS NODE: internal logic
- [x] Applying the update changes exactly the attributes and memberships in the diff and leaves all other user state untouched
  → possible match: Contract "Lifecycle State Store" (nosql) to Firestore: lifecycle state and audit (unverified — requirement not mapped to that node)
- [x] Changing a user's role is expressed as group membership changes plus role-describing attributes — job title, department, manager and org unit path — and all of these are updatable through this phase
  → possible match: Contract "Secret Manager Access" (dependency) to Secret Manager (unverified — requirement not mapped to that node)
- [x] A requested change that already matches live state is recorded as step status 'skipped' and issues no Workspace call
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] Removing a group membership the user does not have is treated as already-satisfied ('skipped'), not as an error
  → THIS NODE: internal logic
- [x] If one group change fails, the other group changes that succeeded are retained and the failing change is reported on its own step
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] An update request targeting a non-existent or suspended-and-deleted user fails validation before any mutation
  → THIS NODE: internal logic
- [x] Workspace ADMIN role assignment is unreachable through any phase — a repository check finds no roleAssignments API call and no admin.directory.rolemanagement scope anywhere in the codebase or IaC
  → possible match: Contract "Google Admin SDK Directory API" (rest) to Google Workspace (Admin SDK Directory) (unverified — requirement not mapped to that node)

### REQ-003: Phase 1 — User creation with attributes and group assignment
Category: functional | Status: in-progress
The onboarding phase creates a Google Workspace user and brings it to a fully-attributed, fully-grouped state. Its step plan is: validate request payload against the schema and against Workspace (primary email not already taken); create the user via Admin SDK Directory users.insert with a generated one-time password and changePasswordAtNextLogin=true; apply attributes (name, org unit path, employee title/department/manager via organizations and relations, custom schema fields); assign each requested group via members.insert; verify by reading the user and its group memberships back and comparing to the intended state. Group assignment is per-group so one failing group does not lose the others already assigned.

Generation and protection of the one-time password belong to REQ-019: it is persisted as ciphertext under the credential data-encryption key with a Firestore TTL, so that the requesting operator can retrieve it exactly once (REQ-017). This phase's obligation is narrower — the plaintext must never appear in a Firestore document, an API response, or a log entry, and must be discarded from memory once REQ-019's ciphertext is committed.

**Acceptance criteria — your task boxes:**
- [x] Submitting a valid creation request produces a Workspace user whose primary email, given/family name, and org unit path match the request payload
  → THIS NODE: internal logic
- [x] Every group listed in the request appears in the created user's membership list after the phase completes
  → THIS NODE: internal logic
- [ ] A creation request for a primary email that already exists in the domain fails validation before any mutation is attempted and the request terminates in 'failed' with a typed AlreadyExists error
  → covered by Task T13
- [x] The user is created with changePasswordAtNextLogin=true and a password meeting the configured generation policy
  → possible match: Contract "Audit Log Sink" (dependency) to Cloud Logging: audit sink (unverified — requirement not mapped to that node)
- [x] If one group assignment fails, the successfully assigned groups are retained, the failing group is reported in the step error, and the request does not report success
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] The verification step reads the user and memberships back from Workspace and fails the request if the observed state does not match the intended state
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] The PLAINTEXT initial password never appears in any Firestore document, API response body, or log entry — only the ciphertext written by REQ-019 is persisted, and a test provisions a user then greps the emitted records for the issued value
  → possible match: Contract "Lifecycle State Store" (nosql) to Firestore: lifecycle state and audit (unverified — requirement not mapped to that node)

### REQ-032: Approver notification when a step halts for approval
Category: functional | Status: in-progress
Owned by the Lifecycle Step Executor. Two-party approval is otherwise pull-only: a step halts in 'awaiting_approval' and waits for somebody to happen to look at the approvals inbox. Combined with REQ-002's optional expiry that auto-rejects on silence, this makes an unnoticed request fail for the wrong reason — nobody declined it, nobody knew.

When a step enters 'awaiting_approval' the halting service enqueues a notification task (the API for a request's first step, the worker for subsequent ones — see REQ-001 and REQ-016), and the worker executes it. The worker sends because it holds the only SMTP credential; routing through the queue means the API service never needs one, and the notification inherits the queue's retry budget and the existing NotificationSender rather than growing a second delivery path.

The message is deliberately thin: request id, phase, target user, who requested it, the approval deadline when one is configured, and a link to the request in the console. It carries no computed diff and no attribute values, because an approver clicking through is authenticated at the perimeter and the console shows them everything — mail is the worst place to put change detail. The link points at the IAP-protected console and that is fine here, unlike the new-hire case: approvers ARE IAP principals, so no perimeter exception is needed.

Recipients are the identities eligible to approve under the request's snapshotted policy, resolved from role bindings, always excluding the requester since REQ-002 forbids self-approval. Resolving recipients requires the worker to read roleBindings, which is a data-access-layer widening rather than a security boundary change — Firestore IAM is database-scoped, so both services already share database-level access (REQ-014).

A notification failure must not fail the request. The step is still legitimately awaiting approval; only the telling failed. The failure is recorded and retried, and the request's own state is untouched.

**Acceptance criteria — your task boxes:**
- [x] A step entering 'awaiting_approval' results in exactly one notification per eligible approver, verified for both a first step halted by the API and a later step halted by the worker
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] The requester never receives an approval notification for their own request, matching REQ-002's self-approval prohibition
  → THIS NODE: internal logic
- [x] Recipients are resolved from role bindings against the request's SNAPSHOTTED policy, so a policy change after creation does not alter who is asked to approve an in-flight request
  → THIS NODE: internal logic
- [x] Retrying or redelivering the notification task does not send a second message — the send is keyed on requestId plus stepId and the recorded outcome short-circuits a repeat
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] The message contains request id, phase, target user, requester, the approval deadline when one is configured, and a console link — and contains no computed diff, no attribute values, no credential and no token, verified by rendering with a fully populated context and asserting none of it appears
  → THIS NODE: internal logic
- [ ] The console link resolves to the request detail behind IAP, so an approver who is not signed in is authenticated at the perimeter before seeing anything
  → covered by Task T14
- [x] When a step requires approval but no eligible approver exists, the notification step fails loudly with a typed NoEligibleApprover error and the condition is surfaced to admins — it never resolves as a successful send to nobody
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] A notification delivery failure is recorded on the step and retried, and leaves the request in 'awaiting_approval' rather than moving it to 'failed' — the approval is still pending, only the telling failed
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] Approval notifications are sent through the same NotificationSender and the same relay sender address as the welcome letter, with no second delivery path introduced
  → possible match: Contract "Welcome Letter Delivery" (rest) to Email Delivery Service (unverified — requirement not mapped to that node)
- [x] Every notification send, failure and suppression writes an audit event naming the step and the recipients
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)

### REQ-004: Phase 2 — Welcome letter delivery
Category: functional | Status: in-progress
Owned by the Lifecycle Step Executor. After a user is created, the worker notifies them at an out-of-band address (personal or manager-relayed) — the new mailbox is unreachable until the account's first sign-in, so delivery must not depend on it. The letter is rendered from a versioned template and carries instructions for setting the initial password through Google's own first-sign-in flow: the account is created with changePasswordAtNextLogin=true, so Google itself forces the reset. The application hosts no password-setting page and no claim link, which is what keeps every route in the system behind IAP (REQ-007) — a person being onboarded is not an IAP principal and never interacts with this application at all. The letter carries no credential of any kind.

Delivery is idempotent: retrying the notification step never sends a second letter for the same request. The step records whatever the chosen provider reports — submission acceptance always, and asynchronous bounce or delivery events only if the provider emits them, which is one of the consequences REQ-028's provider decision turns on. Where bounces are not observable, that limitation is recorded rather than papered over, because the letter is the only channel reaching the new hire.

Generating and protecting the one-time password is REQ-019; the operator's retrieval of it is REQ-017.

**Acceptance criteria — your task boxes:**
- [x] The notification step renders the welcome letter from the configured template with the user's name, primary email, and password-setup instructions substituted
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] The letter is delivered to the alternate/notification address supplied on the request, never to the newly created primary mailbox
  → possible match: Contract "Welcome Letter Delivery" (rest) to Email Delivery Service (unverified — requirement not mapped to that node)
- [x] Retrying the notification step after a successful send does not send a second letter — the step observes its recorded delivery id and returns success
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] The letter body contains no password, token, or link that would grant access, verified by rendering the template with a populated credential context and asserting none of it appears in the output
  → possible match: Contract "Secret Manager Access" (dependency) to Secret Manager (unverified — requirement not mapped to that node)
- [x] A submission rejected by the provider records the provider error on the step and leaves the request resumable rather than silently succeeding
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] The provider's submission response and delivery id are persisted on the step, and where the provider emits asynchronous bounce events those outcomes are recorded against the same step
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] The delivery provider is reached through a single NotificationSender interface, so the provider choice is a configuration decision rather than a code change
  → possible match: Contract "Welcome Letter Delivery" (rest) to Email Delivery Service (unverified — requirement not mapped to that node)

### REQ-008: Workspace admin access without Domain-Wide Delegation
Category: technical | Status: in-progress
The app authenticates to the Google Workspace Admin SDK as the service account itself, holding a directly-assigned Workspace admin role — it never impersonates a human administrator and Domain-Wide Delegation is not configured anywhere in the setup. At runtime the app mints its own access token from the Cloud Run metadata server for the admin.directory scopes and calls the Directory API directly, with no 'subject' impersonation parameter and no downloaded service-account key. This requirement owns the APPLICATION-SIDE proof that no impersonation and no delegation exist in the code path; the tenant-side configuration that grants the role, and the setup guide documenting it, are REQ-027.

**Acceptance criteria — your task boxes:**
- [x] The Directory API client is constructed from Application Default Credentials with no 'subject'/impersonation parameter anywhere in the code path
  → possible match: Contract "Google Admin SDK Directory API" (rest) to Google Workspace (Admin SDK Directory) (unverified — requirement not mapped to that node)
- [x] No service-account JSON key file is referenced, mounted, or read by the application at any point
  → THIS NODE: internal logic
- [x] A repository-wide check finds no Domain-Wide Delegation configuration, no OAuth client-id delegation instructions, and no impersonation scopes in code or IaC
  → THIS NODE: internal logic
- [x] The Directory client requests only the least-privilege scopes the phases and the lookup surface actually use, enumerated in one place, and every requested scope has a named consumer — a scope with no consumer fails the check
  → possible match: Contract "Google Admin SDK Directory API" (rest) to Google Workspace (Admin SDK Directory) (unverified — requirement not mapped to that node)
- [x] A Workspace call that fails with 403 surfaces a typed AdminRoleNotGranted error naming the missing privilege, rather than a generic API failure
  → possible match: Contract "Google Admin SDK Directory API" (rest) to Google Workspace (Admin SDK Directory) (unverified — requirement not mapped to that node)
- [x] The Directory client is the single construction site for Workspace credentials — no phase handler and no lookup handler builds its own client, verified by a repository check
  → possible match: Contract "Google Admin SDK Directory API" (rest) to Google Workspace (Admin SDK Directory) (unverified — requirement not mapped to that node)
- [x] The Directory API is reachable only from the worker: a repository check finds no Directory client construction or Workspace scope reference in the API service
  → possible match: Contract "Google Admin SDK Directory API" (rest) to Google Workspace (Admin SDK Directory) (unverified — requirement not mapped to that node)

### REQ-006: Phase 4 — Account offboarding and deletion
Category: functional | Status: in-progress
Offboarding is a deliberately staged, reversible-until-the-end phase: suspend the account (immediate access cut), revoke active sessions and application-specific passwords / OAuth tokens, remove group memberships, optionally transfer Drive ownership to a named successor, and only then delete the user via Admin SDK users.delete. Deletion is the irreversible step and therefore defaults to requiring two-party approval regardless of the surrounding policy. An optional hold period between suspension and deletion is supported, during which the request can be cancelled.

Cancellation is not merely a status change. The account is already suspended in Workspace by that point, so restoring it requires a Workspace mutation, and Workspace mutations only ever happen in the executor. Cancelling therefore appends a compensating 'unsuspend' step to the request and dispatches it; the request reaches 'cancelled' only once that step succeeds. A cancellation whose unsuspend step fails leaves the request in 'failed' with the account still suspended and the error recorded — visibly wrong rather than silently wrong, because an operator believing an account was restored when it was not is the dangerous outcome.

The deletion step is idempotent — a user already absent from the domain resolves the step as satisfied rather than failing.

**Acceptance criteria — your task boxes:**
- [ ] The offboarding step plan executes in order: suspend, revoke sessions/tokens, remove group memberships, optional data transfer, delete
  → covered by Task T2
- [ ] Suspension takes effect before any destructive step runs, and a request halted after suspension leaves the account suspended but intact
  → covered by Task T2
- [ ] The delete step defaults to requiresApproval=true and cannot be configured below two-party approval
  → covered by Task T2
- [ ] Cancelling during the hold period appends a compensating 'unsuspend' step and dispatches it, rather than terminating the request directly
  → covered by Task T2
- [ ] The request reaches 'cancelled' only after the unsuspend step succeeds and the account is observably active again in Workspace
  → covered by Task T2
- [ ] A cancellation whose unsuspend step fails leaves the request in 'failed' with the account still suspended and the error recorded — never in 'cancelled'
  → covered by Task T2
- [ ] A delete step targeting a user already absent from the domain resolves as satisfied (idempotent) rather than failing
  → covered by Task T2
- [ ] When a Drive data-transfer successor is specified, the transfer is initiated and confirmed complete before the delete step is dispatched
  → covered by Task T2
- [ ] Every offboarding step, including the compensating unsuspend, records the affected user, actor, and outcome to the audit log
  → covered by Task T2

### REQ-013: Idempotent, retry-safe Workspace mutations
Category: non-functional | Status: in-progress
Because Cloud Tasks delivers at least once and Workspace calls can time out after the change has landed, every Workspace mutation must be safe to replay. Each step carries a stable idempotency key derived from (requestId, stepId, attempt-invariant payload hash). Before mutating, the executor reads the live Workspace state and short-circuits when the intended state already holds. Directory API errors are classified into retryable (429, 5xx, quota exhaustion — retried with exponential backoff and jitter, honoring Retry-After) and terminal (400, 403, 404 for a missing prerequisite — failing the step immediately without burning the retry budget). The Workspace client is the single choke point for this policy; no phase implements its own retry logic.

**Acceptance criteria — your task boxes:**
- [x] Replaying any step of any phase against a Workspace state where the intended change already holds produces no additional mutation and resolves the step as satisfied
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] Each step's idempotency key is stable across attempts and distinct across requests and steps
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] A 429 or 5xx from the Directory API is retried with exponential backoff and jitter, honoring Retry-After when present
  → possible match: Contract "Google Admin SDK Directory API" (rest) to Google Workspace (Admin SDK Directory) (unverified — requirement not mapped to that node)
- [x] A 400 or 403 fails the step immediately and does not consume further retry attempts
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] A mutation that times out client-side but succeeded server-side is detected by the pre-mutation state read on the next attempt and not applied twice
  → possible match: Contract "Lifecycle State Store" (nosql) to Firestore: lifecycle state and audit (unverified — requirement not mapped to that node)
- [x] All retry and classification behavior lives in the shared Workspace client, verified by the absence of retry logic in any phase handler
  → possible match: Contract "Audit Log Sink" (dependency) to Cloud Logging: audit sink (unverified — requirement not mapped to that node)
- [x] Concurrent duplicate task deliveries for the same step result in exactly one Workspace mutation
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)

### REQ-019: Credential generation and encryption at rest
Category: non-functional | Status: in-progress
Owned by the Lifecycle Step Executor. The worker generates the initial one-time password during Phase 1, holds it in memory for the shortest possible window, and persists it only as ciphertext encrypted under the credential data-encryption key from Secret Manager, alongside the key version used. Encryption is the correct primitive here rather than hashing: the operator must recover the actual value at retrieval (REQ-017), and a hash cannot be reversed — hashing is right for verifying a presented value, wrong for recovering a stored one. The credential record carries a Firestore TTL so an unretrieved password expires on its own. The plaintext never appears in a Firestore document, an API response from the worker, or any log entry.

**Acceptance criteria — your task boxes:**
- [x] The generated password meets the configured generation policy and the user is created with changePasswordAtNextLogin=true
  → possible match: Contract "Audit Log Sink" (dependency) to Cloud Logging: audit sink (unverified — requirement not mapped to that node)
- [x] The one-time password is persisted only as ciphertext under the Secret Manager credential encryption key, never as plaintext and never as a hash, and a test asserts the stored field decrypts to the issued value
  → possible match: Contract "Lifecycle State Store" (nosql) to Firestore: lifecycle state and audit (unverified — requirement not mapped to that node)
- [x] The persisted record carries the key version used, so a rotated key can still decrypt in-flight ciphertext or the drain procedure applies
  → THIS NODE: internal logic
- [x] The credential record carries a Firestore TTL and is removed on expiry without operator action
  → possible match: Contract "Lifecycle State Store" (nosql) to Firestore: lifecycle state and audit (unverified — requirement not mapped to that node)
- [x] The generated plaintext password never appears in any Firestore document, any worker API response body, or any log entry, verified by a test that provisions a user and greps the emitted records
  → possible match: Contract "Lifecycle State Store" (nosql) to Firestore: lifecycle state and audit (unverified — requirement not mapped to that node)
- [x] The plaintext is discarded from worker memory once the ciphertext is committed
  → THIS NODE: internal logic

### REQ-016: Durable step execution, resumability and transition integrity
Category: functional | Status: in-progress
Owned by the Lifecycle Step Executor. Steps admitted by REQ-001 are executed one per invocation, durably and exactly once in effect. State lives in Firestore, never in process memory, so a Cloud Run instance killed mid-step resumes from the last committed status on the next task delivery. Cloud Tasks delivers at least once, so every transition is performed inside a Firestore transaction that reads the current step status and refuses illegal transitions — a duplicate delivery observes a non-'ready' status and returns without side effects. Every transition writes its audit event in that same transaction, so a state change can never be recorded without its audit event or vice versa. On completion the executor evaluates the next step and either dispatches it or halts it in 'awaiting_approval' per the policy snapshotted onto the request.

**Acceptance criteria — your task boxes:**
- [x] A request whose executing instance is terminated mid-step resumes from the last committed step status on the next task delivery, with no step executed twice and no step skipped
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] Delivering the same step task twice results in exactly one execution: the second delivery observes a non-'ready' status inside the transaction and returns without side effects
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] An illegal state transition (e.g. 'succeeded' -> 'running') is rejected by the transition guard and raises a typed InvalidTransition error rather than mutating state
  → possible match: Contract "Lifecycle State Store" (nosql) to Firestore: lifecycle state and audit (unverified — requirement not mapped to that node)
- [x] Every step status transition writes its audit event in the same Firestore transaction as the transition, verified by a test that fails the transaction and observes neither the transition nor the audit event
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] A step that exhausts its retry budget lands in status 'failed' with the terminal error recorded, the parent request moves to 'failed', and no subsequent step is dispatched
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] On successful completion the executor dispatches the next step, or halts it in 'awaiting_approval' when the snapshotted policy requires approval
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] When the executor halts a step in 'awaiting_approval', the approver-notification record is written in the same Firestore transaction as the halt, so a halt can never be committed without its notification record; the notification task is then enqueued from that record after the transaction commits, and an enqueue that fails leaves the record outstanding for a sweeper rather than losing the halt (REQ-032 performs the send)
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)
- [x] The /tasks/execute-step route accepts a step task only when it carries a valid OIDC token issued to the Cloud Tasks queue invoker service account, and rejects unauthenticated requests, tokens issued to any other service account, and specifically tokens issued to the lifecycle-api identity that is admitted on the lookup routes
  → possible match: Contract "Step Task Enqueue" (rest) to Cloud Tasks: lifecycle-steps (unverified — requirement not mapped to that node)

## Interface Contracts

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

### RECEIVES FROM: Cloud Tasks: lifecycle-steps (queue)
- **Contract:** Step Execution Dispatch
- **Protocol:** rest
- **Transport:** http
- **Spec Format:** openapi
- **Their Technology:** gcp-cloud-tasks

**Schema:**
```
{
  "info": {
    "title": "Step Executor Endpoint",
    "version": "1.2.0",
    "description": "Cloud Tasks is the only permitted caller of /tasks/*. The worker also serves /lookup/* under the separate Directory Lookup contract, admitted only for the API service identity - the two route classes never accept each other's caller."
  },
  "paths": {
    "/tasks/execute-step": {
      "post": {
        "security": [
          {
            "googleOidc": [
              "queue invoker service account ONLY"
            ]
          }
        ],
        "responses": {
          "200": {
            "description": "Step reached a terminal-for-this-attempt state (succeeded, skipped, or terminally failed). Cloud Tasks will not retry."
          },
          "401": {
            "description": "Missing or invalid OIDC token, or a token issued to any identity other than the queue invoker - including the API service identity, which may reach /lookup/* but never this route"
          },
          "409": {
            "description": "Step is not in status ready - duplicate delivery, acknowledged without side effects"
          },
          "429": {
            "description": "Retryable downstream condition (Directory API quota). Cloud Tasks retries with backoff."
          },
          "500": {
            "description": "Retryable failure. Cloud Tasks retries with backoff until the attempt budget is exhausted."
          }
        },
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "requestId",
                  "stepId",
                  "idempotencyKey",
                  "attempt"
                ],
                "properties": {
                  "stepId": {
                    "type": "string"
                  },
                  "attempt": {
                    "type": "integer"
                  },
                  "requestId": {
                    "type": "string"
                  },
                  "idempotencyKey": {
                    "type": "string"
                  }
                }
              }
            }
          },
          "required": true
        }
      }
    },
    "/tasks/notify-approvers": {
      "post": {
        "summary": "Notify the identities eligible to approve a step that has halted in awaiting_approval",
        "security": [
          {
            "googleOidc": [
              "queue invoker service account ONLY"
            ]
          }
        ],
        "behaviour": [
          "resolve eligible approvers from roleBindings against the request's SNAPSHOTTED policy, excluding the requester",
          "short-circuit if a send is already recorded for this requestId+stepId",
          "render the thin approval notice - no diff, no attribute values, no credential - and send through the shared NotificationSender",
          "record the outcome and write an audit event naming the step and recipients"
        ],
        "responses": {
          "200": {
            "description": "Notification sent, or already recorded as sent (idempotent no-op)"
          },
          "401": {
            "description": "Missing or invalid OIDC token, or a token issued to any identity other than the queue invoker"
          },
          "409": {
            "description": "Step is no longer awaiting_approval - already decided, acknowledged without sending"
          },
          "422": {
            "description": "No eligible approver exists for this step - typed NoEligibleApprover, surfaced to admins rather than resolving as a successful send to nobody"
          },
          "500": {
            "description": "Delivery failed. Cloud Tasks retries. The request REMAINS in awaiting_approval - only the telling failed, the approval is still pending."
          }
        },
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "requestId",
                  "stepId"
                ],
                "properties": {
                  "stepId": {
                    "type": "string"
                  },
                  "requestId": {
                    "type": "string"
                  }
                }
              }
            }
          },
          "required": true
        }
      }
    }
  },
  "openapi": "3.1.0",
  "routeIsolation": "The worker has two callers. /tasks/* admits only the Cloud Tasks queue invoker service account; /lookup/* admits only the lifecycle-api runtime service account. Each route class rejects the other's identity with 401.",
  "executionContract": [
    "read the step inside a transaction; proceed only if status is ready, else return 409",
    "transition ready -> running and write the audit event in that same transaction",
    "read live Workspace state and short-circuit to skipped when the intended state already holds",
    "perform the mutation through the shared Workspace client (which owns all retry and error classification)",
    "transition to succeeded/skipped/failed and write the audit event transactionally",
    "on success, evaluate the next step: dispatch it, or halt it in awaiting_approval and enqueue its approver notification in the same transaction"
  ]
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

### SENDS TO: Email Delivery Service (external-service)
- **Contract:** Welcome Letter Delivery
- **Protocol:** rest
- **Transport:** http

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

### SENDS TO: Google Workspace (Admin SDK Directory) (external-service)
- **Contract:** Google Admin SDK Directory API
- **Protocol:** rest
- **Transport:** http
- **Spec Format:** openapi

**Schema:**
```
{
  "scopes": [
    "https://www.googleapis.com/auth/admin.directory.user",
    "https://www.googleapis.com/auth/admin.directory.group.member",
    "https://www.googleapis.com/auth/admin.directory.group.readonly",
    "https://www.googleapis.com/auth/admin.directory.orgunit.readonly"
  ],
  "baseUrl": "https://admin.googleapis.com/admin/directory/v1",
  "operations": {
    "users.get": {
      "usedBy": [
        "validation",
        "verification",
        "pre-mutation state read",
        "lookup user detail"
      ]
    },
    "users.list": {
      "usedBy": [
        "primary-email collision check",
        "setup verification",
        "lookup user search"
      ]
    },
    "groups.list": {
      "notes": "read-only",
      "usedBy": [
        "lookup group picker"
      ]
    },
    "users.patch": {
      "usedBy": [
        "phase 3 partial attribute changes"
      ]
    },
    "members.list": {
      "usedBy": [
        "membership verification",
        "diff computation",
        "lookup user detail"
      ]
    },
    "users.delete": {
      "notes": "idempotent - a 404 resolves the step as satisfied",
      "usedBy": [
        "phase 4 delete"
      ]
    },
    "users.insert": {
      "notes": "password generated in-process, changePasswordAtNextLogin=true",
      "usedBy": [
        "phase 1 create"
      ]
    },
    "users.update": {
      "usedBy": [
        "phase 3 attribute and org-unit changes",
        "phase 4 suspend and unsuspend",
        "credential regeneration"
      ]
    },
    "orgunits.list": {
      "notes": "read-only",
      "usedBy": [
        "lookup org-unit picker"
      ]
    },
    "tokens.delete": {
      "usedBy": [
        "phase 4 session and OAuth token revocation"
      ]
    },
    "members.delete": {
      "notes": "a 404 resolves as already-satisfied",
      "usedBy": [
        "phase 3 and phase 4 group removal"
      ]
    },
    "members.insert": {
      "notes": "one step per group so partial failure is recoverable",
      "usedBy": [
        "phase 1 and phase 3 group assignment"
      ]
    }
  },
  "description": "The only integration point with the identity provider. Authenticated AS THE SERVICE ACCOUNT ITSELF via a directly-assigned Workspace admin role - no Domain-Wide Delegation, no subject impersonation, no downloaded key. Reached only from the worker; the API service never calls this API and instead uses the worker's Directory Lookup contract.",
  "retryPolicy": "exponential backoff with jitter, honoring Retry-After. Implemented ONCE in the shared Workspace client - no phase handler and no lookup handler implements its own.",
  "authentication": {
    "adminGrant": "custom Workspace admin role assigned to the worker service account email under Admin console > Account > Admin roles > Assign service accounts",
    "credentials": "Application Default Credentials from the Cloud Run metadata server",
    "impersonation": "NONE - no 'subject' parameter is ever set",
    "domainWideDelegation": "NOT USED"
  },
  "scopeJustification": {
    "admin.directory.user": "phases 1/3/4 create, read, update and delete users; lookup searches and reads them",
    "admin.directory.group.member": "phases 1/3/4 add and remove memberships; lookup reads them",
    "admin.directory.group.readonly": "the group picker enumerates domain groups - ADDED with the lookup surface",
    "admin.directory.orgunit.readonly": "the org-unit picker enumerates OU paths, and Phase 1 validates orgUnitPath - this scope was previously granted with no consumer, which contradicted the least-privilege criterion; the lookup surface is now its consumer"
  },
  "errorClassification": {
    "terminal": [
      400,
      404
    ],
    "retryable": [
      429,
      500,
      502,
      503,
      504
    ],
    "permission": [
      403
    ],
    "onPermission": "raise a typed AdminRoleNotGranted error naming the missing privilege"
  }
}
```

### RECEIVES FROM: Lifecycle API Service (backend-service)
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
- Cloud Tasks: lifecycle-steps (this node calls/depends on it via Step Task Enqueue (rest))
- Firestore: lifecycle state and audit (this node calls/depends on it via Lifecycle State Store (nosql))
- Secret Manager (this node calls/depends on it via Secret Manager Access (dependency))
- Cloud Logging: audit sink (this node calls/depends on it via Audit Log Sink (dependency))
- Email Delivery Service (this node calls/depends on it via Welcome Letter Delivery (rest))
- Google Workspace (Admin SDK Directory) (this node calls/depends on it via Google Admin SDK Directory API (rest))

**Depends on THIS node being available:**
- Cloud Tasks: lifecycle-steps (calls this node via Step Execution Dispatch (rest))
- Lifecycle API Service (calls this node via Directory Lookup (read-only) (rest))

## Error Handling Contracts

**Errors this node MUST emit to consumers:**
- HTTP error responses to Cloud Tasks: lifecycle-steps ("Step Execution Dispatch"): return proper 4xx for validation errors, 401/403 for auth failures, 5xx for internal errors with correlation IDs
- HTTP error responses to Lifecycle API Service ("Directory Lookup (read-only)"): return proper 4xx for validation errors, 401/403 for auth failures, 5xx for internal errors with correlation IDs

**Errors this node MUST handle from dependencies:**
- HTTP errors from Cloud Tasks: lifecycle-steps ("Step Task Enqueue"): handle 4xx (client error), 5xx (server error), timeouts, and connection refused
- Database errors from Firestore: lifecycle state and audit ("Lifecycle State Store"): handle connection pool exhaustion, query timeout, constraint violations, and deadlocks
- HTTP errors from Email Delivery Service ("Welcome Letter Delivery"): handle 4xx (client error), 5xx (server error), timeouts, and connection refused
- HTTP errors from Google Workspace (Admin SDK Directory) ("Google Admin SDK Directory API"): handle 4xx (client error), 5xx (server error), timeouts, and connection refused

**Parent Container:** Cloud Run: lifecycle-worker (docker-container)

## Existing Implementation

| File | Kind | Language | Status |
|------|------|----------|--------|
| `services/worker/src/workspace/directoryClient.test.ts` | test-plan | --- | draft |
| `services/worker/package.json` | config | --- | draft |
| `services/worker/src/notify/templates.test.ts` | test-plan | --- | draft |
| `.nodespec/tests/req-008.tests.md` - Test plan for requirement: Workspace admin access without Domain-Wide Delegation | test-plan | markdown | draft |
| `.nodespec/tests/req-016.tests.md` - Test plan for requirement: Durable step execution, resumability and transition integrity | test-plan | markdown | draft |
| `services/worker/tsconfig.json` | config | --- | draft |
| `services/worker/src/notify/approvers.ts` | source | --- | draft |
| `services/worker/src/phases/notify.ts` | source | --- | draft |
| `services/worker/src/notify/sender.ts` | source | --- | draft |
| `services/worker/src/notify/notify.emulator.test.ts` | source | --- | draft |
| `services/worker/src/tasks/dispatcher.ts` | source | --- | draft |
| `.nodespec/tests/req-003.tests.md` - Test plan for requirement: Phase 1 — User creation with attributes and group assignment | test-plan | markdown | draft |
| `.nodespec/tests/req-019.tests.md` - Test plan for requirement: Credential generation and encryption at rest | test-plan | markdown | draft |
| `services/worker/src/phases/update.ts` | source | --- | draft |
| `services/worker/src/steps/advance.emulator.test.ts` | test-plan | --- | draft |
| `services/worker/src/auth/taskAuth.ts` | source | --- | draft |
| `services/worker/src/config.ts` | source | --- | draft |
| `services/worker/src/workspace/noAdminRoles.test.ts` | source | --- | draft |
| `.nodespec/tests/req-013.tests.md` - Test plan for requirement: Idempotent, retry-safe Workspace mutations | test-plan | markdown | draft |
| `services/worker/src/notify/singlePath.test.ts` | test-plan | --- | draft |
| `services/worker/src/steps/approvalExpiry.emulator.test.ts` | source | --- | draft |
| `services/worker/src/phases/createCollision.emulator.test.ts` | source | --- | draft |
| `services/worker/src/steps/handler.ts` | source | --- | draft |
| `services/worker/src/steps/duplicateDelivery.emulator.test.ts` | source | --- | draft |
| `services/worker/src/index.ts` | source | --- | draft |
| `services/worker/src/auth/taskAuth.test.ts` | test-plan | --- | draft |
| `services/worker/src/workspace/passwordReset.test.ts` | source | --- | draft |
| `services/worker/src/routes/tasks.ts` | source | --- | draft |
| `services/worker/src/phases/create.ts` | source | --- | draft |
| `services/worker/src/notify/resend.emulator.test.ts` | source | --- | draft |
| `services/worker/src/workspace/noDelegation.test.ts` | test-plan | --- | draft |
| `.nodespec/tests/req-005.tests.md` - Test plan for requirement: Phase 3 — Role and attribute updates over time | test-plan | markdown | draft |
| `services/worker/src/steps/advance.ts` | source | --- | draft |
| `services/worker/src/workspace/directoryClient.ts` | source | --- | draft |
| `services/worker/src/credentials/credentialStore.test.ts` | test-plan | --- | draft |
| `services/worker/src/steps/executor.emulator.test.ts` | test-plan | --- | draft |
| `services/worker/src/workspace/passwordPolicy.test.ts` | source | --- | draft |
| `services/worker/src/workspace/retry.test.ts` | test-plan | --- | draft |
| `services/worker/src/phases/credentialExposure.emulator.test.ts` | source | --- | draft |
| `services/worker/src/logging.ts` | source | --- | draft |
| `services/worker/src/notify/templates.ts` | source | --- | draft |
| `services/worker/src/steps/executor.ts` | source | --- | draft |
| `services/worker/src/phases/create.test.ts` | test-plan | --- | draft |
