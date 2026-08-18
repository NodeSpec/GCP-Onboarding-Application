# Task: Google Workspace (Admin SDK Directory)

> **Scope:** implement ONLY this node ("Google Workspace (Admin SDK Directory)"). Work belonging to other nodes appears here solely as interfaces and coordination points — do not implement or re-derive it.
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
- [ ] **T2 — Expose the interface Lifecycle Step Executor consumes, per Contract "Google Admin SDK Directory API" (rest).**
  Record the endpoint/identifiers Lifecycle Step Executor needs in this node's config artifacts — coordinate with Lifecycle Step Executor.
  Build to the contract schema EXACTLY (see Interface Contracts).
  ↳ serves (unverified match): REQ-027 "A custom Workspace admin role exists carrying only: Users (create, read, update, delete), Groups (read and manage members), and Organizational Units (read) — no broader privilege is granted" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-027 "The custom admin role does NOT carry any role-management privilege, verified by reviewing the role's privilege list in the Admin console — so the service account cannot assign admin roles to itself or anyone else" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-027 "The custom role is assigned to the worker runtime service account by email under Account > Admin roles > Assign service accounts, and to no other principal" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-027 "Domain-Wide Delegation is NOT configured for this service account — the Security > API controls > Domain-wide delegation list contains no entry for its client id" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-027 "The exact console navigation path, privilege list and verification call are captured in docs/workspace-admin-setup.md so the setup is reproducible on a clean tenant" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T3 — Configure the service to satisfy: "A read-only users.list call from the worker's identity succeeds against the tenant, proving the grant is live before any mutating phase is exercised" (REQ-027).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-027 "A read-only users.list call from the worker's identity succeeds against the tenant, proving the grant is live before any mutating phase is exercised"
- [ ] **T4 — Verify every acceptance criterion above and tick its box.**
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

### REQ-027: Google Workspace tenant configuration for service-account admin access
Category: technical | Status: in-progress
Owned by the Google Workspace node. This is the tenant-side configuration that makes the customer's no-Domain-Wide-Delegation constraint work, performed in the Workspace Admin console rather than in Terraform — Workspace admin roles are not a GCP resource. A custom admin role is created carrying only the privileges the four phases need, and it is assigned directly to the worker's runtime service account by email under Account > Admin roles > Assign service accounts. The service account then authenticates as itself and receives admin authority without impersonating any human and without any delegation configuration. REQ-008 owns the application-side proof that no impersonation happens; this requirement owns the tenant configuration and its verification, and is almost entirely manual by nature.

The privilege list is a ceiling, not a starting point. It deliberately EXCLUDES role management: a service account able to assign admin roles could grant itself or any other principal Super Admin, which would defeat the least-privilege posture the customer chose when they ruled out Domain-Wide Delegation. That exclusion is why REQ-005 reads the customer's word "roles" as group membership rather than admin role — see the interpretation recorded there. If admin-role management is later wanted, adding it is a deliberate decision with a named escalation consequence, not a quiet privilege addition.

**Acceptance criteria — your task boxes:**
- [x] The Admin SDK API is enabled on the GCP project, declared in Terraform
  → possible match: Contract "Google Admin SDK Directory API" (rest) from Lifecycle Step Executor (unverified — requirement not mapped to that node)
- [ ] A custom Workspace admin role exists carrying only: Users (create, read, update, delete), Groups (read and manage members), and Organizational Units (read) — no broader privilege is granted (manual)
  → covered by Task T2
- [ ] The custom admin role does NOT carry any role-management privilege, verified by reviewing the role's privilege list in the Admin console — so the service account cannot assign admin roles to itself or anyone else (manual)
  → covered by Task T2
- [ ] The custom role is assigned to the worker runtime service account by email under Account > Admin roles > Assign service accounts, and to no other principal (manual)
  → covered by Task T2
- [ ] Domain-Wide Delegation is NOT configured for this service account — the Security > API controls > Domain-wide delegation list contains no entry for its client id (manual)
  → covered by Task T2
- [ ] A read-only users.list call from the worker's identity succeeds against the tenant, proving the grant is live before any mutating phase is exercised (manual)
  → covered by Task T3
- [ ] The exact console navigation path, privilege list and verification call are captured in docs/workspace-admin-setup.md so the setup is reproducible on a clean tenant (manual)
  → covered by Task T2

## Interface Contracts

### RECEIVES FROM: Lifecycle Step Executor (worker)
- **Contract:** Google Admin SDK Directory API
- **Protocol:** rest
- **Transport:** http
- **Spec Format:** openapi
- **Their Technology:** nodejs

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

## Dependency Chain

Startup/initialization order based on edge directions and interaction patterns.

**Depends on THIS node being available:**
- Lifecycle Step Executor (calls this node via Google Admin SDK Directory API (rest))

## Error Handling Contracts

**Errors this node MUST emit to consumers:**
- HTTP error responses to Lifecycle Step Executor ("Google Admin SDK Directory API"): return proper 4xx for validation errors, 401/403 for auth failures, 5xx for internal errors with correlation IDs
