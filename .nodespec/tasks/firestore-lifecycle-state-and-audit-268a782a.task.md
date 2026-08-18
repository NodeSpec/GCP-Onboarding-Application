# Task: Firestore: lifecycle state and audit

> **Scope:** implement ONLY this node ("Firestore: lifecycle state and audit"). Work belonging to other nodes appears here solely as interfaces and coordination points — do not implement or re-derive it.
> This document is DERIVED from the NodeSpec model + catalog (fingerprinted, regenerable via generate_task_docs). Node context/export is the model truth; propose model changes through the proposal flow — hand-edits to model facts here do not change the model.

## Component Purpose

**Role:** Database
**Technology:** Google Cloud Firestore
**Description:** Persistent data storage (relational or document)

## Your Deliverable

This service is provisioned, not programmed — no application code implements it (provider-managed, or operated by you if self-hosted).
- **Provisioning configuration (IaC)** — declare the service as config artifacts: existence, sizing, wiring, permissions. The IaC tool is NOT declared on this project's platform container — CONFIRM the tool with the user (Terraform / OpenTofu / Pulumi / provider-native / CDK) before authoring artifacts; do NOT assume one.
- **Connection contracts** for every interface below

## Implementation Context

<!-- AI-AUTHORED SECTION: NodeSpec never writes prose here. Your text survives regeneration verbatim while the derived sections around it keep refreshing. -->
_Not yet authored._ **Consuming AI — author this section BEFORE building.** Working from this full packet plus the repository, record the project-specific context no catalog can know: how this node's technology composes with its neighbors in THIS project, the integration specifics behind each interface contract, configuration rationale, and your intended implementation approach. Replace this placeholder (keep the heading) either by editing this file in the repo and pushing — NodeSpec surfaces the edit as a change card for the user to accept — or via an update_artifact patch through propose_patches. If a REVIEW-NEEDED line appears here later, the derived context changed after you wrote this: re-verify the section, then delete that line.

## Implementation Tasks

Ordered WORK ORDERS synthesized from the model — this node's deliverable kind, contracts, criterion attribution, configuration, and dependency chain. They guarantee coverage, scope, and traceability; they deliberately do NOT contain the implementation detail — that is your job (see the expansion directive below the list).

- [ ] **T1 — Provision Google Cloud Firestore via IaC.**
  Author the provisioning definition as config artifacts bound to this node — existence, wiring, permissions, deployed under Company GCP Project.
  [PLACEHOLDER: config — no user configuration recorded for this node; confirm sizing/domains/settings with the user]
- [ ] **T2 — Expose the interface Lifecycle Step Executor consumes, per Contract "Lifecycle State Store" (nosql).**
  Record the endpoint/identifiers Lifecycle Step Executor needs in this node's config artifacts — coordinate with Lifecycle Step Executor.
  Build to the contract schema EXACTLY (see Interface Contracts).
- [ ] **T3 — Expose the interface Lifecycle API Service consumes, per Contract "Lifecycle State Store" (nosql).**
  Record the endpoint/identifiers Lifecycle API Service needs in this node's config artifacts — coordinate with Lifecycle API Service.
  Build to the contract schema EXACTLY (see Interface Contracts).
- [ ] **T4 — Configure the service to satisfy: "A TTL policy is configured on the credentialHandoffs collection's expiresAt field, and an expired document is observably removed without application action" (REQ-020).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-020 "A TTL policy is configured on the credentialHandoffs collection's expiresAt field, and an expired document is observably removed without application action"
- [ ] **T5 — Configure the service to satisfy: "terraform plan reports no drift immediately after apply, confirming every index and policy is declared rather than console-created" (REQ-020).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-020 "terraform plan reports no drift immediately after apply, confirming every index and policy is declared rather than console-created"
- [ ] **T6 — Verify every acceptance criterion above and tick its box.**
  Ordering doctrine — plans follow schemas (contract-first TDD): schemas → test plans → implement → verify. Resolve any open [PLACEHOLDER: schema] gap FIRST (get_build_readiness supplies draftInputs; submit the schema via propose_patches update_contract) — test-plan scenarios touching a schemaless contract stay one-line [blocked by schema: …] markers until the schema lands, then the plan refreshes itself.
  AUTOMATED criteria: call get_test_plan for EACH requirement this node serves, implement the plan's test cases, run them, and report every outcome via report_test_results — a passing result flips the criterion's met flag automatically and the response receipt shows which criteria flipped.
  MANUAL criteria (rows marked (manual) above): report_test_results REFUSES to bind them — prove each by ticking its criterion box in this task doc and having the user approve the resulting change card; that approval is the only thing that flips a manual criterion met.
  This node is complete only when every criterion box is ticked and no `[PLACEHOLDER: …]` tag remains open.

**Your first action — expand these work orders.** Each task above guarantees WHAT must be covered, not HOW. Before writing any code or configuration, expand every task with the concrete implementation steps for THIS technology in THIS project — the specific resources, settings, files, schemas, and tests — using the Configuration, Interface Contracts, Technology Guidance, and node context as your references. Record the expanded list in this section via update_artifact (propose_patches) after this doc is accepted, keeping task IDs, criterion citations, and open `[PLACEHOLDER: …]` tags intact. Resolve placeholders with the user through the proposal flow; this node is never complete while one remains open. When the work orders are implemented, verify through the test lane: run get_test_plan for each requirement this node serves, implement and run the plan's tests, and report outcomes via report_test_results — passing results are the evidence that flips criteria met.

### Platform Capability Equivalence

This node is semantically equivalent to a "Google Cloud Firestore" (gcp-firestore) platform_capability node. Treat it as the managed GCP service for spec generation, code scaffolding, and architecture decisions.
- **Equivalent Role:** gcp-firestore (Google Cloud Firestore)
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

### REQ-020: Firestore database provisioning
Category: technical | Status: in-progress
Owned by the Firestore node. Provisions the Native-mode database that holds all lifecycle state: location, the composite indexes the query patterns require, the TTL policy on credential handoffs, and backup/point-in-time recovery. Application behaviour against these collections belongs to REQ-001, REQ-016 and REQ-010; this requirement covers only the resources that must exist for those to work. Note that no security rules are provisioned deliberately — every client is server-side and authenticates with Admin SDK credentials, which bypass rules entirely, so rules would be a false control (see REQ-010).

**Acceptance criteria — your task boxes:**
- [x] The database is provisioned in Native mode in the configured location, with the location recorded as a Terraform variable rather than hardcoded
  → THIS NODE: internal logic
- [x] Composite indexes exist for the documented query patterns: status+createdAt desc, targetUser+createdAt desc, phase+status, targetUser+status, and requestId+timestamp asc on audit events
  → THIS NODE: internal logic
- [ ] A TTL policy is configured on the credentialHandoffs collection's expiresAt field, and an expired document is observably removed without application action
  → covered by Task T4
- [x] Point-in-time recovery or scheduled backup is enabled, with the retention window set as a variable
  → THIS NODE: internal logic
- [ ] terraform plan reports no drift immediately after apply, confirming every index and policy is declared rather than console-created
  → covered by Task T5
- [x] No Firestore security rules file is deployed, and the absence is accompanied by the recorded rationale that server-side Admin SDK access bypasses rules
  → possible match: Contract "Lifecycle State Store" (nosql) from Lifecycle Step Executor (unverified — requirement not mapped to that node)

## Interface Contracts

### RECEIVES FROM: Lifecycle Step Executor (worker)
- **Contract:** Lifecycle State Store
- **Protocol:** nosql
- **Transport:** grpc
- **Their Technology:** nodejs

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

### RECEIVES FROM: Lifecycle API Service (backend-service)
- **Contract:** Lifecycle State Store
- **Protocol:** nosql
- **Transport:** grpc
- **Their Technology:** nodejs

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

## Technology Guidance

_Reference for executing the Implementation Tasks above — apply where relevant. The task list stands even where this guidance is thin._

**Purpose:** Serverless document database from Firebase/Google Cloud with real-time synchronization and offline support built in. Use when building mobile or web applications that need real-time data sync across clients, offline-first capabilities, or when you want zero server management with automatic scaling. Firestore excels at chat applications, collaborative tools, live dashboards, and any app where users see changes instantly without polling. It handles user-facing read-heavy workloads well with its hierarchical document/collection model. Don't use when you need complex relational queries with joins -- Firestore has no join support. Don't use for analytics or aggregation-heavy workloads. Avoid when your query patterns require composite inequality filters across many fields. Avoid for write-heavy workloads exceeding 10,000 writes/second per collection group without careful sharding. Consider Supabase/PostgreSQL if you need relational modeling with real-time features.

**SDK Initialization:**
```
// Web (JavaScript)
import { initializeApp } from "firebase/app";
import { getFirestore, collection, doc, getDocs } from "firebase/firestore";
const app = initializeApp({ projectId: "my-project", apiKey: "..." });
const db = getFirestore(app);
// [Tailor to project language: Python=firebase-admin, Flutter=cloud_firestore, iOS=FirebaseFirestore, Android=firebase-firestore-ktx]
```

**Common API Patterns:**

#### CRUD Operations
Basic document CRUD with typed references
```
import { doc, setDoc, getDoc, updateDoc, deleteDoc } from "firebase/firestore";
await setDoc(doc(db, "users", userId), { name, email, createdAt: new Date() });
const snap = await getDoc(doc(db, "users", userId));
if (snap.exists()) console.log(snap.data());
await updateDoc(doc(db, "users", userId), { name: newName });
await deleteDoc(doc(db, "users", userId));
```

#### Real-Time Listener
Real-time query listener with change type detection
```
import { collection, query, where, onSnapshot } from "firebase/firestore";
const q = query(collection(db, "messages"), where("roomId", "==", roomId));
const unsub = onSnapshot(q, (snapshot) => {
  snapshot.docChanges().forEach((change) => {
    if (change.type === "added") handleNewMessage(change.doc.data());
  });
});
// Call unsub() to detach listener
```

#### Batched Write
Atomic batch write for multiple document updates (max 500 per batch)
```
import { writeBatch, doc } from "firebase/firestore";
const batch = writeBatch(db);
for (const item of items) {
  batch.set(doc(db, "items", item.id), item);
}
await batch.commit();
```

**Configuration Template:**
```
// firestore.rules
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read: if request.auth != null && request.auth.uid == userId;
      allow create: if request.auth != null && request.auth.uid == userId;
      allow update: if request.auth != null && request.auth.uid == userId;
    }
    match /posts/{postId} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.uid == resource.data.authorId;
    }
  }
}
```

**Best Practices:**
- Structure data as flat collections rather than deeply nested subcollections
- Denormalize data to match your read patterns and reduce the number of reads
- Use composite indexes for queries with multiple filters or ordering
- Use batched writes for atomic multi-document operations
- Implement Firestore Security Rules as your primary access control layer
- Use collection group queries for querying across subcollections
- Cache frequently read documents on the client to reduce billing costs

**Anti-Patterns to Avoid:**
- Deeply nesting subcollections creating complex query limitations
- Not setting up Firestore Security Rules leaving data publicly accessible
- Storing arrays that need to be queried by index position
- Using Firestore for complex analytics that require SQL-like aggregation
- Reading entire collections when you only need a subset of documents
- Creating hot-spot document counters without distributed counters pattern

**Security:** Always deploy Firestore Security Rules -- the default open rules should never reach production. Validate data shape and field types in security rules using request.resource.data. Use Firebase App Check to prevent unauthorized API access from spoofed clients. Never trust client-provided timestamps -- use server timestamps (serverTimestamp()). Restrict Admin SDK usage to server-side code only.

**Integration Patterns:**
- Firebase Authentication for user identity integrated with security rules
- Cloud Functions for Firestore triggers (onCreate, onUpdate, onDelete)
- Firebase Hosting for deploying web apps with Firestore backend

**Suggested File Structure:**
- `firestore.rules` (config)
- `firestore.indexes.json` (config)

## Manual Steps

> The following steps require manual action by a human. AI cannot complete these steps automatically.

**Quick checklist:**
- [ ] Enable Firestore in Firebase Console *(required)*
- [ ] Configure Security Rules *(required)*
- [ ] Set Environment Variables *(required)*
- [ ] Create Indexes *(optional)*

### Required Steps

#### [dashboard_config] Enable Firestore in Firebase Console

In Firebase Console > Build > Firestore Database > Create Database. Choose production mode (locked by default) or test mode (open for 30 days). Select the closest region.

**Reference:** https://console.firebase.google.com/

#### [permissions] Configure Security Rules

In Firestore > Rules, write security rules that validate authentication and data access patterns. Rules use a match/allow syntax. Test rules in the Rules Playground.

#### [environment_variable] Set Environment Variables

Use your Firebase project configuration for client-side apps. For server-side, use a service account.

```bash
export FIREBASE_API_KEY=<from-project-settings>
export FIREBASE_PROJECT_ID=my-project
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

### Optional Steps

#### [dashboard_config] Create Indexes

Firestore automatically creates single-field indexes. For compound queries, create composite indexes in Firestore > Indexes, or let the SDK error message guide you to the auto-generation link.

## Dependency Chain

Startup/initialization order based on edge directions and interaction patterns.

**Depends on THIS node being available:**
- Lifecycle Step Executor (initiates Lifecycle State Store against this node (nosql))
- Lifecycle API Service (initiates Lifecycle State Store against this node (nosql))

**Parent Container:** Company GCP Project (gcp)

## Existing Implementation

| File | Kind | Language | Status |
|------|------|----------|--------|
| `firebase.json` | config | --- | draft |
