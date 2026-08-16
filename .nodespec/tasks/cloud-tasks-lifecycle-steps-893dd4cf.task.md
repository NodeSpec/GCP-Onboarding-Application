# Task: Cloud Tasks: lifecycle-steps

> **Scope:** implement ONLY this node ("Cloud Tasks: lifecycle-steps"). Work belonging to other nodes appears here solely as interfaces and coordination points — do not implement or re-derive it.
> This document is DERIVED from the NodeSpec model + catalog (fingerprinted, regenerable via generate_task_docs). Node context/export is the model truth; propose model changes through the proposal flow — hand-edits to model facts here do not change the model.

## Component Purpose

**Role:** Message Queue
**Technology:** Google Cloud Tasks
**Description:** Point-to-point message queue for asynchronous task dispatch and work distribution

## Your Deliverable

This service is provisioned, not programmed — no application code implements it (provider-managed, or operated by you if self-hosted).
- **Provisioning configuration (IaC)** — declare the service as config artifacts: existence, sizing, wiring, permissions. The IaC tool is NOT declared on this project's platform container — CONFIRM the tool with the user (Terraform / OpenTofu / Pulumi / provider-native / CDK) before authoring artifacts; do NOT assume one.
- **Connection contracts** for every interface below

## Implementation Context

<!-- AI-AUTHORED SECTION: NodeSpec never writes prose here. Your text survives regeneration verbatim while the derived sections around it keep refreshing. -->
_Not yet authored._ **Consuming AI — author this section BEFORE building.** Working from this full packet plus the repository, record the project-specific context no catalog can know: how this node's technology composes with its neighbors in THIS project, the integration specifics behind each interface contract, configuration rationale, and your intended implementation approach. Replace this placeholder (keep the heading) either by editing this file in the repo and pushing — NodeSpec surfaces the edit as a change card for the user to accept — or via an update_artifact patch through propose_patches. If a REVIEW-NEEDED line appears here later, the derived context changed after you wrote this: re-verify the section, then delete that line.

## Implementation Tasks

Ordered WORK ORDERS synthesized from the model — this node's deliverable kind, contracts, criterion attribution, configuration, and dependency chain. They guarantee coverage, scope, and traceability; they deliberately do NOT contain the implementation detail — that is your job (see the expansion directive below the list).

- [ ] **T1 — Provision Google Cloud Tasks via IaC.**
  Author the provisioning definition as config artifacts bound to this node — existence, wiring, permissions, deployed under Company GCP Project.
  [PLACEHOLDER: config — no user configuration recorded for this node; confirm sizing/domains/settings with the user]
- [ ] **T2 — Declare the wiring to Lifecycle Step Executor (nodejs) per Contract "Step Execution Dispatch" (rest).**
  Build to the contract schema EXACTLY (see Interface Contracts).
  ↳ serves (unverified match): REQ-021 "The queue's rate limits (maxDispatchesPerSecond, maxConcurrentDispatches) are set below the Workspace Directory API quota so the queue cannot self-inflict 429s" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-021 "A dedicated queue invoker service account is provisioned and used as the queue's dispatch identity — the run.invoker binding on the worker service is asserted by REQ-026" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T3 — Expose the interface Lifecycle Step Executor consumes, per Contract "Step Task Enqueue" (rest).**
  Record the endpoint/identifiers Lifecycle Step Executor needs in this node's config artifacts — coordinate with Lifecycle Step Executor.
  Build to the contract schema EXACTLY (see Interface Contracts).
  ↳ serves (unverified match): REQ-021 "The lifecycle-steps queue is provisioned with maxAttempts, minBackoff, maxBackoff and maxDoublings set as declared variables rather than provider defaults" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-021 "Tasks are dispatched with an OIDC token whose audience is the worker service URL" — requirement not mapped to that node; verify or reassign before relying on it
  ↳ serves (unverified match): REQ-021 "Scheduling a task with a future scheduleTime defers dispatch to that time, verified end to end, since the offboarding hold period and approval expiry both depend on it" — requirement not mapped to that node; verify or reassign before relying on it
- [ ] **T4 — Expose the interface Lifecycle API Service consumes, per Contract "Step Task Enqueue" (rest).**
  Record the endpoint/identifiers Lifecycle API Service needs in this node's config artifacts — coordinate with Lifecycle API Service.
  Build to the contract schema EXACTLY (see Interface Contracts).
- [ ] **T5 — Configure the service to satisfy: "The queue name and worker target URL are wired from Terraform outputs rather than hardcoded in application configuration" (REQ-021).**
  No interface contract maps to this criterion — it is this node's internal responsibility.
  ↳ serves: REQ-021 "The queue name and worker target URL are wired from Terraform outputs rather than hardcoded in application configuration"
- [ ] **T6 — Verify every acceptance criterion above and tick its box.**
  Ordering doctrine — plans follow schemas (contract-first TDD): schemas → test plans → implement → verify. Resolve any open [PLACEHOLDER: schema] gap FIRST (get_build_readiness supplies draftInputs; submit the schema via propose_patches update_contract) — test-plan scenarios touching a schemaless contract stay one-line [blocked by schema: …] markers until the schema lands, then the plan refreshes itself.
  AUTOMATED criteria: call get_test_plan for EACH requirement this node serves, implement the plan's test cases, run them, and report every outcome via report_test_results — a passing result flips the criterion's met flag automatically and the response receipt shows which criteria flipped.
  MANUAL criteria (rows marked (manual) above): report_test_results REFUSES to bind them — prove each by ticking its criterion box in this task doc and having the user approve the resulting change card; that approval is the only thing that flips a manual criterion met.
  This node is complete only when every criterion box is ticked and no `[PLACEHOLDER: …]` tag remains open.

**Your first action — expand these work orders.** Each task above guarantees WHAT must be covered, not HOW. Before writing any code or configuration, expand every task with the concrete implementation steps for THIS technology in THIS project — the specific resources, settings, files, schemas, and tests — using the Configuration, Interface Contracts, Technology Guidance, and node context as your references. Record the expanded list in this section via update_artifact (propose_patches) after this doc is accepted, keeping task IDs, criterion citations, and open `[PLACEHOLDER: …]` tags intact. Resolve placeholders with the user through the proposal flow; this node is never complete while one remains open. When the work orders are implemented, verify through the test lane: run get_test_plan for each requirement this node serves, implement and run the plan's tests, and report outcomes via report_test_results — passing results are the evidence that flips criteria met.

### Platform Capability Equivalence

This node is semantically equivalent to a "Google Cloud Tasks" (gcp-cloud-tasks) platform_capability node. Treat it as the managed GCP service for spec generation, code scaffolding, and architecture decisions.
- **Equivalent Role:** gcp-cloud-tasks (Google Cloud Tasks)
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

### REQ-021: Cloud Tasks queue provisioning
Category: technical | Status: in-progress
Owned by the Cloud Tasks node. Provisions the lifecycle-steps queue that gives the state machine its durability: retry configuration, rate limits, and the OIDC identity used to authenticate dispatches to the worker. The queue's retry budget is what REQ-016 relies on for resumability, and its scheduled-task capability is what carries both the offboarding hold period (REQ-006) and approval expiry (REQ-002) — so those settings are load-bearing, not cosmetic defaults.

**Acceptance criteria — your task boxes:**
- [ ] The lifecycle-steps queue is provisioned with maxAttempts, minBackoff, maxBackoff and maxDoublings set as declared variables rather than provider defaults
  → covered by Task T3
- [ ] The queue's rate limits (maxDispatchesPerSecond, maxConcurrentDispatches) are set below the Workspace Directory API quota so the queue cannot self-inflict 429s
  → covered by Task T2
- [ ] A dedicated queue invoker service account is provisioned and used as the queue's dispatch identity — the run.invoker binding on the worker service is asserted by REQ-026
  → covered by Task T2
- [ ] Tasks are dispatched with an OIDC token whose audience is the worker service URL
  → covered by Task T3
- [ ] Scheduling a task with a future scheduleTime defers dispatch to that time, verified end to end, since the offboarding hold period and approval expiry both depend on it
  → covered by Task T3
- [ ] The queue name and worker target URL are wired from Terraform outputs rather than hardcoded in application configuration
  → covered by Task T5

## Interface Contracts

### RECEIVES FROM: Lifecycle Step Executor (worker)
- **Contract:** Step Task Enqueue
- **Protocol:** rest
- **Transport:** http
- **Their Technology:** nodejs

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

### SENDS TO: Lifecycle Step Executor (worker)
- **Contract:** Step Execution Dispatch
- **Protocol:** rest
- **Transport:** http
- **Spec Format:** openapi
- **Their Technology:** nodejs

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

### RECEIVES FROM: Lifecycle API Service (backend-service)
- **Contract:** Step Task Enqueue
- **Protocol:** rest
- **Transport:** http
- **Their Technology:** nodejs

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

## Technology Guidance

_Reference for executing the Implementation Tasks above — apply where relevant. The task list stands even where this guidance is thin._

**Purpose:** Cloud Tasks is Google Cloud's fully managed task queue for dispatching asynchronous work to HTTP targets or App Engine handlers with controlled retry and rate behavior. Use it for background processing, deferred execution, request offloading, and reliable task delivery where a single worker endpoint should execute each queued job. Choose Cloud Tasks over Pub/Sub when you need per-task execution control, rate limits, scheduling, and HTTP-oriented worker dispatch rather than multi-subscriber event fan-out. Do not use it for high-throughput streaming analytics, broad publish-subscribe distribution, or complex multi-step workflow orchestration.

**SDK Initialization:**
```
import { CloudTasksClient } from '@google-cloud/tasks';

const tasks = new CloudTasksClient();
await tasks.createTask({
  parent: tasks.queuePath(project, 'us-central1', 'emails'),
  task: { httpRequest: { httpMethod: 'POST', url: workerUrl,
    oidcToken: { serviceAccountEmail: invokerSa }, body: Buffer.from(payload) } },
});
```

**Best Practices:**
- Create separate queues by workload type, latency class, or ownership boundary
- Tune retry configuration, dispatch rate, and max concurrent dispatches to match worker capacity
- Design task handlers to be idempotent because retries and duplicate execution are possible
- Use explicit schedule times for deferred work instead of building custom sleep or polling logic
- Pass lightweight payloads and fetch large data from durable storage or databases inside the worker
- Secure target handlers with authenticated requests and least-privilege service identities
- Monitor queue depth, dispatch latency, retry counts, and handler failure rates continuously

**Anti-Patterns to Avoid:**
- Using Cloud Tasks as a general-purpose event bus with many independent subscribers
- Treating Cloud Tasks as a long-running workflow engine with complex orchestration state
- Sending oversized payloads directly in tasks instead of referencing external data
- Assuming a task executes exactly once without idempotent worker behavior
- Using one global queue for unrelated workloads with conflicting rate and retry needs
- Calling worker endpoints synchronously from user requests and waiting for task completion interactively

**Security:** HTTP targets must be authenticated: attach an OIDC token to tasks and verify audience at the worker — an open worker URL is an open job-execution endpoint. Scope enqueue rights per queue, keep payloads reference-not-secret, and set retry + rate limits so a poison task cannot hammer the target.

**Suggested File Structure:**
- `src/tasks/enqueue.ts` (source)
- `src/tasks/worker-handler.ts` (source)
- `infra/cloud-tasks.yaml` (config)

## Dependency Chain

Startup/initialization order based on edge directions and interaction patterns.

**Must be available BEFORE this node starts:**
- Lifecycle Step Executor (this node calls/depends on it via Step Execution Dispatch (rest))

**Depends on THIS node being available:**
- Lifecycle Step Executor (calls this node via Step Task Enqueue (rest))
- Lifecycle API Service (calls this node via Step Task Enqueue (rest))

## Error Handling Contracts

**Errors this node MUST emit to consumers:**
- HTTP error responses to Lifecycle Step Executor ("Step Task Enqueue"): return proper 4xx for validation errors, 401/403 for auth failures, 5xx for internal errors with correlation IDs
- HTTP error responses to Lifecycle API Service ("Step Task Enqueue"): return proper 4xx for validation errors, 401/403 for auth failures, 5xx for internal errors with correlation IDs

**Errors this node MUST handle from dependencies:**
- HTTP errors from Lifecycle Step Executor ("Step Execution Dispatch"): handle 4xx (client error), 5xx (server error), timeouts, and connection refused

**Parent Container:** Company GCP Project (gcp)
