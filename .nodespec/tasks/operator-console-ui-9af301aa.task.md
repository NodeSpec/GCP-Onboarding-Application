# Task: Operator Console UI

> **Scope:** implement ONLY this node ("Operator Console UI"). Work belonging to other nodes appears here solely as interfaces and coordination points — do not implement or re-derive it.
> This document is DERIVED from the NodeSpec model + catalog (fingerprinted, regenerable via generate_task_docs). Node context/export is the model truth; propose model changes through the proposal flow — hand-edits to model facts here do not change the model.

## Component Purpose

**Role:** Frontend Application
**Technology:** React
**Description:** Client-side web application or SPA

## Your Deliverable

**Working code for this component**, honoring the contracts and criteria below, plus its configuration artifacts and tests.

## Implementation Context

<!-- AI-AUTHORED SECTION: NodeSpec never writes prose here. Your text survives regeneration verbatim while the derived sections around it keep refreshing. -->
_Not yet authored._ **Consuming AI — author this section BEFORE building.** Working from this full packet plus the repository, record the project-specific context no catalog can know: how this node's technology composes with its neighbors in THIS project, the integration specifics behind each interface contract, configuration rationale, and your intended implementation approach. Replace this placeholder (keep the heading) either by editing this file in the repo and pushing — NodeSpec surfaces the edit as a change card for the user to accept — or via an update_artifact patch through propose_patches. If a REVIEW-NEEDED line appears here later, the derived context changed after you wrote this: re-verify the section, then delete that line.

## Implementation Tasks

Ordered WORK ORDERS synthesized from the model — this node's deliverable kind, contracts, criterion attribution, configuration, and dependency chain. They guarantee coverage, scope, and traceability; they deliberately do NOT contain the implementation detail — that is your job (see the expansion directive below the list).

- [ ] **T1 — Scaffold the React component.**
  Create the source layout, build files, and test harness this node's working code lives in.
  Start from the catalog's suggested structure: `src/App.tsx`, `src/main.tsx`, `vite.config.ts`, `tsconfig.json`.
- [ ] **T2 — Implement the integration with Lifecycle API Service (nodejs) per Contract "Lifecycle Operator API" (rest).**
  Build to the contract schema EXACTLY (see Interface Contracts).
- [ ] **T3 — Verify every acceptance criterion above and tick its box.**
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

### REQ-011: Operator console for submitting, tracking, and approving requests
Category: functional | Status: in-progress
A single-page operator console, served behind IAP by the same Cloud Run service that hosts the API, is the human surface for all four phases. It provides: guided forms for each phase (create, notify, update, delete) driven by the same schemas the API validates against; a request list filterable by phase, status, and target user; a request detail view showing the step timeline with per-step status, attempts, timestamps, and errors; an approvals inbox showing only requests the signed-in operator is eligible to approve, with the rendered diff and approve/reject controls requiring a justification; and a resume/cancel control for failed or held requests. The console derives the signed-in identity and available actions from the server's verified IAP identity — it never asserts identity itself, and hiding a control in the UI is never the only enforcement of a permission.

**Acceptance criteria — your task boxes:**
- [x] Each phase has a form whose validation is generated from the same schema the API enforces, so client and server reject the same payloads
  → possible match: Contract "Lifecycle Operator API" (rest) to Lifecycle API Service (unverified — requirement not mapped to that node)
- [x] The target user is chosen through a search picker backed by directory lookup rather than typed free-hand, and the update form pre-fills from the selected user's current attributes and memberships
  → THIS NODE: internal logic
- [x] Groups and org unit are chosen from pickers listing what actually exists in the domain, so an invalid group or org unit cannot be submitted
  → THIS NODE: internal logic
- [x] The request list filters by phase, status, and target user and paginates without loading the full collection
  → THIS NODE: internal logic
- [x] The request detail view renders the ordered step timeline with each step's status, attempt count, timestamps, and error text
  → THIS NODE: internal logic
- [x] The approvals inbox shows only requests the signed-in operator is eligible to approve, and never shows their own requests
  → possible match: Contract "Lifecycle Operator API" (rest) to Lifecycle API Service (unverified — requirement not mapped to that node)
- [x] The approve and reject controls require a justification before submitting, and surface the server's 400 when one is missing rather than assuming the client check was sufficient
  → THIS NODE: internal logic
- [x] The console reads the signed-in identity from a server endpoint backed by the verified IAP assertion, not from any client-held token or claim
  → THIS NODE: internal logic
- [x] The console renders the computed diff for an update request showing before/after per changed attribute and per group change, so an approver sees what will change rather than a raw payload
  → THIS NODE: internal logic
- [x] A completed onboarding offers a resend action that lets the operator correct the notification address and choose whether to regenerate the credential, surfacing the CredentialUnavailable case rather than failing opaquely
  → possible match: Contract "Lifecycle Operator API" (rest) to Lifecycle API Service (unverified — requirement not mapped to that node)
- [x] A control the signed-in operator is not authorized to use is not rendered — but the console never relies on that as enforcement, which is proven server-side by REQ-012
  → possible match: Contract "Lifecycle Operator API" (rest) to Lifecycle API Service (unverified — requirement not mapped to that node)

## Interface Contracts

### SENDS TO: Lifecycle API Service (backend-service)
- **Contract:** Lifecycle Operator API
- **Protocol:** rest
- **Transport:** http
- **Spec Format:** openapi
- **Their Technology:** nodejs

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

## Technology Guidance

_Reference for executing the Implementation Tasks above — apply where relevant. The task list stands even where this guidance is thin._

**Purpose:** Component-based UI library for building interactive single-page applications

**SDK Initialization:**
```
npm create vite@latest my-app -- --template react-ts && cd my-app && npm install
// src/App.tsx
export default function App() {
  return <div>Hello React</div>;
}
```

**Common API Patterns:**

#### Component with State
Functional component with useState hook
```
function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button onClick={() => setCount(c => c + 1)}>
      Count: {count}
    </button>
  );
}
```

#### Data Fetching
Custom hook for data fetching with loading state
```
function useUsers() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch("/api/users").then(r => r.json()).then(setUsers).finally(() => setLoading(false));
  }, []);
  return { users, loading };
}
```

#### Context Provider
Context API for global state with typed custom hook
```
const AuthContext = createContext<AuthState | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  return (
    <AuthContext.Provider value={{ user, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}
export const useAuth = () => useContext(AuthContext)!;
```

**Configuration Template:**
```
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { port: 3000 },
  build: { sourcemap: true }
});

// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "jsx": "react-jsx",
    "strict": true,
    "moduleResolution": "bundler"
  }
}
```

**Best Practices:**
- Use functional components with hooks
- Implement proper state management (lift state up, use context sparingly)
- Memoize expensive computations with useMemo/useCallback
- Use React.lazy for code splitting
- Follow the single responsibility principle per component
- Use TypeScript for type safety
- Implement error boundaries
- Use Suspense for async data loading

**Anti-Patterns to Avoid:**
- Prop drilling through many levels instead of using Context or state management
- Using useEffect for derived state that should be computed during render
- Creating new object/function references in render causing unnecessary re-renders
- Using index as key in lists with dynamic ordering or mutations
- Putting business logic directly in components instead of custom hooks

**Security:** React auto-escapes JSX output preventing most XSS. Never use dangerouslySetInnerHTML with unsanitized input. Validate and sanitize URL-based props (href, src) to prevent javascript: injection. Use Content Security Policy headers. Avoid storing sensitive tokens in localStorage -- use httpOnly cookies. Sanitize user input before passing to third-party libraries that manipulate DOM directly.

**Integration Patterns:**
- React Router for client-side routing with lazy-loaded routes
- TanStack Query (React Query) for server state management and caching
- Zustand or Jotai for lightweight client state management
- Tailwind CSS or CSS Modules for scoped styling
- Vitest + React Testing Library for component testing

**Suggested File Structure:**
- `src/App.tsx` (source)
- `src/main.tsx` (source)
- `vite.config.ts` (config)
- `tsconfig.json` (config)

## Dependency Chain

Startup/initialization order based on edge directions and interaction patterns.

**Must be available BEFORE this node starts:**
- Lifecycle API Service (this node calls/depends on it via Lifecycle Operator API (rest))

## Error Handling Contracts

**Errors this node MUST handle from dependencies:**
- HTTP errors from Lifecycle API Service ("Lifecycle Operator API"): handle 4xx (client error), 5xx (server error), timeouts, and connection refused

**Parent Container:** Cloud Run: lifecycle-api (docker-container)

## Existing Implementation

| File | Kind | Language | Status |
|------|------|----------|--------|
| `services/console/src/RequestList.tsx` | source | --- | draft |
| `services/console/src/main.tsx` | source | --- | draft |
| `services/console/src/pickers.tsx` | source | --- | draft |
| `services/console/tsconfig.json` | config | --- | draft |
| `services/console/src/RequestDetail.tsx` | source | --- | draft |
| `services/console/src/api.ts` | source | --- | draft |
| `services/console/src/Approvals.tsx` | source | --- | draft |
| `services/console/src/App.tsx` | source | --- | draft |
| `services/console/package.json` | config | --- | draft |
| `services/console/vite.config.ts` | config | --- | draft |
| `services/console/src/identity.tsx` | source | --- | draft |
| `services/console/index.html` | source | --- | draft |
| `services/console/src/RequestForm.tsx` | source | --- | draft |
